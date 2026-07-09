import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const askQueue: Array<any> = [];
const askQuestions: string[] = [];
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  isCancel: (r: any) => r?.__cancel === true,
  askUser: vi.fn(async (_ctx: any, opts: any) => {
    askQuestions.push(opts.question);
    if (askQueue.length === 0) return { __cancel: true, reason: "user" };
    return askQueue.shift();
  }),
}));

vi.mock("./pp-menu.js", () => ({
  USER_CANCELLED: Symbol.for("pi-pi:test:user-cancelled"),
  showActiveTaskMenu: vi.fn(async () => "MENU_RESULT"),
}));

import {
  registerEventHandlers,
  registerOrchestratorToolsForTest,
  detectDefaultBranch,
  selectOption,
  enterReviewCycle,
  stopTask,
  checkoutPrHead,
  finalizeReviewCycle,
  finalizeReviewCycleAutonomous,
  isReviewCycleLive,
} from "./event-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";
import { getDefaultConfig } from "./config.js";
import { normalizeRepoPath, type RepoInfo } from "./repo-utils.js";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  return {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        eventHandlers.set(name, handler);
      }),
      emit: vi.fn(),
    },
    getAllTools: vi.fn().mockReturnValue([{ name: "lsp" }]),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    exec: vi.fn(),
    _handlers: handlers,
    _eventHandlers: eventHandlers,
  };
}

function makeConfig() {
  const config = getDefaultConfig();
  config.general.autoCommit = false;
  config.commands.afterEdit = {};
  config.commands.afterImplement = {};
  config.performance.commands.afterEdit = 1;
  config.performance.commands.afterImplement = 1;
  config.performance.internals.subagentStale = 1;
  config.performance.internals.taskLockStale = 1;
  config.performance.internals.taskLockRefresh = 1;
  return config;
}

const tempDirs: string[] = [];
function makeTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-eh-more-"));
  tempDirs.push(dir);
  return dir;
}

function makeActiveTask(dir?: string): ActiveTask {
  return {
    dir: dir ?? makeTaskDir(),
    type: "implement",
    state: {
      phase: "implement",
      step: "llm_work",
      reviewCycle: null,
      reviewPass: 0,
      from: null,
      description: "Test",
      startedAt: new Date().toISOString(),
    },
    release: null,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewPass: 0,
    description: "Test",
  };
}

let pi: ReturnType<typeof makePi>;
let orchestrator: Orchestrator;

beforeEach(() => {
  askQueue.length = 0;
  askQuestions.length = 0;
  pi = makePi();
  orchestrator = new Orchestrator(pi as any);
  orchestrator.cwd = "/project";
  orchestrator.config = makeConfig() as any;
  registerEventHandlers(orchestrator);
});

afterEach(() => {
  orchestrator.resetTaskScopedState();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function getHandler(name: string): Handler {
  const h = pi._handlers.get(name);
  if (!h) throw new Error(`No handler for ${name}`);
  return h;
}

function getEventHandler(name: string): Handler {
  const h = pi._eventHandlers.get(name);
  if (!h) throw new Error(`No event handler for ${name}`);
  return h;
}

function getTool(name: string): any {
  const call = (pi.registerTool as any).mock.calls.find((c: any[]) => c[0].name === name);
  if (!call) throw new Error(`Tool ${name} not registered`);
  return call[0];
}

describe("detectDefaultBranch", () => {
  function orchWithExec(exec: any) {
    return { pi: { exec } } as any;
  }

  it("returns a registered repo's explicit baseBranch without touching git", async () => {
    const dir = makeTaskDir();
    const repo: RepoInfo = { path: normalizeRepoPath(dir), baseBranch: "origin/dev", isRoot: true };
    const exec = vi.fn();
    const result = await detectDefaultBranch(orchWithExec(exec), [repo], dir);
    expect(result).toBe("origin/dev");
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves origin/HEAD via symbolic-ref", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "refs/remotes/origin/trunk\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = await detectDefaultBranch(orchWithExec(exec), [], "/nowhere");
    expect(result).toBe("origin/trunk");
  });

  it("falls back to origin/main when symbolic-ref fails but main exists", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args.includes("refs/remotes/origin/main")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = await detectDefaultBranch(orchWithExec(exec), [], "/nowhere");
    expect(result).toBe("origin/main");
  });

  it("falls back to origin/master when only master exists", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args.includes("refs/remotes/origin/main")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("refs/remotes/origin/master")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = await detectDefaultBranch(orchWithExec(exec), [], "/nowhere");
    expect(result).toBe("origin/master");
  });

  it("defaults to origin/main when everything fails or throws", async () => {
    const exec = vi.fn(async () => {
      throw new Error("git unavailable");
    });
    const result = await detectDefaultBranch(orchWithExec(exec), [], "/nowhere");
    expect(result).toBe("origin/main");
  });
});

describe("selectOption", () => {
  it("returns the chosen selection and toggles interactivePromptOpen off", async () => {
    askQueue.push({ kind: "selection", selections: ["Beta"] });
    const result = await selectOption({}, "Pick one", ["Alpha", "Beta"]);
    expect(result).toBe("Beta");
    expect(askQuestions[0]).toBe("Pick one");
    expect(orchestrator.interactivePromptOpen).toBe(false);
  });

  it("returns undefined when the user cancels (isCancel)", async () => {
    askQueue.push({ __cancel: true, reason: "user" });
    const result = await selectOption({}, "Pick one", ["Alpha", "Beta"]);
    expect(result).toBeUndefined();
    expect(orchestrator.interactivePromptOpen).toBe(false);
  });

  it("returns undefined when the result is not a selection", async () => {
    askQueue.push({ kind: "freeform", text: "typed" });
    const result = await selectOption({}, "Pick one", ["Alpha"]);
    expect(result).toBeUndefined();
  });
});

describe("enterReviewCycle early-return branches", () => {
  it("reports when there is no active task", async () => {
    orchestrator.active = null;
    expect(await enterReviewCycle(orchestrator, {}, "regular")).toBe("No active task.");
  });

  it("rejects plannotator during the brainstorm phase and clears the cycle", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "brainstorm";
    const msg = await enterReviewCycle(orchestrator, {}, "plannotator");
    expect(msg).toContain("only available for plan and implement");
    expect(orchestrator.active.state.reviewCycle).toBeNull();
  });

  it("rejects plannotator in plan phase when no synthesized plan exists", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    const msg = await enterReviewCycle(orchestrator, {}, "plannotator");
    expect(msg).toContain("No synthesized plan found");
    expect(orchestrator.active.state.reviewCycle).toBeNull();
  });

  it("redirects plannotator to the per-repo menu during implement", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    const msg = await enterReviewCycle(orchestrator, {}, "plannotator");
    expect(msg).toContain("per-repo");
    expect(orchestrator.active.state.reviewCycle).toBeNull();
  });

  it("reports when no reviewers are enabled for the phase", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    const agents = orchestrator.config.agents.subagents.presetGroups.codeReviewers.presets.regular.agents;
    for (const key of Object.keys(agents)) agents[key].enabled = false;
    const msg = await enterReviewCycle(orchestrator, {}, "regular");
    expect(msg).toContain("No code reviewers enabled");
    expect(orchestrator.active.state.reviewCycle).toBeNull();
  });
});

describe("finalizeReviewCycle variants", () => {
  it("finalizeReviewCycle records the pass and returns to user_gate", () => {
    const task = makeActiveTask();
    task.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 3 };
    finalizeReviewCycle(task);
    expect(task.state.step).toBe("user_gate");
    expect(task.state.reviewCycle).toBeNull();
    expect(task.state.reviewPass).toBe(3);
    expect(task.reviewPass).toBe(3);
    expect(task.state.reviewPassByKind?.implement?.auto).toBe(1);
  });

  it("finalizeReviewCycle is a no-op with no cycle", () => {
    const task = makeActiveTask();
    task.state.reviewCycle = null;
    finalizeReviewCycle(task);
    expect(task.state.step).toBe("llm_work");
  });

  it("finalizeReviewCycleAutonomous routes plan phase to synthesize", () => {
    const task = makeActiveTask();
    task.state.phase = "plan";
    task.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 2 };
    finalizeReviewCycleAutonomous(task);
    expect(task.state.step).toBe("synthesize");
    expect(task.state.reviewCycle).toBeNull();
    expect(task.state.reviewPassByKind?.plan?.auto).toBe(1);
  });

  it("finalizeReviewCycleAutonomous routes non-plan phases to llm_work", () => {
    const task = makeActiveTask();
    task.state.phase = "implement";
    task.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 1 };
    finalizeReviewCycleAutonomous(task);
    expect(task.state.step).toBe("llm_work");
    expect(task.state.reviewCycle).toBeNull();
  });

  it("finalizeReviewCycleAutonomous is a no-op with no cycle", () => {
    const task = makeActiveTask();
    task.state.reviewCycle = null;
    finalizeReviewCycleAutonomous(task);
    expect(task.state.reviewCycle).toBeNull();
  });

  it("increments the per-kind pass counter across successive cycles", () => {
    const task = makeActiveTask();
    task.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 1 };
    finalizeReviewCycle(task);
    task.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 2 };
    finalizeReviewCycle(task);
    expect(task.state.reviewPassByKind?.implement?.auto).toBe(2);
    expect(isReviewCycleLive(task)).toBe(false);
  });
});

describe("stopTask", () => {
  it("reports when there is no active task", async () => {
    orchestrator.active = null;
    expect(await stopTask(orchestrator)).toBe("No active task.");
  });

  it("clears the active task and finalizes through the transition controller", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.lastCtx = { isIdle: () => true } as any;
    const abortSpy = vi.spyOn(orchestrator, "abortAllSubagents");
    const result = await stopTask(orchestrator);
    expect(result).toContain("stopped");
    expect(orchestrator.active).toBeNull();
    expect(abortSpy).toHaveBeenCalled();
  });
});

describe("checkoutPrHead additional branches", () => {
  function orchWithExec(exec: any) {
    return { pi: { exec } } as any;
  }

  it("reports a non-zero git status without halting on a specific outcome", async () => {
    const exec = vi.fn(async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repo" }));
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot inspect");
    expect(result.message).toContain("fatal: not a git repo");
  });

  it("reports when git status throws", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot inspect");
  });

  it("leaves a clean tree as-is when only a branch name (no oid) is provided", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no PR head commit provided");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("registered handler branches", () => {
  it("blocks ask_user in autonomous mode", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.mode = "autonomous";
    orchestrator.active.state.phase = "implement";
    const result = await getHandler("tool_call")({ toolName: "ask_user", input: {} }, {});
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Autonomous mode");
  });

  it("gates interactive input while awaiting subagents", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.step = "await_planners";
    const ctx = { ui: { notify: vi.fn() } };
    const result = await getHandler("input")({ source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("ignores non-interactive input", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.step = "await_planners";
    const ctx = { ui: { notify: vi.fn() } };
    const result = await getHandler("input")({ source: "api" }, ctx);
    expect(result).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("tracks a created subagent and decrements the pending count", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.pendingSubagentSpawns = 2;
    getEventHandler("subagents:created")({ id: "agent-1", description: "planner opus" });
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(true);
    expect(orchestrator.pendingSubagentSpawns).toBe(1);
    expect(orchestrator.agentDescriptions.get("agent-1")).toBe("planner opus");
  });

  it("removes a completed subagent and emits a result context message", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.agentDescriptions.set("agent-1", "reviewer gpt");
    getEventHandler("subagents:completed")({ id: "agent-1", description: "reviewer gpt", durationMs: 1500 });
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(false);
    const customCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-result");
    expect(customCall).toBeDefined();
    expect(customCall[0].content).toContain("reviewer gpt");
  });

  it("cleans up a stopped subagent without emitting an error", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.agentDescriptions.set("agent-1", "planner");
    getEventHandler("subagents:failed")({ id: "agent-1", status: "stopped" });
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(false);
    const errCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-error");
    expect(errCall).toBeUndefined();
  });

  it("aborts remaining subagents on an API error and emits an error message", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.spawnedAgentIds.add("agent-2");
    orchestrator.agentDescriptions.set("agent-1", "planner opus");
    const abortSpy = vi.spyOn(orchestrator, "abortAllSubagents");
    getEventHandler("subagents:failed")({ id: "agent-1", status: "error", toolUses: 0, error: "500 boom" });
    expect(abortSpy).toHaveBeenCalled();
    const errCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-error");
    expect(errCall[0].content).toContain("model/API error");
  });

  it("supplies the transition summary during controller-initiated compaction", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.lastCtx = { isIdle: () => false } as any;
    void orchestrator.transitionController.requestTransition({ kind: "phase", summary: "PHASE SUMMARY" });
    expect(orchestrator.transitionController.isTransitioning()).toBe(true);
    const result = await getHandler("session_before_compact")(
      { preparation: { firstKeptEntryId: "e1", tokensBefore: 100 }, branchEntries: [] },
      {},
    );
    expect(result?.compaction?.summary).toBe("PHASE SUMMARY");
  });

  it("session_before_compact is a no-op with no active task and no transition", async () => {
    orchestrator.active = null;
    const result = await getHandler("session_before_compact")(
      { preparation: { firstKeptEntryId: "e1", tokensBefore: 100 } },
      {},
    );
    expect(result).toBeUndefined();
  });

  it("planner completion with no plan files pushes synthesize-yourself instruction", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "await_planners";
    orchestrator.checkPlannerCompletion();
    expect(orchestrator.active.state.step).toBe("synthesize");
    const sent = (pi.sendUserMessage as any).mock.calls.map((c: any[]) => c[0]).join(" ");
    expect(sent).toContain("Create the plan yourself");
  });

  it("planner completion with plan files advances to synthesize", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "await_planners";
    const plansDir = join(orchestrator.active.dir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "1_opus.md"), "a plan", "utf-8");
    orchestrator.checkPlannerCompletion();
    expect(orchestrator.active.state.step).toBe("synthesize");
    const sent = (pi.sendUserMessage as any).mock.calls.map((c: any[]) => c[0]).join(" ");
    expect(sent).toContain("All planners completed");
  });
});

describe("pp_phase_complete tool", () => {
  function ctxWithUi() {
    return {
      ui: { setWorkingMessage: vi.fn(), notify: vi.fn() },
      abort: vi.fn(),
    };
  }

  it("blocks while the step is awaiting reviewers", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.step = "await_reviewers";
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("still running");
  });

  it("blocks while subagents are still tracked", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("subagent(s) still running");
  });

  it("drives the autonomous transition when the phase mode is autonomous", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.mode = "autonomous";
    const transitionSpy = vi.fn(async () => ({ ok: true as const }));
    orchestrator.transitionToNextPhase = transitionSpy;
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(transitionSpy).toHaveBeenCalled();
    expect(result.content[0].text).toBe("");
  });

  it("reports a blocked autonomous transition", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.mode = "autonomous";
    orchestrator.transitionToNextPhase = async () => ({ ok: false, error: "boom" });
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).toContain("Transition blocked: boom");
  });

  it("returns the guided menu result", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).toBe("MENU_RESULT");
  });
});
