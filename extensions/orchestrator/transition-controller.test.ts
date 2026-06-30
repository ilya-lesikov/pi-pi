import { describe, expect, it, vi } from "vitest";
import { TransitionController, type TransitionHost, type MainSession } from "./transition-controller.js";

// Fake host + session: records outbound primitives and lets tests control idle +
// compaction. `controller` is pre-wired with both.
function makeHost(opts: { idle?: boolean; step?: string | null; canCompact?: boolean } = {}) {
  let compactCb: { onComplete?: () => void; onError?: (e: Error) => void } | null = null;
  const calls = {
    userMessages: [] as Array<{ text: string; deliverAs: string }>,
    customMessages: [] as Array<{ customType: string; deliverAs: string }>,
    compactStarted: 0,
  };
  const session: MainSession = {
    sendUserMessage: (text, options) => calls.userMessages.push({ text, deliverAs: options?.deliverAs ?? "" }),
    sendMessage: (message, options) => calls.customMessages.push({ customType: message.customType, deliverAs: options?.deliverAs ?? "" }),
  };
  const host: TransitionHost = {
    compact: (options) => {
      if (opts.canCompact === false) return false;
      calls.compactStarted++;
      compactCb = options;
      return true;
    },
    isIdle: () => opts.idle ?? false,
    currentStep: () => opts.step ?? "llm_work",
  };
  return {
    host,
    session,
    calls,
    controller: new TransitionController(host, session),
    // Simulate the SDK firing the compaction completion event.
    completeCompaction: () => compactCb?.onComplete?.(),
    failCompaction: (msg: string) => compactCb?.onError?.(new Error(msg)),
  };
}

describe("TransitionController.send", () => {
  it("delivers instruction as followUp (always starts a turn)", () => {
    const { host, session, calls } = makeHost();
    const c = new TransitionController(host, session);
    c.send("go", "instruction");
    expect(calls.userMessages).toEqual([{ text: "go", deliverAs: "followUp" }]);
  });

  it("rejects context role (plain user messages always start a turn)", () => {
    const { host, session, calls } = makeHost();
    const c = new TransitionController(host, session);
    expect(() => c.send("ctx", "context")).toThrow(/sendCustom/);
    expect(calls.userMessages).toHaveLength(0);
  });

  it("sendCustom maps roles to delivery modes", () => {
    const { host, session, calls } = makeHost();
    const c = new TransitionController(host, session);
    c.sendCustom({ customType: "pp-context", content: "x", display: false }, "context");
    c.sendCustom({ customType: "pp-artifact", content: "y", display: false }, "instruction");
    expect(calls.customMessages).toEqual([
      { customType: "pp-context", deliverAs: "steer" },
      { customType: "pp-artifact", deliverAs: "followUp" },
    ]);
  });
});

describe("TransitionController.isRunning / shouldBlockAgentStart", () => {
  it("running with llm_work step is running and does not block", () => {
    const { host, session } = makeHost({ step: "llm_work" });
    const c = new TransitionController(host, session);
    expect(c.isRunning()).toBe(true);
    expect(c.shouldBlockAgentStart()).toBe(false);
  });

  it("await_planners and await_reviewers steps are not running (block)", () => {
    for (const step of ["await_planners", "await_reviewers"]) {
      const { host, session } = makeHost({ step });
      const c = new TransitionController(host, session);
      expect(c.isRunning()).toBe(false);
      expect(c.shouldBlockAgentStart()).toBe(true);
    }
  });

  it("gateAgentStart aborts and reports when not running, no-op when running", () => {
    const running = makeHost({ step: "llm_work" });
    const rc = new TransitionController(running.host, running.session);
    const abort1 = vi.fn();
    expect(rc.gateAgentStart(abort1)).toBe(false);
    expect(abort1).not.toHaveBeenCalled();

    const waiting = makeHost({ step: "await_planners" });
    const wc = new TransitionController(waiting.host, waiting.session);
    const abort2 = vi.fn();
    expect(wc.gateAgentStart(abort2)).toBe(true);
    expect(abort2).toHaveBeenCalledOnce();
  });

  it("abortMainAgent issues the abort (controller-owned cleanup abort)", () => {
    const { controller } = makeHost();
    const abort = vi.fn();
    controller.abortMainAgent(abort);
    expect(abort).toHaveBeenCalledOnce();
    expect(() => controller.abortMainAgent(undefined)).not.toThrow();
  });
});

describe("TransitionController phase transition flow", () => {
  it("waits for agent_end when not idle, then compacts and resumes", async () => {
    const { host, session, calls, completeCompaction } = makeHost({ idle: false });
    const c = new TransitionController(host, session);
    const onResume = vi.fn();
    const p = c.requestTransition({ kind: "phase", summary: "s", onResume, instruction: "Begin working." });
    expect(c.getState()).toBe("pending");
    expect(calls.compactStarted).toBe(0); // not idle -> waits

    c.onAgentEnd();
    expect(c.getState()).toBe("compacting");
    expect(calls.compactStarted).toBe(1);

    completeCompaction();
    await p;
    expect(onResume).toHaveBeenCalledOnce();
    expect(c.getState()).toBe("running");
    expect(calls.userMessages).toEqual([{ text: "Begin working.", deliverAs: "followUp" }]);
  });

  it("already-idle path compacts immediately without agent_end", async () => {
    const { host, session, calls, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host, session);
    const p = c.requestTransition({ kind: "done", summary: "done" });
    expect(c.getState()).toBe("compacting");
    expect(calls.compactStarted).toBe(1);
    completeCompaction();
    await p;
    expect(c.getState()).toBe("running");
  });

  it("treats compact no-op errors as a clean resume", async () => {
    for (const msg of ["Nothing to compact (session too small)", "Already compacted"]) {
      const { host, session, failCompaction } = makeHost({ idle: true });
      const c = new TransitionController(host, session);
      const onResume = vi.fn();
      const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
      failCompaction(msg);
      await p;
      expect(onResume).toHaveBeenCalledOnce();
      expect(c.getState()).toBe("running");
    }
  });

  it("resumes via session_compact event", async () => {
    const { host, session } = makeHost({ idle: false });
    const c = new TransitionController(host, session);
    const onResume = vi.fn();
    const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
    c.onAgentEnd();
    c.onSessionCompact();
    await p;
    expect(onResume).toHaveBeenCalledOnce();
    expect(c.getState()).toBe("running");
  });

  it("ignores agent_end while running (no self-trigger loop)", () => {
    const { host, session, calls } = makeHost({ idle: false });
    const c = new TransitionController(host, session);
    c.onAgentEnd();
    c.onAgentEnd();
    expect(calls.compactStarted).toBe(0);
    expect(c.getState()).toBe("running");
  });

  it("ignores session_compact while running (no spurious resume)", () => {
    const { host, session, calls } = makeHost();
    const c = new TransitionController(host, session);
    c.onSessionCompact();
    expect(calls.userMessages).toHaveLength(0);
    expect(c.getState()).toBe("running");
  });

  it("resolves the awaitable even when no live ctx can compact", async () => {
    const { host, session, calls } = makeHost({ idle: true, canCompact: false });
    const c = new TransitionController(host, session);
    const onResume = vi.fn();
    await c.requestTransition({ kind: "done", onResume });
    expect(onResume).toHaveBeenCalledOnce();
    expect(calls.compactStarted).toBe(0);
    expect(c.getState()).toBe("running");
  });

  it("does not send an instruction when none is provided (await_planners notify-only)", async () => {
    const { host, session, calls, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host, session);
    const p = c.requestTransition({ kind: "phase", onResume: () => {} });
    completeCompaction();
    await p;
    expect(calls.userMessages).toHaveLength(0);
  });

  it("compaction completion is idempotent across onComplete and session_compact", async () => {
    const { host, session, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host, session);
    const onResume = vi.fn();
    const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
    completeCompaction();
    c.onSessionCompact(); // second terminus — must be a no-op
    await p;
    expect(onResume).toHaveBeenCalledOnce();
  });
});
