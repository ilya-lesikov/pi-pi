import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerEventHandlers, checkoutPrHead } from "./event-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";
import { getDefaultConfig } from "./config.js";

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
    _handlers: handlers,
    _eventHandlers: eventHandlers,
    // Drive a synthetic lifecycle/session event by invoking the pi.on-registered
    // handler (NOT pi.events.emit, which is only for extension/subagent events).
    emitAgentEnd: (event: any = { type: "agent_end" }, ctx: any = {}) => handlers.get("agent_end")?.(event, ctx),
    emitSessionCompact: (event: any = { type: "session_compact", fromExtension: true }, ctx: any = {}) =>
      handlers.get("session_compact")?.(event, ctx),
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

function makeActiveTask(): ActiveTask {
  return {
    dir: "/tmp/task",
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
  pi = makePi();
  orchestrator = new Orchestrator(pi as any);
  orchestrator.cwd = "/project";
  orchestrator.config = makeConfig() as any;
  registerEventHandlers(orchestrator);
});

function getHandler(name: string): Handler {
  const h = pi._handlers.get(name);
  if (!h) throw new Error(`No handler for ${name}`);
  return h;
}

describe("tool_call write protection", () => {
  it("blocks non-.md writes to .pp/state/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/state/implement/123/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "Cannot write non-.md files in .pp/state/" });
  });

  it("blocks state.json writes under .pp/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { path: ".pp/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "state.json is managed by the extension" });
  });

  it("blocks config.json writes under .pp/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/config.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "config.json is managed by the user, not the LLM" });
  });

  it("allows .md writes to .pp/state/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/state/implement/123/plans/synthesized.md" } },
      {},
    );
    expect(result).toBeUndefined();
  });

  it("backward compatibility: blocks using file_path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { file_path: ".pp/state/implement/123/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "Cannot write non-.md files in .pp/state/" });
  });

  it("backward compatibility: blocks using filePath field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { filePath: ".pp/config.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "config.json is managed by the user, not the LLM" });
  });
});

describe("review-phase AI_COMMENT write guard", () => {
  function reviewTask(): ActiveTask {
    const task = makeActiveTask();
    task.state.phase = "review";
    return task;
  }

  it("allows an edit that only inserts an AI_COMMENT marker", async () => {
    orchestrator.active = reviewTask();
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 1;\n// AI_COMMENT: check" }] } },
      {},
    );
    expect(result).toBeUndefined();
  });

  it("blocks an edit that changes real code during review", async () => {
    orchestrator.active = reviewTask();
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] } },
      {},
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("AI_COMMENT");
  });

  it("blocks a brand-new source file write during review", async () => {
    orchestrator.active = reviewTask();
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: "src/new.ts", content: "// AI_COMMENT: note\n" } },
      {},
    );
    expect(result?.block).toBe(true);
  });

  it("does not restrict source edits outside the review phase", async () => {
    orchestrator.active = makeActiveTask(); // implement phase
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] } },
      {},
    );
    expect(result).toBeUndefined();
  });
});

describe("tool_result implementation tracking", () => {
  it("adds file to modifiedFiles when input uses path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "write", input: { path: "src/index.ts" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.has("/project/src/index.ts")).toBe(true);
  });

  it("skips .pp/ paths in modified-file tracking", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "write", input: { path: ".pp/state/plans/plan.md" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.size).toBe(0);
  });

  it("appends LSP nudge when input uses path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    const result = await handler(
      { toolName: "edit", input: { path: "src/foo.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
      {},
    );
    expect(result?.content).toBeDefined();
    const lastContent = result.content[result.content.length - 1];
    expect(lastContent.text).toContain("lsp diagnostics");
    expect(lastContent.text).toContain("src/foo.ts");
  });

  it("backward compatibility: tracks file using file_path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "edit", input: { file_path: "src/bar.ts" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.has("/project/src/bar.ts")).toBe(true);
  });
});

describe("ask_user ESC aborts the turn", () => {
  it("aborts the turn when the user cancels (reason 'user')", async () => {
    const handler = getHandler("tool_result");
    const ctx = { abort: vi.fn() };
    await handler(
      {
        toolName: "ask_user",
        input: {},
        isError: false,
        content: [{ type: "text", text: "User cancelled the question" }],
        details: { cancelled: true, response: null, cancelReason: "user" },
      },
      ctx,
    );
    expect(ctx.abort).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort on a timeout cancellation", async () => {
    const handler = getHandler("tool_result");
    const ctx = { abort: vi.fn() };
    await handler(
      {
        toolName: "ask_user",
        input: {},
        isError: false,
        content: [{ type: "text", text: "User cancelled the question" }],
        details: { cancelled: true, response: null, cancelReason: "timeout" },
      },
      ctx,
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("does NOT abort on a programmatic signal cancellation", async () => {
    const handler = getHandler("tool_result");
    const ctx = { abort: vi.fn() };
    await handler(
      {
        toolName: "ask_user",
        input: {},
        isError: false,
        content: [{ type: "text", text: "User cancelled the question" }],
        details: { cancelled: true, response: null, cancelReason: "signal" },
      },
      ctx,
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("does NOT abort when the user actually answered", async () => {
    const handler = getHandler("tool_result");
    const ctx = { abort: vi.fn() };
    await handler(
      {
        toolName: "ask_user",
        input: {},
        isError: false,
        content: [{ type: "text", text: "User answered: Alpha" }],
        details: { cancelled: false, response: { kind: "selection", selections: ["Alpha"] } },
      },
      ctx,
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });
});

describe("tool_call Agent routing and spawn-time context injection", () => {
  const tempDirs: string[] = [];

  function makeTaskDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pi-agent-hook-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "USER_REQUEST.md"), "the user request body", "utf-8");
    writeFileSync(join(dir, "RESEARCH.md"), "the research body", "utf-8");
    const artifactsDir = join(dir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "design.md"), "# Design Doc\n\nstuff", "utf-8");
    const plansDir = join(dir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "1_synthesized.md"), "the plan", "utf-8");
    return dir;
  }

  function activeWith(dir: string): ActiveTask {
    const task = makeActiveTask();
    task.dir = dir;
    return task;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a missing subagent_type with a valid-types message", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_call");
    const result = await handler({ toolName: "Agent", input: { prompt: "do a thing" } }, {});
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("subagent_type is required");
  });

  it("blocks an unknown subagent_type instead of collapsing to task", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_call");
    const input: Record<string, unknown> = { subagent_type: "wizard", prompt: "x" };
    const result = await handler({ toolName: "Agent", input }, {});
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Unknown subagent_type "wizard"');
    expect(result?.reason).toContain("deep-debugger");
    // must NOT have been rewritten to task
    expect(input.subagent_type).toBe("wizard");
  });

  it("routes advisor to its own model/thinking and injects context into the prompt", async () => {
    const dir = makeTaskDir();
    orchestrator.active = activeWith(dir);
    const handler = getHandler("tool_call");
    const input: Record<string, unknown> = { subagent_type: "advisor", prompt: "why is this broken" };
    const result = await handler({ toolName: "Agent", input }, {});
    expect(result).toBeUndefined();
    expect(input.subagent_type).toBe("advisor");
    expect(input.thinking).toBe("high");
    const prompt = input.prompt as string;
    expect(prompt).toContain("why is this broken");
    expect(prompt).toContain("=== USER REQUEST ===");
    expect(prompt).toContain("the user request body");
    expect(prompt).toContain("=== RESEARCH ===");
    expect(prompt).toContain("the research body");
    // manifest lists real paths, not inlined content
    expect(prompt).toContain(join(dir, "artifacts", "design.md"));
    expect(prompt).toContain(join(dir, "plans", "1_synthesized.md"));
    expect(prompt).not.toContain("the plan");
  });

  it("maps deep-debugger via bracket-notation config", async () => {
    const dir = makeTaskDir();
    orchestrator.active = activeWith(dir);
    const handler = getHandler("tool_call");
    const input: Record<string, unknown> = { subagent_type: "deep-debugger", prompt: "trace it" };
    const result = await handler({ toolName: "Agent", input }, {});
    expect(result).toBeUndefined();
    expect(input.subagent_type).toBe("deep-debugger");
    expect(input.thinking).toBe("high");
  });

  it("does NOT inject task context into explore spawns", async () => {
    const dir = makeTaskDir();
    orchestrator.active = activeWith(dir);
    const handler = getHandler("tool_call");
    const input: Record<string, unknown> = { subagent_type: "explore", prompt: "find X" };
    const result = await handler({ toolName: "Agent", input }, {});
    expect(result).toBeUndefined();
    expect(input.subagent_type).toBe("explore");
    expect(input.prompt).toBe("find X");
  });
});

describe("main-turn stall watchdog (BUG-2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers a wedged main turn via the idle-gated single-send path", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.config.performance.internals.mainTurnStale = 60000;
    const sendSpy = vi.spyOn(orchestrator, "sendUserMessageWhenIdle").mockImplementation(() => {});
    orchestrator.lastCtx = { isIdle: () => true } as any;

    // A turn starts and then never terminates.
    await getHandler("turn_start")({ type: "turn_start", turnIndex: 0 }, {});
    expect(orchestrator.mainTurnInFlight).toBe(true);

    // Before the threshold: no recovery.
    vi.advanceTimersByTime(30000);
    expect(sendSpy).not.toHaveBeenCalled();

    // Past the threshold with no activity: watchdog fires once.
    vi.advanceTimersByTime(61000);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toContain("stalled without completing");
    expect(orchestrator.mainTurnRecovering).toBe(true);
  });

  it("does not fire while the turn keeps making activity", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.config.performance.internals.mainTurnStale = 60000;
    const sendSpy = vi.spyOn(orchestrator, "sendUserMessageWhenIdle").mockImplementation(() => {});

    await getHandler("turn_start")({ type: "turn_start", turnIndex: 0 }, {});
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30000);
      await getHandler("tool_call")({ toolName: "read", input: { path: "a.ts" } }, {});
    }
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not fire after the turn terminates", async () => {
    orchestrator.active = makeActiveTask();
    orchestrator.config.performance.internals.mainTurnStale = 60000;
    const sendSpy = vi.spyOn(orchestrator, "sendUserMessageWhenIdle").mockImplementation(() => {});

    const ctx = { ui: { setStatus: vi.fn(), setWorkingMessage: vi.fn(), notify: vi.fn() }, isIdle: () => true } as any;
    await getHandler("turn_start")({ type: "turn_start", turnIndex: 0 }, ctx);
    await getHandler("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
    expect(orchestrator.mainTurnInFlight).toBe(false);
    vi.advanceTimersByTime(120000);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("checkoutPrHead", () => {
  function makeGitOrchestrator(script: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      const key = args.join(" ");
      const matched = Object.keys(script).find((k) => key.startsWith(k));
      const res = matched ? script[matched] : { code: 0, stdout: "", stderr: "" };
      return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    });
    return { orchestrator: { pi: { exec } } as any, calls };
  }

  it("is a no-op when no PR head is provided (non-PR review scope)", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({});
    const result = await checkoutPrHead(orchestrator, "/repo", "", "");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("non-PR review scope");
    expect(calls).toHaveLength(0);
  });

  it("HALTs on a dirty working tree without checking out", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: " M src/a.ts\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("uncommitted changes");
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("HALTs when on a different branch, and never runs git checkout", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "othersha\n" },
      "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("feature");
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
  });

  it("fast-forwards a clean branch that is behind the PR head, without checkout or force", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "oldsha\n" },
      "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "feature\n" },
      "merge --ff-only abc123": { code: 0, stdout: "Updating oldsha..abc123\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("fast-forwarded");
    expect(calls.some((c) => c[0] === "merge" && c[1] === "--ff-only" && c[2] === "abc123")).toBe(true);
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("HALTs when the branch has diverged and cannot fast-forward", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "oldsha\n" },
      "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "feature\n" },
      "merge --ff-only abc123": { code: 1, stderr: "fatal: Not possible to fast-forward, aborting." },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HALT");
    expect(result.message).toContain("diverged");
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("succeeds without any checkout or merge when already on the PR head commit", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("on PR head");
    expect(calls.some((c) => c[0] === "checkout" || c[0] === "merge")).toBe(false);
  });

  it("succeeds on a detached HEAD already at the PR head (re-entrant)", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[0] === "checkout" || c[0] === "merge")).toBe(false);
  });

  it("HALTs on a detached HEAD that is not at the PR head", async () => {
    const { orchestrator, calls } = makeGitOrchestrator({
      "status --porcelain": { code: 0, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "oldsha\n" },
      "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
    });
    const result = await checkoutPrHead(orchestrator, "/repo", "feature", "abc123");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("detached HEAD");
    expect(calls.some((c) => c[0] === "checkout" || c[0] === "merge")).toBe(false);
  });
});

describe("pp_checkout_pr_head tool registration", () => {
  it("registers the checkout tool during orchestrator tool setup", async () => {
    const { registerOrchestratorToolsForTest } = await import("./event-handlers.js");
    orchestrator.active = makeActiveTask();
    registerOrchestratorToolsForTest(orchestrator);
    const names = (pi.registerTool as any).mock.calls.map((c: any[]) => c[0].name);
    expect(names).toContain("pp_checkout_pr_head");
  });
});
