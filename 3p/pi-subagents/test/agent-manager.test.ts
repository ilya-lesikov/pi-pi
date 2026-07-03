import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — first_tool/first_turn emission (all spawn paths)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  // Drive the callbacks runAgent would fire, so we can assert the manager emits
  // the first_tool/first_turn events centrally (RPC panels use this same path).
  const runAgentDrivingCallbacks = () =>
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onToolActivity?.({ type: "start", toolName: "read" });
      opts.onToolActivity?.({ type: "start", toolName: "grep" }); // second tool: must NOT re-emit
      opts.onToolActivity?.({ type: "end", toolName: "read" });
      opts.onTurnEnd?.(1);
      opts.onTurnEnd?.(2); // second turn: must NOT re-emit
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

  it("emits subagents:first_tool and subagents:first_turn exactly once each", async () => {
    const emit = vi.fn();
    const piWithEvents = { events: { emit } } as any;
    manager = new AgentManager();
    runAgentDrivingCallbacks();

    const id = manager.spawn(piWithEvents, mockCtx, "general-purpose", "test", {
      description: "panel-like agent",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const firstTool = emit.mock.calls.filter((c) => c[0] === "subagents:first_tool");
    const firstTurn = emit.mock.calls.filter((c) => c[0] === "subagents:first_turn");
    expect(firstTool).toHaveLength(1);
    expect(firstTurn).toHaveLength(1);
    expect(firstTool[0][1]).toMatchObject({ id, type: "general-purpose", toolName: "read" });
    expect(firstTurn[0][1]).toMatchObject({ id, type: "general-purpose", turnCount: 1 });
  });

  it("also emits for foreground agents (spawnAndWait)", async () => {
    const emit = vi.fn();
    const piWithEvents = { events: { emit } } as any;
    manager = new AgentManager();
    runAgentDrivingCallbacks();

    await manager.spawnAndWait(piWithEvents, mockCtx, "general-purpose", "test", {
      description: "fg agent",
    });

    expect(emit.mock.calls.filter((c) => c[0] === "subagents:first_tool")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "subagents:first_turn")).toHaveLength(1);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});


describe("AgentWidget linger behavior", () => {
  it("keeps completed agents visible for an extra turn", async () => {
    const { AgentWidget } = await import("../src/ui/agent-widget.js");
    const manager = new AgentManager();
    const agentActivity = new Map();
    const widget = new AgentWidget(manager, agentActivity);
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    widget.setUICtx({ setStatus, setWidget } as any);

    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    widget.markFinished(id);

    expect((widget).shouldShowFinished(id, "completed")).toBe(true);
    widget.onTurnStart();
    expect((widget).shouldShowFinished(id, "completed")).toBe(true);
    widget.onTurnStart();
    expect((widget).shouldShowFinished(id, "completed")).toBe(false);

    manager.dispose();
  });
});
