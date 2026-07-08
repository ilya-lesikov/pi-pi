import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForCompletion } from "./registry.js";

type Handler = (data?: any) => void;

function makePi() {
  const eventHandlers = new Map<string, Handler[]>();
  return {
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      }),
      emit: vi.fn((name: string, data?: any) => {
        for (const h of eventHandlers.get(name) ?? []) h(data);
      }),
    },
  };
}

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function setManagerRecords(records: Map<string, any>) {
  (globalThis as any)[MANAGER_KEY] = {
    getRecord: (id: string) => records.get(id),
  };
}

describe("waitForCompletion", () => {
  afterEach(() => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.useRealTimers();
  });

  it("resolves when a subagents:completed event fires for the agent", async () => {
    setManagerRecords(new Map([["a1", { status: "running" }]]));
    const pi = makePi();

    const p = waitForCompletion(pi as any, "a1");
    pi.events.emit("subagents:completed", { id: "a1", result: "done", status: "completed" });

    await expect(p).resolves.toEqual({ result: "done", status: "completed" });
  });

  it("rejects when a subagents:failed event fires for the agent", async () => {
    setManagerRecords(new Map([["a1", { status: "running" }]]));
    const pi = makePi();

    const p = waitForCompletion(pi as any, "a1");
    pi.events.emit("subagents:failed", { id: "a1", error: "boom" });

    await expect(p).rejects.toThrow("boom");
  });

  it("resolves immediately from a terminal record when the completion event was missed (race)", async () => {
    // Agent already completed in the gap before we subscribed — no event will
    // ever arrive, but the record carries the terminal result.
    setManagerRecords(new Map([["a1", { status: "completed", result: "late" }]]));
    const pi = makePi();

    await expect(waitForCompletion(pi as any, "a1")).resolves.toEqual({
      result: "late",
      status: "completed",
    });
  });

  it("rejects immediately from a terminal error record when the failure event was missed", async () => {
    setManagerRecords(new Map([["a1", { status: "error", error: "crashed" }]]));
    const pi = makePi();

    await expect(waitForCompletion(pi as any, "a1")).rejects.toThrow("crashed");
  });

  it("rejects with 'not found' only when no record and no event", async () => {
    vi.useFakeTimers();
    setManagerRecords(new Map());
    const pi = makePi();

    const p = waitForCompletion(pi as any, "ghost");
    const assertion = expect(p).rejects.toThrow("agent ghost not found in manager");
    await vi.runOnlyPendingTimersAsync();
    await assertion;
  });

  it("does not reject 'not found' while the agent is still running", async () => {
    vi.useFakeTimers();
    const records = new Map([["a1", { status: "running" }]]);
    setManagerRecords(records);
    const pi = makePi();

    const p = waitForCompletion(pi as any, "a1");
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));

    // Advance one poll interval — still running, must stay pending.
    await vi.advanceTimersByTimeAsync(30000);
    expect(settled).toBe(false);

    // Now it completes via record + a poll tick.
    records.set("a1", { status: "completed", result: "ok" });
    await vi.advanceTimersByTimeAsync(30000);
    await expect(p).resolves.toEqual({ result: "ok", status: "completed" });
  });
});
