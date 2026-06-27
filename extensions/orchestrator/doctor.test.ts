import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readRawConfig: vi.fn(),
  mergeConfigLayers: vi.fn(),
  resolvePreset: vi.fn(),
  resolveModel: vi.fn(),
  getAllAliases: vi.fn(),
  loadFlantSettings: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("./config.js", () => ({
  GLOBAL_CONFIG_PATH: "/mock/global-config.json",
  PRESET_GROUPS: ["planners", "codeReviewers", "planReviewers", "brainstormReviewers"],
  readRawConfig: mocks.readRawConfig,
  mergeConfigLayers: mocks.mergeConfigLayers,
  resolvePreset: mocks.resolvePreset,
}));

vi.mock("./model-registry.js", () => ({
  resolveModel: mocks.resolveModel,
  getAllAliases: mocks.getAllAliases,
}));

vi.mock("./flant-infra.js", () => ({
  loadFlantSettings: mocks.loadFlantSettings,
}));

import { runDoctor } from "./doctor.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createConfig() {
  return {
    general: {
      autoCommit: true,
      loadExtraRepoConfigs: true,
      logLevel: "info",
    },
    agents: {
      orchestrators: {
        implement: { model: "anthropic/claude-opus-latest", thinking: "high" },
        plan: { model: "anthropic/claude-opus-latest", thinking: "high" },
        debug: { model: "openai/gpt-latest", thinking: "high" },
        brainstorm: { model: "anthropic/claude-opus-latest", thinking: "high" },
        review: { model: "anthropic/claude-opus-latest", thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: "google/gemini-flash-latest", thinking: "low" },
          librarian: { model: "google/gemini-flash-latest", thinking: "medium" },
          task: { model: "openai/gpt-latest", thinking: "medium" },
        },
        presetGroups: {
          planners: {
            default: "regular",
            presets: {
              regular: {
                enabled: true,
                agents: {
                  opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                  gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                },
              },
            },
          },
          codeReviewers: {
            default: "regular",
            presets: {
              regular: {
                enabled: true,
                agents: {
                  gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "high" },
                },
              },
            },
          },
          planReviewers: {
            default: "regular",
            presets: {
              regular: {
                enabled: true,
                agents: {
                  opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                },
              },
            },
          },
          brainstormReviewers: {
            default: "regular",
            presets: {
              regular: {
                enabled: true,
                agents: {
                  gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                },
              },
            },
          },
        },
      },
    },
    commands: {
      afterEdit: {
        lint: { run: "node ./scripts/lint.js", globs: ["**/*.ts"] },
      },
      afterImplement: {
        test: { run: "npm test" },
      },
    },
    performance: {
      commands: {
        afterEdit: 30000,
        afterImplement: 300000,
      },
      internals: {
        subagentStale: 300000,
        taskLockStale: 60000,
        taskLockRefresh: 30000,
      },
    },
  };
}

function createCtx() {
  return {
    ui: {
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai", id: "gpt-5.4" },
        { provider: "google", id: "gemini-3.1-flash" },
        { provider: "google", id: "gemini-3.1-pro" },
      ]),
    },
  };
}

beforeEach(() => {
  const aliasMap: Record<string, string> = {
    "anthropic/claude-opus-latest": "anthropic/claude-opus-4-6",
    "openai/gpt-latest": "openai/gpt-5.4",
    "google/gemini-flash-latest": "google/gemini-3.1-flash",
    "google/gemini-pro-latest": "google/gemini-3.1-pro",
  };

  mocks.resolveModel.mockImplementation((value: string) => aliasMap[value] ?? value);
  mocks.getAllAliases.mockReturnValue({ ...aliasMap });
  mocks.mergeConfigLayers.mockReturnValue(createConfig());
  mocks.readRawConfig.mockImplementation(() => ({}));
  mocks.resolvePreset.mockImplementation((config: any, group: string, presetName?: string) => {
    const groupConfig = config.agents.subagents.presetGroups[group];
    const chosen = presetName ?? groupConfig.default;
    return groupConfig.presets[chosen]?.agents ?? {};
  });
  mocks.loadFlantSettings.mockReturnValue({
    enabled: true,
    autoUpdate: true,
    cacheTTLDays: 7,
    lastUpdated: null,
    cachedFlantModels: null,
    cachedOpenRouterData: null,
  });

  mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command !== "which") throw new Error(`Unexpected command: ${command}`);
    const bin = args[0];
    if (bin === "codebase-memory-mcp") return "/usr/bin/codebase-memory-mcp\n";
    if (bin === "sg") return "/usr/bin/sg\n";
    if (bin === "node") return "/usr/bin/node\n";
    if (bin === "npm") return "/usr/bin/npm\n";
    throw new Error(`${bin} not found`);
  });

  const fetchMock = vi.fn(async (url: string) => {
    if (url === "https://llm-api.flant.ru/v1/models") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "claude-opus-4-6" }, { id: "gpt-5-4" }] }),
      };
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "a" }, { id: "b" }] }),
      };
    }
    if (url === "https://mcp.exa.ai/mcp") {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  (globalThis as any).fetch = fetchMock;

  (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")] = { proc: {} };
  (globalThis as any)[Symbol.for("pi-lsp:api")] = { restart: vi.fn(async () => undefined) };

  process.env.FLANT_API_KEY = "flant-key";
  const agentDir = makeTempDir("pi-pi-doctor-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "extensions", "pp", "cache"), { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FLANT_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  delete (globalThis as any).fetch;
  delete (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")];
  delete (globalThis as any)[Symbol.for("pi-lsp:api")];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  it("produces a full multi-category report", async () => {
    const cwd = makeTempDir("pi-pi-doctor-cwd-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    await runDoctor(orchestrator, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [report, kind] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(kind).toBe("info");
    expect(report).toContain("Doctor Results");
    expect(report).toContain("\nConfig\n");
    expect(report).toContain("\nModels\n");
    expect(report).toContain("\nPresets\n");
    expect(report).toContain("\nTools\n");
    expect(report).toContain("\nCommands\n");
    expect(report).toContain("\nFlant\n");
    expect(report).toContain("\nLSP\n");
    expect(report).toContain("\nConnectivity\n");
    expect(report).toContain("\nRepos\n");
    expect(report).toMatch(/\n  [✓⚠✗] /);
    expect(report).toMatch(/Summary: \d+ passed, \d+ warnings, \d+ failures/);
  });

  it("continues and reports failures when individual checks throw", async () => {
    const cwd = makeTempDir("pi-pi-doctor-failure-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    mocks.readRawConfig.mockImplementation(() => {
      throw new Error("parse error");
    });
    mocks.mergeConfigLayers.mockImplementation(() => {
      throw new Error("merge exploded");
    });
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(runDoctor(orchestrator, ctx)).resolves.toBeUndefined();

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [report] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(report).toContain("Config files parseable");
    expect(report).toContain("4-layer merge failed: merge exploded");
    expect(report).toContain("Connectivity checks failed: network down");
    expect(report).toContain("Summary:");
  });

  it("probes Flant, OpenRouter, and Exa over HTTP", async () => {
    const cwd = makeTempDir("pi-pi-doctor-network-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://llm-api.flant.ru/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5-4" }] }) };
      }
      if (url === "https://openrouter.ai/api/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "openrouter/a" }] }) };
      }
      if (url === "https://mcp.exa.ai/mcp") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error("unexpected");
    });
    (globalThis as any).fetch = fetchMock;

    await runDoctor(orchestrator, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://llm-api.flant.ru/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.exa.ai/mcp",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not warn about empty overrides when config files are missing", async () => {
    const cwd = makeTempDir("pi-pi-doctor-missing-config-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    await runDoctor(orchestrator, ctx);

    const [report] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(report).toContain("No empty overrides");
    expect(report).not.toContain("Empty override objects: global");
    expect(report).not.toContain("Empty override objects: project");
  });

  it("skips disabled commands and parses env-prefixed/path commands", async () => {
    const cwd = makeTempDir("pi-pi-doctor-disabled-commands-");
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    mkdirSync(join(cwd, "bin"), { recursive: true });
    const config = createConfig();
    config.commands.afterEdit = {
      disabled: { run: "npm run lint", enabled: false },
      envprefixed: { run: "FOO=1 BAR=2 node ./scripts/lint.js", enabled: true },
      pathcmd: { run: "./bin/tool --check", enabled: true },
    } as any;
    config.commands.afterImplement = {
      disabledImpl: { run: "npm test", enabled: false },
    } as any;
    writeFileSync(join(cwd, "bin", "tool"), "#!/bin/sh\n", "utf-8");

    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config,
      active: null,
    } as any;

    await runDoctor(orchestrator, ctx);

    const [report] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(report).toContain("afterEdit.disabled: skipped (disabled)");
    expect(report).toContain("afterImplement.disabledImpl: skipped (disabled)");
    expect(report).toContain("afterEdit.envprefixed: node found");
    expect(report).toContain(`afterEdit.pathcmd: executable path exists at ${join(cwd, "./bin/tool")}`);
  });

  it("reports Exa timeout/abort errors", async () => {
    const cwd = makeTempDir("pi-pi-doctor-timeout-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "https://llm-api.flant.ru/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url === "https://openrouter.ai/api/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url === "https://mcp.exa.ai/mcp") {
        options?.signal?.dispatchEvent?.(new Event("abort"));
        throw new Error("aborted");
      }
      throw new Error("unexpected");
    });
    (globalThis as any).fetch = fetchMock;

    await runDoctor(orchestrator, ctx);

    const [report] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(report).toContain("Connectivity checks failed: aborted");
  });

  it("reports LSP API presence/missing without invoking LSP status", async () => {
    const cwd = makeTempDir("pi-pi-doctor-lsp-");
    const ctx = createCtx();
    const orchestrator = {
      cwd,
      config: createConfig(),
      active: null,
    } as any;

    const status = vi.fn(async () => undefined);
    (globalThis as any)[Symbol.for("pi-lsp:api")] = { status };

    await runDoctor(orchestrator, ctx);

    expect(status).not.toHaveBeenCalled();
    const [withApiReport] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(withApiReport).toContain("LSP API: available");

    ctx.ui.notify.mockClear();
    delete (globalThis as any)[Symbol.for("pi-lsp:api")];

    await runDoctor(orchestrator, ctx);
    const [withoutApiReport] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(withoutApiReport).toContain("LSP API: not available");
  });

  it("validates repos when active task has registered repos", async () => {
    const root = makeTempDir("pi-pi-doctor-repos-");
    const validRepo = join(root, "repo-valid");
    const invalidRepo = join(root, "repo-invalid");
    mkdirSync(join(validRepo, ".git"), { recursive: true });
    mkdirSync(invalidRepo, { recursive: true });

    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "which") {
        const bin = args[0];
        if (bin === "codebase-memory-mcp") return "/usr/bin/codebase-memory-mcp\n";
        if (bin === "sg") return "/usr/bin/sg\n";
        if (bin === "node") return "/usr/bin/node\n";
        if (bin === "npm") return "/usr/bin/npm\n";
        throw new Error(`${bin} not found`);
      }
      if (command === "git" && args[0] === "show-ref" && args[1] === "--verify") {
        const ref = args[2];
        if (ref === "refs/remotes/origin/main") return "hash\n";
        throw new Error("missing ref");
      }
      if (command === "git" && args[0] === "rev-parse") {
        throw new Error("not git");
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const ctx = createCtx();
    const orchestrator = {
      cwd: root,
      config: createConfig(),
      active: {
        state: {
          repos: [
            { path: validRepo, baseBranch: "origin/main", isRoot: true },
            { path: invalidRepo, baseBranch: "origin/dev", isRoot: false },
            { path: join(root, "missing"), baseBranch: "origin/main", isRoot: false },
          ],
        },
      },
    } as any;

    await runDoctor(orchestrator, ctx);

    const [report] = ctx.ui.notify.mock.calls[0] as [string, string];
    expect(report).toContain(`${validRepo}: path exists`);
    expect(report).toContain(`${validRepo}: base branch "origin/main" is valid`);
    expect(report).toContain(`${invalidRepo}: not a git repository`);
    expect(report).toContain(`${join(root, "missing")}: path does not exist`);
  });
});
