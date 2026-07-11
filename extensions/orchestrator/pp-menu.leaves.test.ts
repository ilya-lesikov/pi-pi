import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, mergeConfigLayers } from "./config.js";
import * as configModule from "./config.js";
import { buildResetOptions, showActiveTaskMenu } from "./pp-menu.js";

const askQueue: string[] = [];
const askQuestions: string[] = [];
const askOptions: string[][] = [];
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  isCancel: (r: any) => r?.__cancel === true,
  askUser: vi.fn(async (_ctx: any, opts: any) => {
    askQuestions.push(opts.question);
    askOptions.push((opts.options ?? []).map((o: any) => (typeof o === "string" ? o : o.title)));
    const next = askQueue.shift();
    if (next === undefined || next === "__ESC__") return { __cancel: true, reason: "user" };
    return { kind: "selection", selections: [next] };
  }),
}));

vi.mock("./plannotator.js", () => ({
  cancelPendingPlannotatorWait: () => {},
  openPlannotator: vi.fn(async () => ({ opened: true, reviewId: "rev" })),
  waitForPlannotatorResult: vi.fn(async () => ({ approved: true })),
}));

const { flantSettings, flantMock } = vi.hoisted(() => {
  const flantSettings = {
    enabled: false,
    autoUpdate: true,
    cacheTTLDays: 7,
    switchBackIntervalMinutes: 30,
    subscription: false,
    lastUpdated: null as string | null,
    cachedFlantModels: null as string[] | null,
    cachedOpenRouterData: null as Record<string, unknown> | null,
  };
  const flantMock = {
    clearFlantGeneratedConfig: vi.fn(),
    getFlantGeneratedConfig: vi.fn(() => null),
    loadFlantSettings: vi.fn(() => ({ ...flantSettings })),
    readClaudeOAuthToken: vi.fn(() => null),
    readGatewayApiKey: vi.fn(() => null),
    saveFlantSettings: vi.fn((s: any) => { Object.assign(flantSettings, s); }),
    unregisterFlantProviders: vi.fn(),
    updateFlantInfra: vi.fn(async () => ({ ok: true, models: ["claude-opus", "gpt-5"] })),
    SUB_PROVIDER: "pp-flant-anthropic-sub",
    SUB_MODEL_PREFIX: "sub/",
  };
  return { flantSettings, flantMock };
});
vi.mock("./flant-infra.js", () => flantMock);

vi.mock("./doctor.js", () => ({ runDoctor: vi.fn(async () => {}) }));

const USAGE_TRACKER_SYMBOL = Symbol.for("pi-pi:usage-tracker");
const TASKS_STORE_SYMBOL = Symbol.for("pi-tasks:store");
const LSP_API_SYMBOL = Symbol.for("pi-lsp:api");
const SUBAGENTS_MENU_SYMBOL = Symbol.for("pi-subagents:menu");

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// In-memory config layers so settings-menu writes never touch the real global
// config or leak between tests. mergeConfigLayers stays real (pure).
let globalStore: Record<string, any>;
let projectStore: Record<string, any>;

function projectPath(cwd: string): string {
  return join(cwd, ".pp", "config.json");
}

function setNested(obj: Record<string, any>, keyPath: string[], value: any): void {
  let cur = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const k = keyPath[i]!;
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keyPath[keyPath.length - 1]!] = value;
}

function delNested(obj: Record<string, any>, keyPath: string[]): void {
  let cur = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const k = keyPath[i]!;
    if (!cur[k] || typeof cur[k] !== "object") return;
    cur = cur[k];
  }
  delete cur[keyPath[keyPath.length - 1]!];
}

function installConfigStore(cwd: string): void {
  globalStore = {};
  projectStore = {};
  vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
    if (path === GLOBAL_CONFIG_PATH) return structuredClone(globalStore);
    if (path === projectPath(cwd)) return structuredClone(projectStore);
    return {};
  });
  vi.spyOn(configModule, "writeConfigValue").mockImplementation((path: string, keyPath: string[], value: any) => {
    const store = path === GLOBAL_CONFIG_PATH ? globalStore : projectStore;
    setNested(store, keyPath, value);
  });
  vi.spyOn(configModule, "removeConfigValue").mockImplementation((path: string, keyPath: string[]) => {
    const store = path === GLOBAL_CONFIG_PATH ? globalStore : projectStore;
    delNested(store, keyPath);
  });
  vi.spyOn(configModule, "loadConfig").mockImplementation(() =>
    mergeConfigLayers(structuredClone(globalStore), structuredClone(projectStore)) as any,
  );
}

afterEach(() => {
  askQueue.length = 0;
  askQuestions.length = 0;
  askOptions.length = 0;
  vi.restoreAllMocks();
  Object.assign(flantSettings, {
    enabled: false, autoUpdate: true, cacheTTLDays: 7, switchBackIntervalMinutes: 30,
    subscription: false, lastUpdated: null, cachedFlantModels: null, cachedOpenRouterData: null,
  });
  for (const fn of Object.values(flantMock)) if (typeof fn === "function" && "mockClear" in fn) (fn as any).mockClear();
  delete (globalThis as any)[USAGE_TRACKER_SYMBOL];
  delete (globalThis as any)[TASKS_STORE_SYMBOL];
  delete (globalThis as any)[LSP_API_SYMBOL];
  delete (globalThis as any)[SUBAGENTS_MENU_SYMBOL];
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCtx(notify?: (t: string, kind?: string) => void, input?: (label: string) => Promise<any>) {
  return {
    ui: {
      notify: notify ?? (() => {}),
      input: input ?? (async () => undefined),
    },
    waitForIdle: async () => {},
    abort: () => {},
  };
}

function makeOrchestrator(cwd: string, phase = "implement", type = "implement"): any {
  return {
    cwd,
    pi: { events: { emit: vi.fn() }, exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) },
    active: {
      type,
      dir: join(cwd, ".pp", "state", type, "abc_task"),
      state: { phase, step: "llm_work", mode: "guided", repos: [] },
    },
    config: mergeConfigLayers(null, null) as any,
    transitionController: { isRunning: () => false, abortMainAgent: () => {} },
    cancelPendingRetry: () => {},
    abortAllSubagents: () => {},
    registerAgents: vi.fn(),
    lastCtx: undefined as any,
  };
}

async function navigate(orchestrator: any, ctx: any): Promise<string> {
  return showActiveTaskMenu(orchestrator, ctx, "/pp", "command");
}

describe("General settings — boolean/inverted/log-level flows", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-general-");
    installConfigStore(cwd);
  });

  it("toggles autoCommit off at project scope and reflects it in config + reset options", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "General",
      "Commit automatically: Yes",
      "No", "Set for project",
      "Back", "Back", "Back", "Back",
    );
    const result = await navigate(orchestrator, orchestrator.lastCtx);
    expect(result).toBe("");
    expect(orchestrator.config.general.autoCommit).toBe(false);
    expect(projectStore.general.autoCommit).toBe(false);
    const resets = buildResetOptions(orchestrator, ["general", "autoCommit"]);
    expect(resets.map((r: any) => r.title)).toContain("Reset project setting");
  });

  it("renders source tags on the boolean options after a change", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    projectStore.general = { autoCommit: false };
    orchestrator.config = configModule.loadConfig(cwd) as any;
    askQueue.push("Settings", "General", "Commit automatically: No", "__ESC__");
    await navigate(orchestrator, orchestrator.lastCtx);
    const boolOpts = askOptions.find((opts) => opts.some((t) => t.startsWith("Yes")) && opts.some((t) => t.startsWith("No")));
    expect(boolOpts).toBeDefined();
    const noOption = boolOpts!.find((t) => t.startsWith("No"))!;
    expect(noOption).toContain("active");
    expect(noOption).toContain("project");
  });

  it("sets loadExtraRepoConfigs via the inverted boolean setting", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "General",
      "Ignore configs from other repos: No",
      "Yes", "Set for project",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(orchestrator.config.general.loadExtraRepoConfigs).toBe(false);
    expect(projectStore.general.loadExtraRepoConfigs).toBe(false);
  });

  it("changes the log level at project scope", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "General",
      "Log level: Info",
      "Warning", "Set for project",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(orchestrator.config.general.logLevel).toBe("warn");
    expect(projectStore.general.logLevel).toBe("warn");
  });
});

describe("Flant submenu", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-flant-");
    installConfigStore(cwd);
  });

  it("toggles auto-update via saveFlantSettings", async () => {
    const orchestrator = makeOrchestrator(cwd);
    flantSettings.enabled = true;
    const notes: string[] = [];
    const ctx = makeCtx((t) => notes.push(t));
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Settings", "Flant",
      "Auto-update on startup: ON",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, ctx);
    expect(flantMock.saveFlantSettings).toHaveBeenCalledWith(expect.objectContaining({ autoUpdate: false }));
    expect(notes.some((n) => n.includes("Auto-update on startup: OFF"))).toBe(true);
  });

  it("disables Flant and clears generated config when currently enabled", async () => {
    const orchestrator = makeOrchestrator(cwd);
    flantSettings.enabled = true;
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "Flant",
      "Enable: ON",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(flantMock.saveFlantSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(flantMock.unregisterFlantProviders).toHaveBeenCalled();
    expect(flantMock.clearFlantGeneratedConfig).toHaveBeenCalled();
  });

  it("sets the cache period from the picker", async () => {
    const orchestrator = makeOrchestrator(cwd);
    flantSettings.enabled = true;
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "Flant",
      "Cache period: 7 days",
      "14 days",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(flantMock.saveFlantSettings).toHaveBeenCalledWith(expect.objectContaining({ cacheTTLDays: 14 }));
  });

  it("warns and stays disabled when enabling without FLANT_API_KEY", async () => {
    const prev = process.env.FLANT_API_KEY;
    delete process.env.FLANT_API_KEY;
    const orchestrator = makeOrchestrator(cwd);
    const notes: string[] = [];
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push(
      "Settings", "Flant",
      "Enable: OFF",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(notes.some((n) => n.includes("FLANT_API_KEY"))).toBe(true);
    expect(flantMock.updateFlantInfra).not.toHaveBeenCalled();
    if (prev !== undefined) process.env.FLANT_API_KEY = prev;
  });

  it("shows current status without mutating settings", async () => {
    const orchestrator = makeOrchestrator(cwd);
    flantSettings.enabled = true;
    const notes: string[] = [];
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push(
      "Settings", "Flant",
      "Current status",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(notes.some((n) => n.includes("Enabled: yes"))).toBe(true);
    expect(notes.some((n) => n.includes("Providers:"))).toBe(true);
  });
});

describe("Performance / Timeouts settings", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-perf-");
    installConfigStore(cwd);
  });

  it("edits a timeout with a duration string at project scope", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    const ctx = makeCtx(undefined, async () => "45s");
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Settings", "Performance", "Timeouts",
      "Command after file edit: 30s",
      "Edit",
      "Set for project",
      "Back", "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, ctx);
    expect(orchestrator.config.performance.commands.afterEdit).toBe(45000);
    expect(projectStore.performance.commands.afterEdit).toBe(45000);
  });

  it("rejects an invalid duration and leaves the value unchanged", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const notes: string[] = [];
    const ctx = makeCtx((t) => notes.push(t), async () => "nonsense");
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Settings", "Performance", "Timeouts",
      "Main turn stale: 10m",
      "Edit",
      "Back", "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, ctx);
    expect(notes.some((n) => n.includes("Invalid duration"))).toBe(true);
    expect(orchestrator.config.performance.internals.mainTurnStale).toBe(600000);
  });
});

describe("Commands settings", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-cmd-");
    installConfigStore(cwd);
  });

  it("adds a new after-edit command with glob patterns", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const inputs = ["prettier --write", "*.ts, *.tsx"];
    let i = 0;
    const ctx = makeCtx(undefined, async () => inputs[i++]);
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Settings", "Commands",
      "After file edit: 0 commands",
      "New command",
      "Set for project",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, ctx);
    const cmds = orchestrator.config.commands.afterEdit;
    const entry = Object.values(cmds)[0] as any;
    expect(entry).toBeDefined();
    expect(entry.run).toBe("prettier --write");
    expect(entry.globs).toEqual(["*.ts", "*.tsx"]);
  });

  it("adds a new after-implement command", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const ctx = makeCtx(undefined, async () => "npm test");
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Settings", "Commands",
      "After implementation: 0 commands",
      "New command",
      "Set for project",
      "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, ctx);
    const cmds = orchestrator.config.commands.afterImplement;
    const entry = Object.values(cmds)[0] as any;
    expect(entry.run).toBe("npm test");
  });
});

describe("LSP settings", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-lsp-");
    installConfigStore(cwd);
  });

  it("warns when the LSP API is unavailable", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const notes: string[] = [];
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push("Settings", "LSP", "Restart all servers", "Back", "Back", "Back");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(notes.some((n) => n.includes("LSP API is not available"))).toBe(true);
  });

  it("invokes the registered restart API", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const restart = vi.fn(async () => {});
    (globalThis as any)[LSP_API_SYMBOL] = { restart };
    orchestrator.lastCtx = makeCtx();
    askQueue.push("Settings", "LSP", "Restart all servers", "Back", "Back", "Back");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("reports an error when restart throws", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const notes: string[] = [];
    (globalThis as any)[LSP_API_SYMBOL] = { restart: vi.fn(async () => { throw new Error("boom"); }) };
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push("Settings", "LSP", "Restart all servers", "Back", "Back", "Back");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(notes.some((n) => n.includes("Failed to restart LSP servers: boom"))).toBe(true);
  });
});

describe("Repos settings", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-repos-");
    installConfigStore(cwd);
  });

  it("shows the empty-repos notice when none are registered", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    askQueue.push("Settings", "Info", "Repos", "Back", "Back", "Back", "Back to prompt");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(askQuestions.some((q) => q.includes("No repos registered yet"))).toBe(true);
  });

  it("changes a repo base branch and re-registers agents", async () => {
    const orchestrator = makeOrchestrator(cwd);
    mkdirSync(orchestrator.active.dir, { recursive: true });
    orchestrator.active.state.repos = [{ path: cwd, isRoot: true, baseBranch: "origin/main" }];
    const ctx = makeCtx(undefined, async () => "origin/develop");
    orchestrator.lastCtx = ctx;
    askQueue.push("Settings", "Info", "Repos", cwd, "Change base branch", "Back", "Back", "Back", "Back to prompt");
    await navigate(orchestrator, ctx);
    expect(orchestrator.active.state.repos[0].baseBranch).toBe("origin/develop");
    expect(orchestrator.registerAgents).toHaveBeenCalled();
  });
});

describe("Subagents menu entry", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-sub-");
    installConfigStore(cwd);
  });

  it("delegates to the registered showFleet API", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const showFleet = vi.fn(async () => {});
    (globalThis as any)[SUBAGENTS_MENU_SYMBOL] = { showFleet };
    orchestrator.lastCtx = makeCtx();
    askQueue.push("Subagents", "Back");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(showFleet).toHaveBeenCalledTimes(1);
  });

  it("warns when the subagents API is unavailable", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const notes: string[] = [];
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push("Subagents", "Back");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(notes.some((n) => n.includes("Subagents menu API is not available"))).toBe(true);
  });
});

describe("Orchestrator model/thinking editor", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-orch-");
    installConfigStore(cwd);
  });

  it("changes an orchestrator role thinking level at project scope", async () => {
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Settings", "Agents", "Orchestrators", "Implementer",
      "Thinking: High",
      "Medium", "Set for project",
      "Back", "Back", "Back", "Back", "Back", "Back",
    );
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(orchestrator.config.agents.orchestrators.implement.thinking).toBe("medium");
    expect(projectStore.agents.orchestrators.implement.thinking).toBe("medium");
  });
});

describe("Autonomous settings reached through brainstorm Next", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-auto-");
    installConfigStore(cwd);
  });

  it("configures a plan-phase preset and max passes, then Start advances", async () => {
    const orchestrator = makeOrchestrator(cwd, "brainstorm", "brainstorm");
    mkdirSync(orchestrator.active.dir, { recursive: true });
    orchestrator.transitionController.isRunning = () => true;
    orchestrator.transitionToNextPhase = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx(undefined, async () => "5");
    orchestrator.lastCtx = ctx;
    askQueue.push(
      "Next",
      "Continue to plan & implement",
      "Autonomous",
      "Plan phase",
      "Review preset", "regular [default]",
      "Max review passes: 3",
      "Back",
      "Start",
    );
    const result = await showActiveTaskMenu(orchestrator, ctx, "/pp", "command");
    expect(result).toBe("");
    expect(orchestrator.transitionToNextPhase).toHaveBeenCalled();
    expect(orchestrator.active.state.mode).toBe("autonomous");
    expect(orchestrator.active.state.autonomousConfig.phases.plan.maxReviewPasses).toBe(5);
  });

  it("Back from the mode picker returns to Next without transitioning", async () => {
    const orchestrator = makeOrchestrator(cwd, "brainstorm", "brainstorm");
    mkdirSync(orchestrator.active.dir, { recursive: true });
    orchestrator.transitionController.isRunning = () => true;
    orchestrator.transitionToNextPhase = vi.fn(async () => ({ ok: true }));
    orchestrator.lastCtx = makeCtx();
    askQueue.push(
      "Next",
      "Continue to plan & implement",
      "Back",
      "Back",
      "Back",
    );
    const result = await showActiveTaskMenu(orchestrator, orchestrator.lastCtx, "/pp", "command");
    expect(result).toBe("");
    expect(orchestrator.transitionToNextPhase).not.toHaveBeenCalled();
  });
});

describe("Info menu leaf actions", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTmp("pp-leaves-info-");
    installConfigStore(cwd);
  });

  it("runs Doctor and Task status then exits", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const doctor = (await import("./doctor.js")).runDoctor as any;
    const notes: string[] = [];
    orchestrator.lastCtx = makeCtx((t) => notes.push(t));
    askQueue.push("Settings", "Info", "Doctor", "Task status", "Back", "Back", "Back to prompt");
    await navigate(orchestrator, orchestrator.lastCtx);
    expect(doctor).toHaveBeenCalled();
    expect(notes.some((n) => n.startsWith("Type: implement"))).toBe(true);
  });
});
