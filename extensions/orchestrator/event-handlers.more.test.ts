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

const showActiveTaskMenuMock = vi.fn(async (..._args: any[]) => "MENU_RESULT");
vi.mock("./pp-menu.js", () => ({
  USER_CANCELLED: Symbol.for("pi-pi:test:user-cancelled"),
  showActiveTaskMenu: showActiveTaskMenuMock,
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

  it("creates a tracking branch and switches when the local branch is missing", async () => {
    // HEAD is asked twice: initial (not on oid) then post-switch (on oid).
    let headCalls = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: headCalls++ === 0 ? "othersha" : "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/remotes/origin/feature")) return { code: 0, stdout: "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/heads/feature")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(true);
    expect(result.message).toContain('switched to PR head branch "feature"');
    const createdTracking = exec.mock.calls.some((c: any[]) => c[1][0] === "checkout" && c[1].includes("-b"));
    expect(createdTracking).toBe(true);
  });

  it("HALTs when the PR head branch cannot be fetched from origin (fork PR)", async () => {
    let headCalls = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: headCalls++ === 0 ? "othersha" : "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "fetch") return { code: 128, stdout: "", stderr: "couldn't find remote ref" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("could not fetch PR head branch");
  });

  it("HALTs when the fetched origin tip does not match the advertised oid", async () => {
    let headCalls = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: headCalls++ === 0 ? "othersha" : "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/remotes/origin/feature")) return { code: 0, stdout: "differentsha", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("not the advertised PR head");
  });

  it("fast-forwards and switches an existing local branch that is a safe ancestor of the PR head", async () => {
    let headCalls = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: headCalls++ === 0 ? "othersha" : "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/remotes/origin/feature")) return { code: 0, stdout: "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/heads/feature")) return { code: 0, stdout: "localtip", stderr: "" };
      if (args[0] === "merge-base" && args.includes("--is-ancestor")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(true);
    expect(result.message).toContain('switched to PR head branch "feature"');
    // Ancestry was proven BEFORE the checkout.
    const order = exec.mock.calls.map((c: any[]) => c[1].join(" "));
    const ancestorIdx = order.findIndex((c: string) => c.includes("merge-base --is-ancestor"));
    const checkoutIdx = order.findIndex((c: string) => c.startsWith("checkout feature"));
    expect(ancestorIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(ancestorIdx);
  });

  it("HALTs on a diverged local branch WITHOUT checking it out (never switches then fails)", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: "othersha", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/remotes/origin/feature")) return { code: 0, stdout: "abc123", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("refs/heads/feature")) return { code: 0, stdout: "divergedtip", stderr: "" };
      if (args[0] === "merge-base" && args.includes("--is-ancestor")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("has diverged");
    // The critical guarantee: no checkout was issued — the user stays on their branch.
    const checkedOut = exec.mock.calls.some((c: any[]) => c[1][0] === "checkout");
    expect(checkedOut).toBe(false);
  });

  it("still HALTs on a dirty tree regardless of branch", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: " M file.ts", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await checkoutPrHead(orchWithExec(exec), "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("uncommitted changes");
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
    getEventHandler("subagents:created")({ id: "agent-1", description: "planner opus" }, {});
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(true);
    expect(orchestrator.pendingSubagentSpawns).toBe(1);
    expect(orchestrator.agentDescriptions.get("agent-1")).toBe("planner opus");
  });

  it("removes a completed subagent and emits a result context message", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.agentDescriptions.set("agent-1", "reviewer gpt");
    getEventHandler("subagents:completed")({ id: "agent-1", description: "reviewer gpt", durationMs: 1500 }, {});
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(false);
    const customCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-result");
    expect(customCall).toBeDefined();
    expect(customCall[0].content).toContain("reviewer gpt");
  });

  it("suppresses the per-agent result message for phased-batch completions (item 6)", () => {
    for (const step of ["await_planners", "await_reviewers"]) {
      (pi.sendMessage as any).mockClear();
      orchestrator.active = makeActiveTask();
      orchestrator.active.state.step = step;
      orchestrator.spawnedAgentIds.add("agent-p");
      orchestrator.agentDescriptions.set("agent-p", "planner opus");
      getEventHandler("subagents:completed")({ id: "agent-p", description: "planner opus", durationMs: 900 }, {});
      const customCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-result");
      expect(customCall).toBeUndefined();
    }
  });

  it("marks a phased-batch agent's record consumed to suppress the vendor nudge; leaves free agents alone", () => {
    const records = new Map<string, { resultConsumed?: boolean }>();
    const managerKey = Symbol.for("pi-subagents:manager");
    (globalThis as any)[managerKey] = { getRecord: (id: string) => records.get(id) };
    try {
      // Phased batch: the record IS marked consumed (nudge suppressed).
      records.set("agent-p", {});
      orchestrator.active = makeActiveTask();
      orchestrator.active.state.step = "await_reviewers";
      orchestrator.spawnedAgentIds.add("agent-p");
      orchestrator.agentDescriptions.set("agent-p", "reviewer gpt");
      getEventHandler("subagents:completed")({ id: "agent-p", description: "reviewer gpt" }, {});
      expect(records.get("agent-p")!.resultConsumed).toBe(true);

      // Free (non-phased) agent: the record is NOT touched (keeps its nudge).
      records.set("agent-free", {});
      orchestrator.active = makeActiveTask();
      orchestrator.active.state.step = "llm_work";
      orchestrator.spawnedAgentIds.add("agent-free");
      orchestrator.agentDescriptions.set("agent-free", "advisor gpt");
      getEventHandler("subagents:completed")({ id: "agent-free", description: "advisor gpt" }, {});
      expect(records.get("agent-free")!.resultConsumed).toBeUndefined();
    } finally {
      delete (globalThis as any)[managerKey];
    }
  });

  it("cleans up a stopped subagent without emitting an error", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.agentDescriptions.set("agent-1", "planner");
    getEventHandler("subagents:failed")({ id: "agent-1", status: "stopped" }, {});
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
    getEventHandler("subagents:failed")({ id: "agent-1", status: "error", toolUses: 0, error: "500 boom" }, {});
    expect(abortSpy).toHaveBeenCalled();
    const errCall = (pi.sendMessage as any).mock.calls.find((c: any[]) => c[0]?.customType === "pp-subagent-error");
    expect(errCall[0].content).toContain("model/API error");
  });

  it("does NOT abort siblings when one agent exhausted its empty-turn retries", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.spawnedAgentIds.add("agent-2");
    const abortSpy = vi.spyOn(orchestrator, "abortAllSubagents");
    // An all-empty agent now fails with status "error" and 0 tool uses, which is
    // the API-error signature. But this fault is per-request and transient, so
    // killing a healthy batch over it is exactly what the retry exists to avoid.
    getEventHandler("subagents:failed")({
      id: "agent-1",
      status: "error",
      toolUses: 0,
      error: "Agent produced no output after 3 attempts (18432 tokens spent). The model returned a successful but empty response each time — no text and no tool calls.",
    }, {});
    expect(abortSpy).not.toHaveBeenCalled();
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

  const COMPLETE_PLAN = [
    "# Plan",
    "",
    "## Scope",
    "Do the thing.",
    "",
    "## Checklist",
    "",
    "- [ ] Thing is done — Done when: the test passes",
    "",
    "PLAN_STATUS: COMPLETE",
    "",
  ].join("\n");

  it("planner completion with plan files advances to synthesize", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "await_planners";
    const plansDir = join(orchestrator.active.dir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "1_opus.md"), COMPLETE_PLAN, "utf-8");
    orchestrator.checkPlannerCompletion();
    expect(orchestrator.active.state.step).toBe("synthesize");
    const sent = (pi.sendUserMessage as any).mock.calls.map((c: any[]) => c[0]).join(" ");
    expect(sent).toContain("Synthesize the plan from these COMPLETE planner outputs");
    expect(sent).toContain("1_opus.md");
  });

  it("planner completion with only stubs routes to the self-plan fallback", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "await_planners";
    const plansDir = join(orchestrator.active.dir, "plans");
    mkdirSync(plansDir, { recursive: true });
    // Every planner died after writing its stub: there is nothing to synthesize
    // from, so this must NOT claim the planners completed.
    writeFileSync(join(plansDir, "1_opus.md"), "PLAN_STATUS: INCOMPLETE\n", "utf-8");
    orchestrator.checkPlannerCompletion();
    const sent = (pi.sendUserMessage as any).mock.calls.map((c: any[]) => c[0]).join(" ");
    expect(sent).toContain("No plan files were produced");
    expect(sent).not.toContain("Synthesize the plan from these COMPLETE");
  });

  it("planner completion names incomplete variants as gaps in a mixed outcome", () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "await_planners";
    const plansDir = join(orchestrator.active.dir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "1_opus.md"), COMPLETE_PLAN, "utf-8");
    writeFileSync(join(plansDir, "1_fable.md"), "PLAN_STATUS: INCOMPLETE\n", "utf-8");
    orchestrator.checkPlannerCompletion();
    expect(orchestrator.active.state.step).toBe("synthesize");
    const sent = (pi.sendUserMessage as any).mock.calls.map((c: any[]) => c[0]).join(" ");
    expect(sent).toContain("1_opus.md");
    expect(sent).not.toContain("1_fable.md");
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
    orchestrator.active.state.reconciledPhase = "plan";
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
    orchestrator.active.state.reconciledPhase = "plan";
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
    orchestrator.active.state.reconciledPhase = "implement";
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).toBe("MENU_RESULT");
  });

  it("prompts to reconcile on the first call of a phase, then proceeds on the re-call", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    const transitionSpy = vi.fn(async () => ({ ok: true as const }));
    orchestrator.transitionToNextPhase = transitionSpy;
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");

    const first = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(first.content[0].text).toContain("reconcile the task's state files");
    expect(first.isError).toBeUndefined();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(orchestrator.active.state.phase).toBe("implement");
    expect(orchestrator.active.state.reviewCycle).toBeNull();

    const second = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(second.content[0].text).toBe("MENU_RESULT");
  });

  it("an autonomous run reconciles once then advances on the immediate re-call (no loop)", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.mode = "autonomous";
    const transitionSpy = vi.fn(async () => ({ ok: true as const }));
    orchestrator.transitionToNextPhase = transitionSpy;
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");

    const first = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(first.content[0].text).toContain("reconcile the task's state files");
    expect(transitionSpy).not.toHaveBeenCalled();

    const second = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(second.content[0].text).toBe("");
    expect(transitionSpy).toHaveBeenCalledTimes(1);
  });

  it("never gates a quick-phase task", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.type = "quick";
    orchestrator.active.state.phase = "quick";
    orchestrator.active.state.step = "llm_work";
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");

    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).not.toContain("reconcile the task's state files");
    expect(result.content[0].text).toBe("MENU_RESULT");
  });

  // Item 1: cross-pass review summary wired into the terminal paths.
  function writeRounds(dir: string) {
    const rdir = join(dir, "code-reviews");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "001_gpt_round-1.md"), "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 leak", "utf-8");
    writeFileSync(join(rdir, "001_gpt_round-2.md"), "VERDICT: APPROVE", "utf-8");
  }

  it("guided menu path shows the one-line digest, not the full cross-pass markdown", async () => {
    showActiveTaskMenuMock.mockClear();
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "implement";
    orchestrator.active.state.reviewPassByKind = { implement: { auto: 2 } };
    orchestrator.active.state.reviewApprovedClean = true;
    writeRounds(orchestrator.active.dir);
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    await tool.execute("id", { summary: "agent summary" }, undefined, undefined, ctxWithUi());
    const passedSummary = showActiveTaskMenuMock.mock.calls.at(-1)?.[2] as string;
    expect(passedSummary).toContain("agent summary");
    expect(passedSummary).toContain("Review: 2 passes, reviewers approved — 1 findings addressed, 0 remaining.");
    // The dialog is a chooser sitting under the agent's own prose: per-finding
    // reviewer text belongs in the message, not in the menu title.
    expect(passedSummary).not.toContain("Cross-pass review summary");
    expect(passedSummary).not.toContain("src/a.ts:12 leak");
  });

  it("guided menu path keeps the single-pass summary unchanged (no cross-pass)", async () => {
    showActiveTaskMenuMock.mockClear();
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "implement";
    orchestrator.active.state.reviewPassByKind = { implement: { auto: 1 } };
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    await tool.execute("id", { summary: "agent summary" }, undefined, undefined, ctxWithUi());
    const passedSummary = showActiveTaskMenuMock.mock.calls.at(-1)?.[2] as string;
    expect(passedSummary).toBe("agent summary");
  });

  it("autonomous non-terminal transition stashes the cross-pass summary for the handoff", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.mode = "autonomous";
    orchestrator.active.state.reconciledPhase = "plan";
    orchestrator.active.state.reviewApprovedClean = true;
    orchestrator.active.state.reviewPassByKind = { plan: { auto: 2 } };
    // plan phase reads plan-reviews/.
    const rdir = join(orchestrator.active.dir, "plan-reviews");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "001_gpt_round-1.md"), "VERDICT: NEEDS_CHANGES\n## BLOCKERS: plan.md:3 gap", "utf-8");
    writeFileSync(join(rdir, "001_gpt_round-2.md"), "VERDICT: APPROVE", "utf-8");
    const transitionSpy = vi.fn(async () => ({ ok: true as const }));
    orchestrator.transitionToNextPhase = transitionSpy;
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(transitionSpy).toHaveBeenCalled();
    expect(orchestrator.active!.state.pendingCrossPassSummary).toContain("Cross-pass review summary (plan, 2 passes");
    expect(orchestrator.active!.state.pendingCrossPassSummary).toContain("BLOCKERS: plan.md:3 gap");
  });

  it("manual stop-in-phase appends the cross-pass summary to the tool text", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "implement";
    orchestrator.active.state.reviewApprovedClean = true;
    orchestrator.active.state.reviewPassByKind = { implement: { auto: 2 } };
    orchestrator.active.state.manualAutoReview = { phase: "implement", preset: "regular", maxPasses: 3, advanceOnComplete: false };
    writeRounds(orchestrator.active.dir);
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).toContain("Auto-review complete.");
    expect(result.content[0].text).toContain("Cross-pass review summary (implement, 2 passes");
  });

  it("manual advance (non-terminal) stashes the cross-pass summary for the transition handoff", async () => {
    orchestrator.active = makeActiveTask();
    // plan -> implement is non-terminal, so the summary is stashed for the handoff.
    orchestrator.active.state.phase = "plan";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "plan";
    orchestrator.active.state.reviewApprovedClean = true;
    orchestrator.active.state.reviewPassByKind = { plan: { auto: 2 } };
    orchestrator.active.state.manualAutoReview = { phase: "plan", preset: "regular", maxPasses: 3, advanceOnComplete: true, deferredAdvance: {} };
    const rdir = join(orchestrator.active.dir, "plan-reviews");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "001_gpt_round-1.md"), "VERDICT: NEEDS_CHANGES\n## BLOCKERS: plan.md:3 gap", "utf-8");
    writeFileSync(join(rdir, "001_gpt_round-2.md"), "VERDICT: APPROVE", "utf-8");
    // Capture the stashed summary at transition time (transitionToNextPhase would
    // otherwise consume/clear it in the real path — here it is spied).
    let stashed: string | undefined;
    orchestrator.transitionToNextPhase = vi.fn(async () => {
      stashed = orchestrator.active!.state.pendingCrossPassSummary;
      return { ok: true as const };
    });
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(stashed).toContain("Cross-pass review summary (plan, 2 passes");
  });

  it("truncates an enormous agent summary in the menu title", async () => {
    showActiveTaskMenuMock.mockClear();
    orchestrator.active = makeActiveTask();
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "implement";
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const huge = Array.from({ length: 40 }, (_, i) => `Fix ${i}: a full paragraph restating what changed, why, and how it was verified.`).join("\n\n");
    await tool.execute("id", { summary: huge }, undefined, undefined, ctxWithUi());
    const passedSummary = showActiveTaskMenuMock.mock.calls.at(-1)?.[2] as string;
    expect(Buffer.byteLength(passedSummary, "utf8")).toBeLessThan(1000);
    expect(passedSummary).toContain("Fix 0:");
    expect(passedSummary).toContain("full details are in the message above");
  });

  it("manual advance to done surfaces the cross-pass summary in the tool text (not the discarded handoff)", async () => {
    orchestrator.active = makeActiveTask();
    // implement -> done DISCARDS the conversation, so the summary must be in text.
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.step = "llm_work";
    orchestrator.active.state.reconciledPhase = "implement";
    orchestrator.active.state.reviewApprovedClean = true;
    orchestrator.active.state.reviewPassByKind = { implement: { auto: 2 } };
    orchestrator.active.state.manualAutoReview = { phase: "implement", preset: "regular", maxPasses: 3, advanceOnComplete: true, deferredAdvance: {} };
    writeRounds(orchestrator.active.dir);
    let stashed: string | undefined = "SENTINEL";
    orchestrator.transitionToNextPhase = vi.fn(async () => {
      stashed = orchestrator.active!.state.pendingCrossPassSummary;
      return { ok: true as const };
    });
    registerOrchestratorToolsForTest(orchestrator);
    const tool = getTool("pp_phase_complete");
    const result = await tool.execute("id", { summary: "s" }, undefined, undefined, ctxWithUi());
    expect(result.content[0].text).toContain("Cross-pass review summary (implement, 2 passes");
    // NOT stashed into the discarded transition handoff.
    expect(stashed).toBeUndefined();
  });
});

describe("adaptive proactive-compaction lifecycle (item 6)", () => {
  // ctx with a scripted getContextUsage() sequence and a compact() spy.
  function makeCompactCtx(usages: Array<{ tokens: number | null; contextWindow: number }>) {
    let i = 0;
    const compact = vi.fn();
    return {
      model: { provider: "pp-flant-anthropic", id: "claude-opus-4-8" },
      compact,
      getContextUsage: () => usages[Math.min(i++, usages.length - 1)],
      ui: { notify: vi.fn() },
    } as any;
  }

  it("captures the post-compaction baseline and raises the threshold across the cycle", async () => {
    orchestrator.active = makeActiveTask();
    // Base (1M window) = 300K, headroom 120K.
    const ctx = makeCompactCtx([
      { tokens: 305_000, contextWindow: 1_000_000 }, // #1 crosses base -> fire
      { tokens: null, contextWindow: 1_000_000 },    // post-compact null -> ignored
      { tokens: 240_000, contextWindow: 1_000_000 }, // baseline captured -> next=360K
    ]);
    const agentEnd = getHandler("agent_end");
    const sessionCompact = getHandler("session_compact");

    await agentEnd({}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(orchestrator.adaptiveCompaction.inFlight).toBe(true);

    await sessionCompact({}, ctx);
    expect(orchestrator.adaptiveCompaction.pendingProactiveMeasure).toBe(true);

    await agentEnd({}, ctx); // null tokens -> ignored, still pending
    expect(orchestrator.adaptiveCompaction.pendingProactiveMeasure).toBe(true);

    await agentEnd({}, ctx); // 240K -> capture baseline, next threshold = 360K
    expect(orchestrator.adaptiveCompaction.pendingProactiveMeasure).toBe(false);
    expect(orchestrator.adaptiveCompaction.nextThreshold).toBe(360_000);
  });

  it("applies a PROVIDER-QUALIFIED perModel override at runtime (finding 1)", async () => {
    orchestrator.active = makeActiveTask();
    // Override keyed by the exact provider-qualified spec raises the base to
    // 0.9*1M = 900K, so a 305K usage that WOULD fire at the default 300K base
    // must NOT fire. A bare-id-only lookup would miss this key and fire.
    orchestrator.config.compaction.perModel = {
      "pp-flant-anthropic/claude-opus-4-8": { fraction: 0.9 },
    } as any;
    const ctx = makeCompactCtx([{ tokens: 305_000, contextWindow: 1_000_000 }]);
    await getHandler("agent_end")({}, ctx);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("a transition/manual session_compact does not schedule a measurement", async () => {
    orchestrator.active = makeActiveTask();
    const ctx = makeCompactCtx([{ tokens: 100_000, contextWindow: 1_000_000 }]);
    // No proactive fire happened -> inFlight false.
    await getHandler("session_compact")({}, ctx);
    expect(orchestrator.adaptiveCompaction.pendingProactiveMeasure).toBe(false);
  });

  it("disables proactive compaction on a thrash and warns", async () => {
    orchestrator.active = makeActiveTask();
    // 200K window: base=ceiling=168K, headroom 40K. Baseline 135K -> 175K > 168K.
    const ctx = makeCompactCtx([
      { tokens: 170_000, contextWindow: 200_000 }, // crosses 168K -> fire
      { tokens: 135_000, contextWindow: 200_000 }, // baseline -> thrash -> disable
      { tokens: 199_000, contextWindow: 200_000 }, // would cross but disabled
    ]);
    const agentEnd = getHandler("agent_end");
    await agentEnd({}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    await getHandler("session_compact")({}, ctx);
    await agentEnd({}, ctx); // capture 135K -> thrash -> disabled
    expect(orchestrator.adaptiveCompaction.disabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalled();
    await agentEnd({}, ctx); // disabled -> no further fire
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("resets adaptive state on a model change", async () => {
    orchestrator.active = makeActiveTask();
    const ctx = makeCompactCtx([{ tokens: 100_000, contextWindow: 1_000_000 }]);
    orchestrator.adaptiveCompaction.nextThreshold = 360_000;
    orchestrator.adaptiveCompaction.modelKey = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    orchestrator.adaptiveCompaction.window = 1_000_000;
    await getHandler("agent_end")({}, ctx); // modelKey differs -> reset
    expect(orchestrator.adaptiveCompaction.nextThreshold).toBeNull();
    expect(orchestrator.adaptiveCompaction.modelKey).toBe("pp-flant-anthropic/claude-opus-4-8");
  });

  it("clears inFlight via onError so a later session_compact is not misclassified (compact is fire-and-forget)", async () => {
    orchestrator.active = makeActiveTask();
    // compact() is fire-and-forget: it reports failure by invoking onError, NOT
    // by throwing synchronously.
    let capturedOnError: ((e: any) => void) | undefined;
    const ctx = {
      model: { provider: "pp-flant-anthropic", id: "claude-opus-4-8" },
      compact: vi.fn((opts: any) => { capturedOnError = opts?.onError; }),
      getContextUsage: () => ({ tokens: 305_000, contextWindow: 1_000_000 }),
      ui: { notify: vi.fn() },
    } as any;
    const agentEnd = getHandler("agent_end");
    const sessionCompact = getHandler("session_compact");

    await agentEnd({}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(orchestrator.adaptiveCompaction.inFlight).toBe(true);
    // The compaction fails asynchronously.
    capturedOnError?.(new Error("compaction failed"));
    expect(orchestrator.adaptiveCompaction.inFlight).toBe(false);
    // A subsequent (manual/transition) session_compact must NOT be attributed
    // to the failed proactive compaction.
    await sessionCompact({}, ctx);
    expect(orchestrator.adaptiveCompaction.pendingProactiveMeasure).toBe(false);
  });
});
