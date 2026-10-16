import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAcpState, isAcpMode, PP_ACP_STATE_TYPE, publishAcpState, resetAcpStateCache } from "./acp.js";

function fakeOrchestrator(overrides: Record<string, any> = {}): any {
  const records = overrides.records ?? [];
  return {
    configError: null,
    duplicateExtensionError: false,
    interactivePromptOpen: false,
    mainTurnInFlight: false,
    workers: { list: () => records },
    hasActiveWorkers: () => records.some((r: any) => r.status === "queued" || r.status === "running"),
    lastCtx: { sessionManager: { getSessionId: () => overrides.sessionId ?? "s1" } },
    pi: { appendEntry: vi.fn() },
    ...overrides,
  };
}

function record(id: string, status: string, description = ""): any {
  return { id, status, spec: { type: "task", description } };
}

describe("buildAcpState", () => {
  it("maps every worker status onto the ACP subagent vocabulary", () => {
    const state = buildAcpState(fakeOrchestrator({
      records: [
        record("a", "queued", "fix the bug"),
        record("b", "running"),
        record("c", "completed"),
        record("d", "killed"),
        record("e", "idle"),
      ],
    }));
    expect(state.subagents).toEqual([
      { id: "a", label: "fix the bug", status: "pending" },
      { id: "b", label: "task", status: "in_progress" },
      { id: "c", label: "task", status: "completed" },
      { id: "d", label: "task", status: "failed" },
      { id: "e", label: "task", status: "failed" },
    ]);
    expect(state.status).toBe("running");
  });

  it("is idle with no work and no workers manager", () => {
    expect(buildAcpState(fakeOrchestrator({ workers: null, hasActiveWorkers: () => false }))).toEqual({ status: "idle", subagents: [] });
  });

  it("is running while the main turn is in flight", () => {
    expect(buildAcpState(fakeOrchestrator({ mainTurnInFlight: true })).status).toBe("running");
  });

  it("is waiting while an interactive prompt is open", () => {
    expect(buildAcpState(fakeOrchestrator({ interactivePromptOpen: true, mainTurnInFlight: true })).status).toBe("waiting");
  });

  it("is failed on a config error or a duplicate extension, over everything else", () => {
    expect(buildAcpState(fakeOrchestrator({ configError: "bad", interactivePromptOpen: true })).status).toBe("failed");
    expect(buildAcpState(fakeOrchestrator({ duplicateExtensionError: true })).status).toBe("failed");
  });
});

describe("publishAcpState", () => {
  const saved = process.env.PI_ACP;

  beforeEach(() => {
    process.env.PI_ACP = "1";
    resetAcpStateCache();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PI_ACP;
    else process.env.PI_ACP = saved;
  });

  it("does nothing outside ACP mode", () => {
    delete process.env.PI_ACP;
    expect(isAcpMode()).toBe(false);
    const orchestrator = fakeOrchestrator();
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("appends a state entry only when the state changes", () => {
    const orchestrator = fakeOrchestrator();
    publishAcpState(orchestrator);
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledWith(PP_ACP_STATE_TYPE, { status: "idle", subagents: [] });
    orchestrator.mainTurnInFlight = true;
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenLastCalledWith(PP_ACP_STATE_TYPE, { status: "running", subagents: [] });
  });

  it("dedupes per session, and re-publishes after that session's cache is reset", () => {
    const a = fakeOrchestrator({ sessionId: "A" });
    const b = fakeOrchestrator({ sessionId: "B" });
    publishAcpState(a);
    publishAcpState(b);
    expect(b.pi.appendEntry).toHaveBeenCalledTimes(1);
    resetAcpStateCache("A");
    publishAcpState(a);
    publishAcpState(b);
    expect(a.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(b.pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a default session key without a session manager", () => {
    const orchestrator = fakeOrchestrator({ lastCtx: null });
    publishAcpState(orchestrator);
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("retries a state whose append failed instead of treating it as delivered", () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.pi.appendEntry.mockImplementationOnce(() => { throw new Error("closed"); });
    publishAcpState(orchestrator);
    publishAcpState(orchestrator);
    expect(orchestrator.pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("publishes through an explicitly given pi", () => {
    const orchestrator = fakeOrchestrator();
    const pi: any = { appendEntry: vi.fn() };
    publishAcpState(orchestrator, pi);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(orchestrator.pi.appendEntry).not.toHaveBeenCalled();
  });
});
