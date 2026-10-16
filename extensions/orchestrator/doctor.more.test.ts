import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The global config and cache paths are fixed at import; keep them off the developer's own.
const agentDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pp-doctor-more-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

import { getDefaultConfig, GLOBAL_CONFIG_PATH, normalizeConfigDurations } from "./config.js";
import { runDoctor } from "./doctor.js";
import { configureRouting, setCatalog } from "./routing.js";

const RESULTS_KEY = Symbol.for("pi-pi:provision-results");
const ENV_KEYS = ["LLM_API_KEY", "FLANT_API_KEY", "COPILOT_GITHUB_TOKEN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let cwd: string;

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const key of ENV_KEYS) delete process.env[key];
  cwd = mkdtempSync(join(tmpdir(), "pp-doctor-more-cwd-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(cwd, { recursive: true, force: true });
  for (const name of ["settings.json", "auth.json", "extensions"]) rmSync(join(agentDir, name), { recursive: true, force: true });
  (globalThis as any)[RESULTS_KEY]?.clear?.();
  setCatalog([]);
  configureRouting(getDefaultConfig());
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function config(mutate?: (config: ReturnType<typeof getDefaultConfig>) => void) {
  const raw = getDefaultConfig();
  mutate?.(raw);
  return normalizeConfigDurations(raw);
}

async function report(orchestrator: Record<string, any> = {}, ctx: Record<string, any> = {}, options = { probes: false, probeServers: false }) {
  let text = "";
  let level = "";
  await runDoctor(
    { cwd, config: config(), lsp: null, ...orchestrator } as any,
    { ...ctx, ui: { notify: (message: string, severity: string) => { text = message; level = severity; } } },
    options,
  );
  return { text, level };
}

function writeGlobal(value: unknown): void {
  mkdirSync(join(agentDir, "extensions", "pp"), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, typeof value === "string" ? value : JSON.stringify(value));
}

describe("config section", () => {
  it("passes with no config files at all", async () => {
    const { text } = await report();
    expect(text).toContain("✓ global config: none (defaults apply)");
    expect(text).toContain("✓ project config: none (defaults apply)");
    expect(text).toContain("✓ Global and project config merge cleanly");
  });

  it("names an unparseable config, and survives the merge throwing", async () => {
    mkdirSync(join(cwd, ".pp"));
    writeFileSync(join(cwd, ".pp", "config.json"), "{ nope");
    const { text, level } = await report();
    expect(text).toMatch(/✗ project config is unreadable \(.*config\.json\): Failed to parse/);
    expect(text).toMatch(/✗ Config check failed: Failed to parse/);
    // The remaining sections still run.
    expect(text).toContain("Summary:");
    expect(level).toBe("error");
  });

  it("reports a config that parses but does not validate", async () => {
    writeGlobal({ lsp: { servers: { zls: { command: [] } } } });
    const { text } = await report();
    expect(text).toContain("✓ global config parses");
    expect(text).toContain("✗ Config check failed: config.lsp.servers.zls.command must not be empty");
  });

  it("surfaces startup errors recorded by the session", async () => {
    const { text } = await report({ configError: "bad config", duplicateExtensionError: true });
    expect(text).toContain("✗ Startup config error: bad config");
    expect(text).toContain("✗ Duplicate extension copies detected");
  });
});

describe("models section", () => {
  it("warns when no pool member is from another vendor than main, and counts disabled pool entries", async () => {
    const models = [
      { provider: "openai-codex", id: "gpt-6-luna" },
      { provider: "openai-codex", id: "gpt-6-astra" },
    ];
    setCatalog(models.map((m) => `${m.provider}/${m.id}`));
    const cfg = config((c) => {
      c.agents.main.model = "gpt/astra";
      for (const pool of ["advisors", "reviewers", "deepDebuggers"] as const) {
        c.agents.subagents.pools[pool] = [{ enabled: true, model: "gpt/astra", thinking: "high" }, { enabled: false, model: "claude/fable", thinking: "high" }];
      }
    });
    const { text } = await report({ config: cfg }, { modelRegistry: { getAvailable: () => [...models, { provider: 1 }] } });
    expect(text).toContain("pools.advisors: 1 of 2 enabled");
    expect(text).toContain("⚠ No pool member is confirmed to come from a different vendor than the main model (openai)");
  });

  it("checks an override against what the provider serves and what the models can do", async () => {
    setCatalog(["acme/big", "acme/small"]);
    const cfg = config((c) => {
      c.models.claude.override = { provider: "acme", model: "big", slots: { haiku: "small", sonnet: "missing" } } as any;
      c.models.gpt.override = { provider: "ghost", model: "x" } as any;
    });
    configureRouting(cfg);
    const find = (_provider: string, id: string) => (id === "big" ? { input: ["text"], reasoning: false } : { input: ["text", "image"], reasoning: true });
    const { text } = await report({ config: cfg }, { modelRegistry: { getAvailable: () => [{ provider: "acme", id: "big" }, { provider: "acme", id: "small" }], find } });
    expect(text).toContain("✗ Claude override: acme does not serve missing");
    expect(text).toContain("✗ GPT override: no credentials for ghost (set its API key or /login)");
    expect(text).toContain("⚠ acme/big does not accept images; screenshots will be dropped");
    expect(text).toContain("⚠ acme/big has no thinking; thinking levels are clamped to off");
    expect(text).not.toContain("acme/small does not accept images");
  });

  it("passes an override every slot of which is served", async () => {
    setCatalog(["acme/big"]);
    const cfg = config((c) => { c.models.claude.override = { provider: "acme", model: "big" } as any; });
    configureRouting(cfg);
    const { text } = await report({ config: cfg }, { modelRegistry: { getAvailable: () => [{ provider: "acme", id: "big" }] } });
    expect(text).toContain("✓ Claude overridden by acme");
  });
});

describe("foreign pi-pi copies", () => {
  it("ignores unreadable settings and settings without a package list", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ broken");
    expect((await report()).text).not.toContain("another pi-pi copy");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: "not-a-list" }));
    expect((await report()).text).not.toContain("another pi-pi copy");
  });
});

describe("provisioning section", () => {
  it("reports present, unavailable and failed tools with their reasons", async () => {
    const results = (globalThis as any)[RESULTS_KEY] ?? new Map();
    (globalThis as any)[RESULTS_KEY] = results;
    results.set("rg", { status: "present", binary: "rg", path: "/usr/bin/rg" });
    results.set("gopls", { status: "unavailable", binary: "gopls", reason: "go is not on PATH" });
    results.set("pyright-langserver", { status: "failed", binary: "pyright-langserver", reason: "E404" });
    const { text } = await report();
    expect(text).toContain("✓ rg: already on PATH (/usr/bin/rg)");
    expect(text).toContain("⚠ gopls: unavailable — go is not on PATH");
    expect(text).toContain("✗ pyright-langserver: install failed — E404");
    expect(text).not.toContain("Nothing provisioned yet");
  });
});

describe("LSP section", () => {
  it("lists running and probed servers and the diagnostics setting", async () => {
    const lsp = {
      describe: vi.fn(async () => ({
        servers: [
          { name: "ts", command: "tsserver", resolvedPath: "/bin/tsserver", extensions: [".ts"], running: true, probe: "skipped", stderr: [] },
          { name: "go", command: "gopls", resolvedPath: null, extensions: [".go"], running: false, probe: "ok", stderr: [] },
          { name: "sh", command: "bls", resolvedPath: undefined, extensions: [".sh"], running: false, probe: "skipped", stderr: [] },
          { name: "rs", command: "ra", extensions: [".rs"], running: false, probe: "failed", stderr: [] },
        ],
        missing: [],
        errors: [],
        untrusted: [],
      })),
    };
    const { text } = await report({ lsp, config: config((c) => { c.lsp.diagnosticsAfterEdit = false; }) }, {}, { probes: false, probeServers: true });
    expect(lsp.describe).toHaveBeenCalledWith(true);
    expect(text).toContain("✓ ts: running — handles .ts");
    expect(text).toContain("✓ go: starts — handles .go");
    expect(text).toContain("✓ sh: installed — handles .sh");
    expect(text).toContain("path: unknown");
    expect(text).toContain("✗ rs: ra resolves but does not run");
    expect(text).toContain("✓ Diagnostics after edits: off");
  });

  it("warns when nothing is detected and turns a throwing describe into a failure", async () => {
    let result = await report({ lsp: { describe: async () => ({ servers: [], missing: [], errors: [], untrusted: [] }) } });
    expect(result.text).toContain("⚠ No language server detected for this machine");
    result = await report({ lsp: { describe: async () => { throw "boom"; } } });
    expect(result.text).toContain("✗ LSP check failed: boom");
  });
});

describe("commands section", () => {
  it("checks the binary each afterEdit command would run", async () => {
    writeFileSync(join(cwd, "fmt.sh"), "");
    const cfg = config((c) => {
      c.commands.afterEdit = {
        off: { run: "whatever", enabled: false },
        envOnly: { run: "FOO=1 BAR=2" },
        envPrefixed: { run: "FOO=1 sh -c true" },
        relative: { run: "./fmt.sh --check" },
        absentRelative: { run: "./missing.sh" },
        absolute: { run: "/definitely/not/here" },
        unknown: { run: "pp-no-such-binary-xyz" },
      };
    });
    const { text } = await report({ config: cfg });
    expect(text).toContain("✓ afterEdit.off: disabled");
    expect(text).toContain("✗ afterEdit.envOnly: no binary in \"FOO=1 BAR=2\"");
    expect(text).toMatch(/✓ afterEdit\.envPrefixed: sh found at \/.*sh/);
    expect(text).toContain("✓ afterEdit.relative: ./fmt.sh found at ./fmt.sh");
    expect(text).toContain("✗ afterEdit.absentRelative: ./missing.sh not found");
    expect(text).toContain("✗ afterEdit.absolute: /definitely/not/here not found");
    expect(text).toContain("✗ afterEdit.unknown: pp-no-such-binary-xyz not found");
  });
});

describe("providers section", () => {
  it("reports logged-out providers, a missing key and a never-updated model list", async () => {
    const { text } = await report();
    expect(text).toContain("⚠ Claude subscription enabled but not logged in");
    expect(text).toContain("⚠ ChatGPT subscription enabled but not logged in");
    expect(text).toContain("⚠ Copilot enabled but credentials are missing");
    expect(text).toContain("⚠ LLM API enabled but no key");
    expect(text).toContain("⚠ LLM API model list last updated: never");
    expect(text).toMatch(/✓ Cache directory writable: .*extensions\/pp\/cache/);
  });

  it("reports logged-in providers and a present key", async () => {
    process.env.LLM_API_KEY = "k";
    process.env.COPILOT_GITHUB_TOKEN = "t";
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      anthropic: { access: "a", expires: Date.now() + 3_600_000 },
      "openai-codex": { access: "c", expires: Date.now() + 3_600_000 },
    }));
    const { text } = await report();
    expect(text).toContain("✓ Claude subscription logged in (routes: llm-api, then direct)");
    expect(text).toContain("✓ ChatGPT subscription logged in");
    expect(text).toContain("✓ Copilot credentials present");
    expect(text).toContain("✓ LLM API key present");
  });

  it("fails a subscription routed only through the gateway without a gateway key", async () => {
    writeGlobal({ schema: 2, providers: { "claude-sub": { route: ["llm-api"] }, "llm-api": { enabled: false } } });
    const { text } = await report();
    expect(text).toContain("✗ Claude subscription routes only via LLM API, but LLM_API_KEY is not set");
    expect(text).toContain("✓ LLM API disabled");
  });

  it("says the subscription is unused while the Claude family is overridden", async () => {
    writeGlobal({ schema: 2, models: { claude: { override: { provider: "acme", model: "big" } } } });
    const { text } = await report();
    expect(text).toContain("✓ Claude subscription unused: the Claude family is overridden");
  });

  it("fails an unwritable cache directory", async () => {
    mkdirSync(join(agentDir, "extensions", "pp"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "pp", "cache"), "a file where the dir should be");
    const { text } = await report();
    expect(text).toMatch(/✗ Cache directory is not writable: /);
  });
});

describe("connectivity section", () => {
  it("times every endpoint, the gateway only with a key, and reports each outcome", async () => {
    process.env.LLM_API_KEY = "secret";
    const fetch = vi.fn(async (url: string, init: any) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.includes("npmjs")) return new Response("", { status: 503 });
      if (url.includes("exa")) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const { text } = await report({}, {}, { probes: true, probeServers: false });
    expect(fetch).toHaveBeenCalledTimes(4);
    const gateway = fetch.mock.calls.find(([url]) => url.includes("llm-api.flant.ru"))!;
    expect(gateway[1].headers.Authorization).toBe("Bearer secret");
    expect(text).toMatch(/✓ GitHub releases: reachable \(\d+ms\)/);
    expect(text).toMatch(/✗ npm registry: HTTP 503 \(\d+ms\)/);
    expect(text).toContain("✗ Exa MCP: unreachable — ECONNREFUSED");
    expect(text).toMatch(/✓ Flant gateway: reachable/);
  });

  it("does not probe the gateway without a key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await report({}, {}, { probes: true, probeServers: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("environment section", () => {
  it("reports branch and uncommitted changes of a git working directory", async () => {
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd });
    writeFileSync(join(cwd, "a.txt"), "a");
    writeFileSync(join(cwd, "b.txt"), "b");
    const { text } = await report();
    expect(text).toContain("✓ Working directory is a git repository");
    expect(text).toMatch(/✓ Branch .*trunk.*, 2 uncommitted change\(s\)/);
  });

  it("warns outside a git repository and about pi's default retry budget", async () => {
    const { text } = await report();
    expect(text).toContain("⚠ Working directory is a git repository");
    expect(text).toContain("⚠ Provider retries: pi's default, backoff ceiling pi's default");
  });

  it("passes a raised retry budget from pi's settings", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { provider: { maxRetries: 8, maxRetryDelayMs: 60000 } } }));
    expect((await report()).text).toContain("✓ Provider retries: 8, backoff ceiling 60000");
  });
});
