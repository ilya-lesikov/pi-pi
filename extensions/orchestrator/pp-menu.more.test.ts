import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getDefaultConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import {
  buildResetOptions,
  pickPreset,
  resumeTask,
  showActiveTaskMenu,
  showPpMenu,
  slugify,
} from "./pp-menu.js";
import * as configModule from "./config.js";

type ResetOption = { title: string; description?: string };

const askQueue: string[] = [];
const askQuestions: string[] = [];
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  isCancel: (r: any) => r?.__cancel === true,
  askUser: vi.fn(async (_ctx: any, opts: any) => {
    askQuestions.push(opts.question);
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

const USAGE_TRACKER_SYMBOL = Symbol.for("pi-pi:usage-tracker");
const TASKS_STORE_SYMBOL = Symbol.for("pi-tasks:store");

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  askQueue.length = 0;
  askQuestions.length = 0;
  vi.restoreAllMocks();
  delete (globalThis as any)[USAGE_TRACKER_SYMBOL];
  delete (globalThis as any)[TASKS_STORE_SYMBOL];
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("keeps a short clean string intact", () => {
    expect(slugify("hello world")).toBe("hello world");
  });

  it("collapses runs of whitespace to single spaces and trims", () => {
    expect(slugify("  a   b\tc  ")).toBe("a b c");
  });

  it("strips characters outside the safe set", () => {
    expect(slugify("café & résumé!")).toBe("caf  rsum");
  });

  it("preserves the allowed punctuation set", () => {
    expect(slugify("src/dir_name.ts:10-20")).toBe("src/dir_name.ts:10-20");
  });

  it("truncates with an ellipsis past maxLen", () => {
    const out = slugify("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("falls back to a placeholder when nothing survives sanitizing", () => {
    expect(slugify("")).toBe("(empty)");
  });
});

function makePi() {
  return {
    on: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
    getAllTools: vi.fn().mockReturnValue([]),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  };
}

function makeOrchestrator(cwd: string): Orchestrator {
  const orchestrator = new Orchestrator(makePi() as any);
  orchestrator.cwd = cwd;
  orchestrator.config = getDefaultConfig() as any;
  return orchestrator;
}

describe("buildResetOptions", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp("pp-reset-");
    mkdirSync(join(cwd, ".pp"), { recursive: true });
  });

  it("returns no options when neither layer overrides the key", () => {
    vi.spyOn(configModule, "readRawConfig").mockReturnValue({});
    const orchestrator = makeOrchestrator(cwd);
    expect(buildResetOptions(orchestrator, ["general", "autoCommit"])).toEqual([]);
  });

  it("offers a project reset reflecting the overridden value", () => {
    vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
      if (path === join(cwd, ".pp", "config.json")) return { general: { autoCommit: false } };
      return {};
    });
    const orchestrator = makeOrchestrator(cwd);
    const options = buildResetOptions(orchestrator, ["general", "autoCommit"]) as ResetOption[];
    expect(options).toHaveLength(1);
    expect(options[0]!.title).toBe("Reset project setting");
    expect(options[0]!.description).toBe("false");
  });

  it("offers both global and project resets with their inline values", () => {
    vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
      if (path === configModule.GLOBAL_CONFIG_PATH) return { general: { logLevel: "debug" } };
      if (path === join(cwd, ".pp", "config.json")) return { general: { logLevel: "warn" } };
      return {};
    });
    const orchestrator = makeOrchestrator(cwd);
    const options = buildResetOptions(orchestrator, ["general", "logLevel"]) as ResetOption[];
    expect(options.map((o) => o.title)).toEqual(["Reset global setting", "Reset project setting"]);
    expect(options[0]!.description).toBe('"debug"');
    expect(options[1]!.description).toBe('"warn"');
  });

  it("ignores an empty-object override", () => {
    vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
      if (path === join(cwd, ".pp", "config.json")) return { general: {} };
      return {};
    });
    const orchestrator = makeOrchestrator(cwd);
    expect(buildResetOptions(orchestrator, ["general"])).toEqual([]);
  });
});

describe("pickPreset", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp("pp-preset-");
  });

  const ctx = { ui: { notify: vi.fn() } };

  it("returns the raw preset name for a selected [default]-tagged option", async () => {
    const orchestrator = makeOrchestrator(cwd);
    askQueue.push("regular [default]");
    const picked = await pickPreset(ctx, orchestrator, "codeReviewers", "Review preset");
    expect(picked).toBe("regular");
    expect(askQuestions).toContain("Review preset");
  });

  it("returns a non-default preset by its plain name", async () => {
    const orchestrator = makeOrchestrator(cwd);
    askQueue.push("deep");
    expect(await pickPreset(ctx, orchestrator, "codeReviewers", "Review preset")).toBe("deep");
  });

  it("returns null on Back", async () => {
    const orchestrator = makeOrchestrator(cwd);
    askQueue.push("Back");
    expect(await pickPreset(ctx, orchestrator, "planners", "Planner preset")).toBeNull();
  });

  it("returns null on ESC/cancel", async () => {
    const orchestrator = makeOrchestrator(cwd);
    askQueue.push("__ESC__");
    expect(await pickPreset(ctx, orchestrator, "planners", "Planner preset")).toBeNull();
  });

  it("skips disabled presets from the option list", async () => {
    const orchestrator = makeOrchestrator(cwd);
    (orchestrator.config as any).agents.subagents.presetGroups.codeReviewers.presets.deep.enabled = false;
    askQueue.push("__ESC__");
    await pickPreset(ctx, orchestrator, "codeReviewers", "Review preset");
    expect(askQuestions).toHaveLength(1);
  });
});

describe("resumeTask", () => {
  let cwd: string;

  function makeTaskDir(state: Record<string, any>): string {
    const dir = join(cwd, ".pp", "state", state.type ?? "implement", "abc123_test");
    mkdirSync(dir, { recursive: true });
    const { type: _t, ...rest } = state;
    writeFileSync(join(dir, "state.json"), JSON.stringify(rest, null, 2));
    return dir;
  }

  beforeEach(() => {
    cwd = makeTmp("pp-resume-");
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });
  });

  function baseState(overrides: Record<string, any> = {}) {
    return {
      phase: "implement",
      step: "llm_work",
      reviewCycle: null,
      reviewPass: 0,
      from: null,
      description: "Resume me",
      startedAt: new Date().toISOString(),
      repos: [{ path: cwd, isRoot: true }],
      ...overrides,
    };
  }

  function makeCtx() {
    return { ui: { notify: vi.fn() }, waitForIdle: async () => {} };
  }

  function stubOrchestrator(orchestrator: Orchestrator) {
    orchestrator.switchModel = vi.fn(async () => true) as any;
    orchestrator.registerAgents = vi.fn();
    orchestrator.updateStatus = vi.fn();
    orchestrator.injectContextAndArtifacts = vi.fn();
    orchestrator.safeSendUserMessage = vi.fn();
    orchestrator.resetTaskScopedState = vi.fn();
  }

  it("resumes a normal implement task and returns ok", async () => {
    const dir = makeTaskDir({ type: "implement", ...baseState() });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    const result = await resumeTask(orchestrator, ctx, { dir, type: "implement", state: baseState() as any });
    expect(result.ok).toBe(true);
    expect(orchestrator.active?.dir).toBe(dir);
    expect(orchestrator.safeSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Continue working"),
    );
    await orchestrator.active?.release?.();
  });

  it("notifies when awaiting subagents on resume", async () => {
    const state = baseState({ step: "await_reviewers" });
    const dir = makeTaskDir({ type: "implement", ...state });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    const result = await resumeTask(orchestrator, ctx, { dir, type: "implement", state: state as any });
    expect(result.ok).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Awaiting subagents"),
      "info",
    );
    await orchestrator.active?.release?.();
  });

  it("returns an error when config loading throws", async () => {
    const dir = makeTaskDir({ type: "implement", ...baseState() });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    vi.spyOn(configModule, "loadConfig").mockImplementation(() => {
      throw new Error("bad config");
    });
    const ctx = makeCtx();
    const result = await resumeTask(orchestrator, ctx, { dir, type: "implement", state: baseState() as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bad config");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Config error"), "error");
  });

  it("prompts for repo registration when a repo lacks a base branch", async () => {
    const state = baseState({ repos: [{ path: cwd, isRoot: true }] });
    const dir = makeTaskDir({ type: "implement", ...state });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    await resumeTask(orchestrator, ctx, { dir, type: "implement", state: state as any });
    expect(orchestrator.safeSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("pp_register_repo"),
    );
    await orchestrator.active?.release?.();
  });

  it("seeds a root repo when the task has none", async () => {
    const state = baseState({ repos: [] });
    const dir = makeTaskDir({ type: "implement", ...state });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    const task = { dir, type: "implement" as const, state: state as any };
    await resumeTask(orchestrator, ctx, task);
    expect(task.state.repos.some((r: any) => r.isRoot)).toBe(true);
    await orchestrator.active?.release?.();
  });

  it("reopens a done task at its completedFrom phase with a valid step", async () => {
    const state = baseState({ phase: "done", step: null, completedFrom: "plan" });
    const dir = makeTaskDir({ type: "implement", ...state });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    const task = { dir, type: "implement" as const, state: state as any };
    const result = await resumeTask(orchestrator, ctx, task);
    expect(result.ok).toBe(true);
    expect(orchestrator.active?.state.phase).toBe("plan");
    expect(orchestrator.active?.state.step).toBe("llm_work");
    expect(orchestrator.active?.state.completedFrom).toBeUndefined();
    await orchestrator.active?.release?.();
  });

  it("reopens a legacy done task (no completedFrom) at the terminal predecessor", async () => {
    const state = baseState({ phase: "done", step: null });
    const dir = makeTaskDir({ type: "implement", ...state });
    const orchestrator = makeOrchestrator(cwd);
    stubOrchestrator(orchestrator);
    const ctx = makeCtx();
    const task = { dir, type: "implement" as const, state: state as any };
    const result = await resumeTask(orchestrator, ctx, task);
    expect(result.ok).toBe(true);
    expect(orchestrator.active?.state.phase).toBe("implement");
    expect(orchestrator.active?.state.step).toBe("llm_work");
    await orchestrator.active?.release?.();
  });
});

function makeMenuCtx(notify?: (t: string) => void) {
  return {
    ui: { notify: notify ?? (() => {}) },
    waitForIdle: async () => {},
    abort: () => {},
  };
}

function makeMenuOrchestrator(phase: string, type = "implement"): any {
  const orchestrator = {
    active: {
      type,
      dir: "/tmp/pp-menu-task",
      state: { phase, step: "llm_work", mode: "guided" },
    },
    cwd: "/tmp/pp-menu-nonexistent",
    config: getDefaultConfig(),
    transitionController: {
      isRunning: () => false,
      abortMainAgent: () => {},
    },
    cancelPendingRetry: () => {},
    abortAllSubagents: () => {},
  };
  return orchestrator;
}

describe("showActiveTaskMenu phase branches", () => {
  it("plan-phase Next offers 'Continue to implement'", async () => {
    const orchestrator = makeMenuOrchestrator("plan");
    askQueue.push("Next", "Back", "Back");
    await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "tool");
    expect(askQuestions).toContain("Next");
  });

  it("brainstorm-phase top menu offers Review with brainstorm target wording", async () => {
    const orchestrator = makeMenuOrchestrator("brainstorm", "implement");
    askQueue.push("__ESC__");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions[0]).toContain("Phase: brainstorm");
  });

  it("autonomous mode renders the compact menu with Complete/Pause", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.active.state.mode = "autonomous";
    askQueue.push("Back to prompt");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions).toHaveLength(1);
  });

  it("autonomous ESC in tool mode returns the USER_CANCELLED sentinel", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.active.state.mode = "autonomous";
    askQueue.push("__ESC__");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "tool");
    expect(result).toContain("user-cancelled");
  });

  it("Settings navigates into the settings submenu then back", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    askQueue.push("Settings", "Back", "Back");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions).toContain("Settings");
  });

  it("Info navigates into Settings then the info submenu then back", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    askQueue.push("Settings", "Info", "Back", "Back", "Back to prompt");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions).toContain("Info");
  });

  it("hides Review while awaiting subagents (isRunning false)", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.transitionController.isRunning = () => false;
    let optionTitles: string[] = [];
    const askMock = (await import("../../3p/pi-ask-user/index.js")).askUser as any;
    askMock.mockImplementationOnce(async (_c: any, opts: any) => {
      askQuestions.push(opts.question);
      optionTitles = opts.options.map((o: any) => o.title);
      return { __cancel: true, reason: "user" };
    });
    await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(optionTitles).not.toContain("Review");
  });

  it("offers Review once a review is running (isRunning true)", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.transitionController.isRunning = () => true;
    let optionTitles: string[] = [];
    const askMock = (await import("../../3p/pi-ask-user/index.js")).askUser as any;
    askMock.mockImplementationOnce(async (_c: any, opts: any) => {
      askQuestions.push(opts.question);
      optionTitles = opts.options.map((o: any) => o.title);
      return { __cancel: true, reason: "user" };
    });
    await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(optionTitles).toContain("Review");
  });

  it("returns 'No active task.' when there is no active task", async () => {
    const orchestrator: any = {
      active: null,
      transitionController: { isRunning: () => false, abortMainAgent: () => {} },
      cancelPendingRetry: () => {},
      abortAllSubagents: () => {},
    };
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "tool");
    expect(result).toBe("No active task.");
  });
});

describe("showActiveTaskMenu quick task", () => {
  it("delegates to the quick-task menu and exits on Back", async () => {
    const orchestrator = makeMenuOrchestrator("quick", "quick");
    orchestrator.active.state.phase = "quick";
    askQueue.push("Back to prompt");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions[0]).toContain("Task: quick");
  });

  it("quick-task Info submenu (via Settings) then Back returns to the quick menu", async () => {
    const orchestrator = makeMenuOrchestrator("quick", "quick");
    orchestrator.active.state.phase = "quick";
    askQueue.push("Settings", "Info", "Back", "Back", "Back to prompt");
    const result = await showActiveTaskMenu(orchestrator, makeMenuCtx(), "/pp", "command");
    expect(result).toBe("");
    expect(askQuestions.filter((q) => q === "Info")).toHaveLength(1);
  });
});

describe("showPpMenu", () => {
  it("delegates to the no-active menu when there is no active task", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.active = null;
    askQueue.push("Back");
    const result = await showPpMenu(orchestrator, makeMenuCtx(), "command");
    expect(result).toBeUndefined();
    expect(askQuestions[0]).toBe("/pp");
  });

  it("returns undefined for an empty active-menu result (Back)", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    askQueue.push("Back");
    const result = await showPpMenu(orchestrator, makeMenuCtx(), "command");
    expect(result).toBeUndefined();
  });

  it("returns the sentinel text in tool mode on ESC", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    askQueue.push("__ESC__");
    const result = await showPpMenu(orchestrator, makeMenuCtx(), "tool");
    expect(result).toContain("user-cancelled");
  });

  it("no-active menu navigates Settings then Info then Back", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.active = null;
    askQueue.push("Settings", "Info", "Back", "Back", "Back to prompt");
    const result = await showPpMenu(orchestrator, makeMenuCtx(), "command");
    expect(result).toBeUndefined();
    expect(askQuestions).toContain("Info");
  });

  it("shows a read-only config-error menu when configError is set", async () => {
    const orchestrator = makeMenuOrchestrator("implement");
    orchestrator.active = null;
    orchestrator.configError = "bad duration at performance.x";
    askQueue.push("Back");
    const result = await showPpMenu(orchestrator, makeMenuCtx(), "command");
    expect(result).toBeUndefined();
    // The error and config context are surfaced in the menu title; normal
    // task-execution entries (Task) are NOT offered.
    expect(askQuestions[0]).toContain("config error");
    expect(askQuestions[0]).toContain("bad duration at performance.x");
    expect(askQuestions[0]).not.toContain("Task");
  });
});
