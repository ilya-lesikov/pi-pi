import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommandHandlers, transitionToNextPhase } from "./command-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";
import { getDefaultConfig } from "./config.js";
import * as machineModule from "./phases/machine.js";
import * as commandsModule from "./commands.js";
import * as stateModule from "./state.js";

vi.mock("./pp-menu.js", () => ({
  showPpMenu: vi.fn().mockResolvedValue(undefined),
}));

import { showPpMenu } from "./pp-menu.js";

type Handler = (args: string | undefined, ctx: any) => any;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-cmd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(showPpMenu).mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makePi() {
  const commands = new Map<string, { handler: Handler }>();
  return {
    registerCommand: vi.fn((name: string, cmd: { handler: Handler }) => {
      commands.set(name, cmd);
    }),
    on: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
    getAllTools: vi.fn().mockReturnValue([]),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    _commands: commands,
  };
}

function makeConfig() {
  const config = getDefaultConfig();
  config.general.autoCommit = false;
  config.agents.subagents.presetGroups.codeReviewers = {
    default: "regular",
    presets: {
      regular: {
        enabled: true,
        agents: {
          variant1: { enabled: true, model: "x/1", thinking: "low" },
        },
      },
    },
  };
  config.agents.subagents.presetGroups.brainstormReviewers = {
    default: "regular",
    presets: {
      regular: {
        enabled: true,
        agents: {
          variant1: { enabled: true, model: "x/1", thinking: "low" },
        },
      },
    },
  };
  config.commands.afterEdit = {};
  config.commands.afterImplement = {};
  config.performance.commands.afterEdit = 1;
  config.performance.commands.afterImplement = 1;
  config.performance.internals.subagentStale = 1;
  config.performance.internals.taskLockStale = 1;
  config.performance.internals.taskLockRefresh = 1;
  return config;
}

function makeActiveTask(taskDir: string): ActiveTask {
  const stateDir = join(taskDir, "plans");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "1_synthesized.md"), "- [x] done\n", "utf-8");
  writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
  writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
  return {
    dir: taskDir,
    type: "implement",
    state: {
      phase: "implement",
      step: "user_gate",
      reviewCycle: null,
      reviewPass: 1,
      from: null,
      description: "Test",
      startedAt: new Date().toISOString(),
    },
    release: null,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewPass: 1,
    description: "Test",
  };
}

function makeCtx() {
  return {
    ui: {
      confirm: vi.fn(),
      select: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    abort: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn(),
  };
}

describe("pp command", () => {
  it("opens pp menu command", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveTask(taskDir);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();

    const pp = pi._commands.get("pp");
    expect(pp).toBeTruthy();
    await pp!.handler(undefined, ctx);
    expect(showPpMenu).toHaveBeenCalledWith(orchestrator, ctx, "command");
  });

  it("sends follow-up message when menu returns text", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveTask(taskDir);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();
    vi.mocked(showPpMenu).mockResolvedValueOnce("User wants to continue. Run /pp when ready to advance.");

    const pp = pi._commands.get("pp");
    expect(pp).toBeTruthy();
    await pp!.handler(undefined, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[PI-PI] User wants to continue. Run /pp when ready to advance.");
  });

  it("registers pp command", () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveTask(taskDir);
    registerCommandHandlers(orchestrator);

    expect(pi._commands.has("pp")).toBe(true);
  });
});

describe("transitionToNextPhase", () => {
  function makeTransitionCtx() {
    return {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      compact: vi.fn(),
    };
  }

  function makeTransitionTask(taskDir: string, phase: "brainstorm" | "implement" | "quick" = "brainstorm"): ActiveTask {
    if (phase === "quick") {
      return {
        dir: taskDir,
        type: "quick",
        state: {
          phase: "quick",
          step: "llm_work",
          reviewCycle: null,
          reviewPass: 0,
          reviewPassByKind: {},
          from: null,
          description: "Quick",
          startedAt: new Date().toISOString(),
          repos: [{ path: taskDir, isRoot: true }],
        },
        release: null,
        taskId: "quick-1",
        modifiedFiles: new Set(),
        reviewPass: 0,
        description: "Quick",
      };
    }

    return {
      dir: taskDir,
      type: "implement",
      state: {
        phase,
        step: "llm_work",
        reviewCycle: null,
        reviewPass: 0,
        reviewPassByKind: {},
        from: null,
        description: "Task",
        startedAt: new Date().toISOString(),
        repos: [{ path: taskDir, isRoot: true }],
      },
      release: null,
      taskId: "impl-1",
      modifiedFiles: new Set([join(taskDir, "src", "a.ts")]),
      reviewPass: 0,
      description: "Task",
    };
  }

  it("blocks transition when exit criteria fail", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "brainstorm");
    const ctx = makeTransitionCtx();
    const validateSpy = vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: false, reason: "no artifacts" });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result).toEqual({ ok: false, error: "no artifacts" });
    expect(orchestrator.active?.state.phase).toBe("brainstorm");
    validateSpy.mockRestore();
  });

  it("runs afterImplement when transitioning from implement", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    const ctx = makeTransitionCtx();
    const validateSpy = vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    const groupSpy = vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(new Map([[taskDir, [join(taskDir, "src", "a.ts")]]]) as any);
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: true, command: "npm test", output: "ok" }]);
    const cleanupSpy = vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });
    const abortSpy = vi.spyOn(orchestrator, "abortAllSubagents").mockImplementation(() => undefined);
    const saveSpy = vi.spyOn(stateModule, "saveTask").mockImplementation(() => undefined);

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result.ok).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalled();
    validateSpy.mockRestore();
    groupSpy.mockRestore();
  });

  it("runs afterImplement for root repo during implement to done transition", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    orchestrator.active.state.repos = [{ path: taskDir, isRoot: true }];
    orchestrator.active.modifiedFiles = new Set([join(taskDir, "src", "root.ts")]);
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(
      new Map([[taskDir, [join(taskDir, "src", "root.ts")]]]) as any,
    );
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: true, command: "npm test", output: "ok" }]);
    const cleanupSpy = vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result.ok).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(
      orchestrator.config.commands.afterImplement,
      orchestrator.config.performance.commands.afterImplement,
      orchestrator.cwd,
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("runs afterImplement for extra repo when extra repo configs are enabled", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    const extraRepo = join(taskDir, "extra");
    mkdirSync(extraRepo, { recursive: true });
    orchestrator.cwd = taskDir;
    orchestrator.config = {
      ...makeConfig(),
      general: { ...makeConfig().general, loadExtraRepoConfigs: true },
    } as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    orchestrator.active.state.repos = [
      { path: taskDir, isRoot: true },
      { path: extraRepo, isRoot: false },
    ];
    orchestrator.active.modifiedFiles = new Set([join(extraRepo, "src", "extra.ts")]);
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(
      new Map([[extraRepo, [join(extraRepo, "src", "extra.ts")]]]) as any,
    );
    vi.spyOn(commandsModule, "loadRepoAfterImplementCommands").mockReturnValue({ "cmd-1": { run: "npm run lint" } });
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: true, command: "npm run lint", output: "ok" }]);
    vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result.ok).toBe(true);
    expect(runSpy).toHaveBeenCalledWith({ "cmd-1": { run: "npm run lint" } }, orchestrator.config.performance.commands.afterImplement, extraRepo);
  });

  it("blocks transition when afterImplement fails in extra repo", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    const extraRepo = join(taskDir, "extra");
    mkdirSync(extraRepo, { recursive: true });
    orchestrator.cwd = taskDir;
    orchestrator.config = {
      ...makeConfig(),
      general: { ...makeConfig().general, loadExtraRepoConfigs: true },
    } as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    orchestrator.active.state.repos = [
      { path: taskDir, isRoot: true },
      { path: extraRepo, isRoot: false },
    ];
    orchestrator.active.modifiedFiles = new Set([join(extraRepo, "src", "extra.ts")]);
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(
      new Map([[extraRepo, [join(extraRepo, "src", "extra.ts")]]]) as any,
    );
    vi.spyOn(commandsModule, "loadRepoAfterImplementCommands").mockReturnValue({ "cmd-1": { run: "npm run lint" } });
    vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: false, command: "npm run lint", output: "lint failed" }]);
    const cleanupSpy = vi.spyOn(orchestrator, "cleanupActive");

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("afterImplement commands failed");
    expect(result.error).toContain("npm run lint: lint failed");
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(orchestrator.active?.state.phase).toBe("implement");
  });

  it("skips afterImplement for extra repo when ignoreExtraRepoConfigs is true", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    const extraRepo = join(taskDir, "extra");
    mkdirSync(extraRepo, { recursive: true });
    orchestrator.cwd = taskDir;
    orchestrator.config = {
      ...makeConfig(),
      general: { ...makeConfig().general, loadExtraRepoConfigs: false },
    } as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    orchestrator.active.state.repos = [
      { path: taskDir, isRoot: true },
      { path: extraRepo, isRoot: false },
    ];
    orchestrator.active.modifiedFiles = new Set([join(extraRepo, "src", "extra.ts")]);
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(
      new Map([[extraRepo, [join(extraRepo, "src", "extra.ts")]]]) as any,
    );
    const loadExtraSpy = vi.spyOn(commandsModule, "loadRepoAfterImplementCommands");
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: true, command: "npm test", output: "ok" }]);
    vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result.ok).toBe(true);
    expect(loadExtraSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("transition to done cleans up active task", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "implement");
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    vi.spyOn(await import("./repo-utils.js"), "groupFilesByRepo").mockReturnValue(new Map([[taskDir, [join(taskDir, "src", "a.ts")]]]) as any);
    vi.spyOn(commandsModule, "runAfterImplement").mockReturnValue([{ ok: true, command: "npm test", output: "ok" }]);
    const cleanupSpy = vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result).toEqual({ ok: true });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.taskDoneCompactionPending).toBe(true);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("transition to plan sets await_planners step", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "brainstorm");
    const ctx = makeTransitionCtx();
    const validateSpy = vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    const compactSpy = vi.spyOn(orchestrator, "compactAndTransition").mockImplementation(() => undefined);
    const saveSpy = vi.spyOn(stateModule, "saveTask").mockImplementation(() => undefined);

    const result = await transitionToNextPhase(orchestrator, ctx, "regular");

    expect(result).toEqual({ ok: true });
    expect(orchestrator.active?.state.phase).toBe("plan");
    expect(orchestrator.active?.state.step).toBe("await_planners");
    expect(orchestrator.active?.state.activePlannerPreset).toBe("regular");
    expect(compactSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalled();
    validateSpy.mockRestore();
  });

  it("skips afterImplement for quick tasks", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "quick");
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement");
    const cleanupSpy = vi.spyOn(orchestrator, "cleanupActive").mockImplementation(async () => {
      orchestrator.active = null;
    });

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result).toEqual({ ok: true });
    expect(runSpy).not.toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("skips afterImplement when phase is not implement", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeTransitionTask(taskDir, "brainstorm");
    const ctx = makeTransitionCtx();
    vi.spyOn(machineModule, "validateExitCriteria").mockReturnValue({ ok: true });
    const runSpy = vi.spyOn(commandsModule, "runAfterImplement");
    const compactSpy = vi.spyOn(orchestrator, "compactAndTransition").mockImplementation(() => undefined);

    const result = await transitionToNextPhase(orchestrator, ctx);

    expect(result).toEqual({ ok: true });
    expect(runSpy).not.toHaveBeenCalled();
    expect(orchestrator.active?.state.phase).toBe("plan");
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });
});
