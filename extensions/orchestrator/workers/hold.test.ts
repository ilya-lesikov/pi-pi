import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDelivery } from "./delivery.js";
import { WorkerHold, unfinishedSummary } from "./hold.js";
import { WorkerManager } from "./manager.js";
import type { WorkerSession, WorkerSessionHooks } from "./types.js";

function setup(stallWarnMs = 0) {
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
    stallWarnMs: () => stallWarnMs,
    tickMs: 100,
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
    if (event.type === "stall_warning") delivery.enqueue({ kind: "stall", record: event.record });
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
    // The question goes into the run as an update, which is what the agent must see to answer it.
    expect(await asking).toBe("yield");
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

describe("WorkerHold, round two", () => {
  it("yields for a stall warning instead of waiting out the idle limit", async () => {
    const { manager, delivery, sessions, sent, spawn } = setup(5000);
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.hooks.onEvent();
    let outcome: string | undefined;
    void new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 60 * 60_000 }).then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(7000);
    expect(outcome).toBe("yield");
    expect(sent.at(-1).message.details.items[0].kind).toBe("stall");
  });

  it("keeps waiting while a failed worker's recovery is undecided", async () => {
    const { manager, delivery } = setup();
    let recovering = 1;
    let outcome: string | undefined;
    void new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 60_000, recovering: () => recovering }).then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(outcome).toBeUndefined();
    recovering = 0;
    await vi.advanceTimersByTimeAsync(600);
    expect(outcome).toBe("settled");
  });

  it("counts a worker's streaming as activity even when it raises no event", async () => {
    const { manager, delivery, sessions, spawn } = setup();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    let outcome: string | undefined;
    void new WorkerHold().wait({ manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 10_000 }).then((value) => { outcome = value; });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      sessions[0]!.hooks.onOutput("still thinking");
    }
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome).toBe("idle");
  });
});

describe("WorkerHold idle clock", () => {
  it("does not wait the whole limit again on the next turn after timing out", async () => {
    const { manager, delivery, spawn } = setup();
    spawn();
    await vi.advanceTimersByTimeAsync(0);
    const hold = new WorkerHold();
    const host = { manager, delivery, signal: undefined, hasPendingMessages: () => false, idleMs: 10_000 };
    const first = hold.wait(host);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await first).toBe("idle");
    let second: string | undefined;
    void hold.wait(host).then((value) => { second = value; });
    await vi.advanceTimersByTimeAsync(600);
    expect(second).toBe("idle");
    hold.touch();
    let third: string | undefined;
    void hold.wait(host).then((value) => { third = value; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(third).toBeUndefined();
  });
});
