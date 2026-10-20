import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDelivery } from "./delivery.js";
import { WorkerHold, unfinishedSummary } from "./hold.js";
import { WorkerManager } from "./manager.js";
import type { WorkerSession, WorkerSessionHooks } from "./types.js";

function setup() {
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(): void }> = [];
  const manager = new WorkerManager({
    createSession: async (_spec, hooks) => {
      let resolve: () => void = () => {};
      sessions.push({ hooks, finish: () => resolve() });
      const session: WorkerSession = {
        run: () => new Promise<void>((done) => { resolve = done; }),
        steer() {},
        interruptTool: () => false,
        abort() { resolve(); },
        dispose() {},
        setModel: async () => true,
        lastAssistantText: () => "done",
        lastError: () => undefined,
        contextPercent: () => undefined,
        transcript: () => [],
      };
      return session;
    },
    maxConcurrent: () => 4,
    stallWarnMs: () => 0,
  });
  const sent: any[] = [];
  let streaming = true;
  const delivery = new WorkerDelivery({
    isStreaming: () => streaming,
    canWake: () => false,
    send: (message, options) => sent.push({ message, options }),
    now: () => Date.now(),
  });
  manager.subscribe((event) => {
    if (event.type === "settled") delivery.enqueue({ kind: "settled", record: event.record });
    if (event.type === "question") delivery.enqueue({ kind: "question", record: event.record });
  });
  const spawn = () => manager.spawn({ type: "explore", description: "look", prompt: "p", model: "p/m", thinking: "high", notify: "wake" });
  return { manager, delivery, sessions, sent, spawn, setStreaming: (value: boolean) => { streaming = value; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("WorkerHold", () => {
  it("settles at once when no worker is active", async () => {
    const { manager, delivery } = setup();
    expect(await new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 1000 })).toBe("settled");
  });

  it("waits for a running worker and yields once its result is in the run", async () => {
    const { manager, delivery, sessions, sent, spawn } = setup();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5000);
    sessions[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toBe("yield");
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ deliverAs: "steer" });
  });

  it("yields without waiting when an update is already in the run", async () => {
    const { manager, delivery, sessions, spawn } = setup();
    spawn();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(delivery.inFlightCount()).toBe(1);
    expect(await new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 60_000 })).toBe("yield");
  });

  it("releases for an abort, for a message the user submitted, and for a worker's question", async () => {
    const { manager, delivery, sessions, spawn } = setup();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const aborted = new WorkerHold().wait({ manager, delivery, signal: controller.signal, hasPendingMessages: () => false, idleMs: 60_000 });
    controller.abort();
    expect(await aborted).toBe("released");
    let typed = false;
    const pending = new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => typed, idleMs: 60_000 });
    typed = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toBe("released");
    const asking = new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 60_000 });
    void sessions[0]!.hooks.askParent("which db?", undefined);
    await vi.advanceTimersByTimeAsync(300);
    expect(await asking).not.toBe("idle");
  });

  it("times out only after the idle limit with no activity, resetting on worker events", async () => {
    const { manager, delivery, sessions, spawn } = setup();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    const hold = new WorkerHold();
    let outcome: string | undefined;
    void hold.wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 10_000 }).then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(8000);
    sessions[0]!.hooks.onToolStart("read", "a.ts");
    await vi.advanceTimersByTimeAsync(8000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(outcome).toBe("idle");
  });
});

describe("unfinishedSummary", () => {
  it("names each unfinished worker and asks for the full answer again", () => {
    const text = unfinishedSummary([{ id: "explore-1", spec: { type: "explore", description: "look" }, status: "running", progress: "half way", step: { label: "running read a.ts" } } as any]);
    expect(text).toContain("- explore-1 (explore: look) — running; last progress: half way; was running read a.ts");
    expect(text).toContain("Restate your complete final answer");
  });
});
