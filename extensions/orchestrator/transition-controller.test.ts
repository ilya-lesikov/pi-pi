import { describe, expect, it, vi } from "vitest";
import { TransitionController, type TransitionHost } from "./transition-controller.js";

// Fake host: records outbound primitives and lets tests control idle + compaction.
function makeHost(opts: { idle?: boolean; step?: string | null; canCompact?: boolean } = {}) {
  let compactCb: { onComplete?: () => void; onError?: (e: Error) => void } | null = null;
  const calls = {
    userMessages: [] as Array<{ text: string; deliverAs: string }>,
    customMessages: [] as Array<{ customType: string; deliverAs: string }>,
    compactStarted: 0,
  };
  const host: TransitionHost = {
    rawSendUserMessage: (text, deliverAs) => calls.userMessages.push({ text, deliverAs }),
    rawSendMessage: (message, deliverAs) => calls.customMessages.push({ customType: message.customType, deliverAs }),
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
    calls,
    // Simulate the SDK firing the compaction completion event.
    completeCompaction: () => compactCb?.onComplete?.(),
    failCompaction: (msg: string) => compactCb?.onError?.(new Error(msg)),
  };
}

describe("TransitionController.send", () => {
  it("delivers context as steer and instruction as followUp", () => {
    const { host, calls } = makeHost();
    const c = new TransitionController(host);
    c.send("ctx", "context");
    c.send("go", "instruction");
    expect(calls.userMessages).toEqual([
      { text: "ctx", deliverAs: "steer" },
      { text: "go", deliverAs: "followUp" },
    ]);
  });

  it("sendCustom maps roles to delivery modes", () => {
    const { host, calls } = makeHost();
    const c = new TransitionController(host);
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
    const { host } = makeHost({ step: "llm_work" });
    const c = new TransitionController(host);
    expect(c.isRunning()).toBe(true);
    expect(c.shouldBlockAgentStart()).toBe(false);
  });

  it("await_planners and await_reviewers steps are not running (block)", () => {
    for (const step of ["await_planners", "await_reviewers"]) {
      const { host } = makeHost({ step });
      const c = new TransitionController(host);
      expect(c.isRunning()).toBe(false);
      expect(c.shouldBlockAgentStart()).toBe(true);
    }
  });
});

describe("TransitionController phase transition flow", () => {
  it("waits for agent_end when not idle, then compacts and resumes", async () => {
    const { host, calls, completeCompaction } = makeHost({ idle: false });
    const c = new TransitionController(host);
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
    const { host, calls, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host);
    const p = c.requestTransition({ kind: "done", summary: "done" });
    expect(c.getState()).toBe("compacting");
    expect(calls.compactStarted).toBe(1);
    completeCompaction();
    await p;
    expect(c.getState()).toBe("running");
  });

  it("treats compact no-op errors as a clean resume", async () => {
    for (const msg of ["Nothing to compact (session too small)", "Already compacted"]) {
      const { host, failCompaction } = makeHost({ idle: true });
      const c = new TransitionController(host);
      const onResume = vi.fn();
      const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
      failCompaction(msg);
      await p;
      expect(onResume).toHaveBeenCalledOnce();
      expect(c.getState()).toBe("running");
    }
  });

  it("resumes via session_compact event", async () => {
    const { host } = makeHost({ idle: false });
    const c = new TransitionController(host);
    const onResume = vi.fn();
    const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
    c.onAgentEnd();
    c.onSessionCompact();
    await p;
    expect(onResume).toHaveBeenCalledOnce();
    expect(c.getState()).toBe("running");
  });

  it("ignores agent_end while running (no self-trigger loop)", () => {
    const { host, calls } = makeHost({ idle: false });
    const c = new TransitionController(host);
    c.onAgentEnd();
    c.onAgentEnd();
    expect(calls.compactStarted).toBe(0);
    expect(c.getState()).toBe("running");
  });

  it("ignores session_compact while running (no spurious resume)", () => {
    const { host, calls } = makeHost();
    const c = new TransitionController(host);
    c.onSessionCompact();
    expect(calls.userMessages).toHaveLength(0);
    expect(c.getState()).toBe("running");
  });

  it("resolves the awaitable even when no live ctx can compact", async () => {
    const { host, calls } = makeHost({ idle: true, canCompact: false });
    const c = new TransitionController(host);
    const onResume = vi.fn();
    await c.requestTransition({ kind: "done", onResume });
    expect(onResume).toHaveBeenCalledOnce();
    expect(calls.compactStarted).toBe(0);
    expect(c.getState()).toBe("running");
  });

  it("does not send an instruction when none is provided (await_planners notify-only)", async () => {
    const { host, calls, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host);
    const p = c.requestTransition({ kind: "phase", onResume: () => {} });
    completeCompaction();
    await p;
    expect(calls.userMessages).toHaveLength(0);
  });

  it("compaction completion is idempotent across onComplete and session_compact", async () => {
    const { host, completeCompaction } = makeHost({ idle: true });
    const c = new TransitionController(host);
    const onResume = vi.fn();
    const p = c.requestTransition({ kind: "phase", onResume, instruction: "go" });
    completeCompaction();
    c.onSessionCompact(); // second terminus — must be a no-op
    await p;
    expect(onResume).toHaveBeenCalledOnce();
  });
});
