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
  readClaudeOAuthToken: vi.fn(),
  readGatewayApiKey: vi.fn(),
  refreshClaudeOAuthToken: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));

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
  SUB_MODEL_PREFIX: "sub/",
  loadFlantSettings: mocks.loadFlantSettings,
  readClaudeOAuthToken: mocks.readClaudeOAuthToken,
  readGatewayApiKey: mocks.readGatewayApiKey,
  refreshClaudeOAuthToken: mocks.refreshClaudeOAuthToken,
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
    general: { autoCommit: true, loadExtraRepoConfigs: true, logLevel: "info" },
    agents: {
      orchestrators: {
        implement: { model: "anthropic/claude-opus-latest", thinking: "high" },
        plan: { model: "anthropic/claude-opus-latest", thinking: "high" },
        debug: { model: "openai/gpt-latest", thinking: "high" },
        brainstorm: { model: "anthropic/claude-opus-latest", thinking: "high" },
        review: { model: "anthropic/claude-opus-latest", thinking: "high" },
        quick: { model: "anthropic/claude-opus-latest", thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: "google/gemini-flash-latest", thinking: "low" },
        },
        presetGroups: {
          planners: { default: "regular", presets: { regular: { enabled: true, agents: { opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" } } } } },
          codeReviewers: { default: "regular", presets: { regular: { enabled: true, agents: { gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "high" } } } } },
          planReviewers: { default: "regular", presets: { regular: { enabled: true, agents: { opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" } } } } },
          brainstormReviewers: { default: "regular", presets: { regular: { enabled: true, agents: { gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" } } } } },
        },
      },
    },
    commands: { afterEdit: {}, afterImplement: {} },
    performance: {},
  };
}

function createCtx() {
  return {
    ui: { notify: vi.fn() },
    modelRegistry: {
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-opus-latest" },
        { provider: "openai", id: "gpt-5.4" },
        { provider: "google", id: "gemini-3.1-flash" },
        { provider: "google", id: "gemini-3.1-pro" },
      ]),
    },
  };
}

function report(ctx: any): string {
  return ctx.ui.notify.mock.calls[0][0] as string;
}

beforeEach(() => {
  const aliasMap: Record<string, string> = {
    "anthropic/claude-opus-latest": "anthropic/claude-opus-latest",
    "openai/gpt-latest": "openai/gpt-5.4",
    "google/gemini-flash-latest": "google/gemini-3.1-flash",
    "google/gemini-pro-latest": "google/gemini-3.1-pro",
  };
  mocks.resolveModel.mockImplementation((v: string) => aliasMap[v] ?? v);
  mocks.getAllAliases.mockReturnValue({ ...aliasMap });
  mocks.mergeConfigLayers.mockReturnValue(createConfig());
  mocks.readRawConfig.mockImplementation(() => ({}));
  mocks.resolvePreset.mockImplementation((config: any, group: string, presetName?: string) => {
    const gc = config.agents.subagents.presetGroups[group];
    return gc.presets[presetName ?? gc.default]?.agents ?? {};
  });
  mocks.loadFlantSettings.mockReturnValue({ enabled: false, subscription: false, cachedFlantModels: null, cachedOpenRouterData: null });
  mocks.readClaudeOAuthToken.mockReturnValue(null);
  mocks.readGatewayApiKey.mockReturnValue(null);
  mocks.refreshClaudeOAuthToken.mockResolvedValue(null);

  mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command !== "which") throw new Error(`Unexpected command: ${command}`);
    throw new Error(`${args[0]} not found`);
  });

  const fetchMock = vi.fn(async (url: string) => {
    if (url === "https://mcp.exa.ai/mcp") return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  (globalThis as any).fetch = fetchMock;
  delete (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")];
  delete (globalThis as any)[Symbol.for("pi-lsp:api")];
  delete process.env.FLANT_API_KEY;
  const agentDir = makeTempDir("pi-pi-doctor-more-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "extensions", "pp", "cache"), { recursive: true });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FLANT_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  delete (globalThis as any).fetch;
  delete (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")];
  delete (globalThis as any)[Symbol.for("pi-lsp:api")];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeOrch(cfg = createConfig()): any {
  return { cwd: makeTempDir("pi-pi-doctor-more-cwd-"), config: cfg, active: null };
}

describe("runDoctor tool-binary branches", () => {
  it("warns when git/gh/cbm/sg binaries are all missing", async () => {
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    const r = report(ctx);
    expect(r).toContain("git: not found");
    expect(r).toContain("gh: not found");
    expect(r).toContain("codebase-memory-mcp: not found");
    expect(r).toContain("CBM daemon: skipped (binary not found)");
    expect(r).toContain("sg (ast-grep): not found");
  });

  it("reports CBM daemon initialized vs not initialized when the binary exists", async () => {
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "codebase-memory-mcp") return "/usr/bin/codebase-memory-mcp\n";
      throw new Error(`${args[0]} not found`);
    });
    (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")] = { proc: {} };
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("CBM daemon: initialized");

    (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")] = { proc: null };
    const ctx2 = createCtx();
    await runDoctor(makeOrch(), ctx2);
    expect(report(ctx2)).toContain("CBM daemon: not initialized");
  });
});

describe("runDoctor config-warning branches", () => {
  it("warns on unknown top-level keys and empty override objects", async () => {
    const orch = makeOrch();
    mkdirSync(join(orch.cwd, ".pp"), { recursive: true });
    writeFileSync(join(orch.cwd, ".pp", "config.json"), "{}", "utf-8");
    mocks.readRawConfig.mockImplementation(() => ({ bogusKey: {}, general: {} }));
    const ctx = createCtx();
    await runDoctor(orch, ctx);
    const r = report(ctx);
    expect(r).toContain("Unknown top-level keys:");
    expect(r).toMatch(/Empty override objects:/);
  });

  it("reports config parse failure across both files", async () => {
    mocks.readRawConfig.mockImplementation(() => { throw new Error("bad json"); });
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("Config files parseable");
  });
});

describe("runDoctor model-availability branches", () => {
  it("flags missing orchestrator and subagent models", async () => {
    mocks.resolveModel.mockImplementation((v: string) => `resolved/${v}`);
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    const r = report(ctx);
    expect(r).toContain("Orchestrator model missing:");
    expect(r).toContain("Subagent model missing:");
  });

  it("warns on missing enabled preset agent models", async () => {
    const cfg = createConfig();
    cfg.agents.subagents.presetGroups.planners.presets.regular.agents.opus.model = "anthropic/does-not-exist";
    const ctx = createCtx();
    await runDoctor(makeOrch(cfg), ctx);
    expect(report(ctx)).toMatch(/agent "opus".*not available/);
  });
});

describe("runDoctor preset-consistency branches", () => {
  it("fails when the default preset is missing", async () => {
    const cfg = createConfig();
    (cfg.agents.subagents.presetGroups.planners as any).default = "ghost";
    const ctx = createCtx();
    await runDoctor(makeOrch(cfg), ctx);
    expect(report(ctx)).toContain('default preset "ghost" is missing');
  });

  it("fails when the default preset is disabled", async () => {
    const cfg = createConfig();
    (cfg.agents.subagents.presetGroups.planners.presets.regular as any).enabled = false;
    const ctx = createCtx();
    await runDoctor(makeOrch(cfg), ctx);
    expect(report(ctx)).toContain('is disabled');
  });

  it("fails when the default preset has no enabled agents", async () => {
    const cfg = createConfig();
    (cfg.agents.subagents.presetGroups.planners.presets.regular.agents.opus as any).enabled = false;
    const ctx = createCtx();
    await runDoctor(makeOrch(cfg), ctx);
    expect(report(ctx)).toContain("has no enabled agents");
  });
});

describe("runDoctor Flant branches", () => {
  it("skips Flant checks when nothing Flant is configured", async () => {
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("Skipped: FLANT_API_KEY not set");
  });

  it("warns when subscription is enabled but no OAuth token is present", async () => {
    mocks.loadFlantSettings.mockReturnValue({ enabled: true, subscription: true, cachedFlantModels: null, cachedOpenRouterData: null });
    process.env.FLANT_API_KEY = "flant-k";
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    const r = report(ctx);
    expect(r).toContain("FLANT_API_KEY is present");
    expect(r).toContain("no valid Claude OAuth token");
  });

  it("warns when subscription enabled with OAuth token but no gateway key", async () => {
    mocks.loadFlantSettings.mockReturnValue({ enabled: true, subscription: true, cachedFlantModels: null, cachedOpenRouterData: null });
    process.env.FLANT_API_KEY = "flant-k";
    mocks.refreshClaudeOAuthToken.mockResolvedValue("sk-ant-oat01-x");
    mocks.readGatewayApiKey.mockReturnValue(null);
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("no gateway key");
  });

  it("probes the subscription endpoint and reports reachable on success", async () => {
    mocks.loadFlantSettings.mockReturnValue({ enabled: true, subscription: true, cachedFlantModels: null, cachedOpenRouterData: null });
    process.env.FLANT_API_KEY = "flant-k";
    mocks.refreshClaudeOAuthToken.mockResolvedValue("sk-ant-oat01-x");
    mocks.readGatewayApiKey.mockReturnValue("gw");
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("Personal subscription reachable");
  });

  it("reports a subscription probe HTTP failure", async () => {
    mocks.loadFlantSettings.mockReturnValue({ enabled: true, subscription: true, cachedFlantModels: null, cachedOpenRouterData: null });
    process.env.FLANT_API_KEY = "flant-k";
    mocks.refreshClaudeOAuthToken.mockResolvedValue("sk-ant-oat01-x");
    mocks.readGatewayApiKey.mockReturnValue("gw");
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (url === "https://llm-api.flant.ru/v1/messages") return { ok: false, status: 429, json: async () => ({}) };
      if (url === "https://mcp.exa.ai/mcp") return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("Personal subscription probe failed with HTTP 429");
  });
});

describe("runDoctor connectivity + repo branches", () => {
  it("reports the Exa probe returning a non-ok status", async () => {
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (url === "https://mcp.exa.ai/mcp") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("Exa MCP probe failed with HTTP 500");
  });

  it("fails the cwd repo check when the path is not a git repo and git is unavailable", async () => {
    const ctx = createCtx();
    await runDoctor(makeOrch(), ctx);
    expect(report(ctx)).toContain("not a git repository");
  });
});
