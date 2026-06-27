import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingPlannotatorWait,
  openPlannotator,
  waitForPlannotatorResult,
} from "./plannotator.js";
import type { Orchestrator } from "./orchestrator.js";

type Handler = (data: any) => void;

function makeEvents() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    on(name: string, fn: Handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return () => handlers.get(name)!.delete(fn);
    },
    emit(name: string, data: any) {
      for (const fn of handlers.get(name) ?? []) fn(data);
    },
  };
}

function makeOrchestrator(events: ReturnType<typeof makeEvents>): Orchestrator {
  return {
    pi: { events },
    plannotatorReject: null,
    plannotatorUnsub: null,
    plannotatorTimer: null,
  } as unknown as Orchestrator;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForPlannotatorResult", () => {
  it("resolves when a matching review-result arrives", async () => {
    const events = makeEvents();
    const orch = makeOrchestrator(events);
    const p = waitForPlannotatorResult(orch, "rev-1");
    events.emit("plannotator:review-result", { reviewId: "rev-1", approved: true, feedback: "ok" });
    await expect(p).resolves.toEqual({ approved: true, feedback: "ok" });
    expect(orch.plannotatorTimer).toBeNull();
  });

  it("rejects on timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const events = makeEvents();
    const orch = makeOrchestrator(events);
    const p = waitForPlannotatorResult(orch, "rev-1");
    const assertion = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    await assertion;
    expect(orch.plannotatorTimer).toBeNull();
  });

  it("can be cancelled on task switch/done", async () => {
    const events = makeEvents();
    const orch = makeOrchestrator(events);
    const p = waitForPlannotatorResult(orch, "rev-1");
    const assertion = expect(p).rejects.toThrow("cancelled");
    cancelPendingPlannotatorWait(orch);
    await assertion;
    expect(orch.plannotatorTimer).toBeNull();
    expect(orch.plannotatorUnsub).toBeNull();
  });
});

describe("openPlannotator", () => {
  it("clears its timeout after respond so no late side effect fires", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const events = makeEvents();
    events.on("plannotator:request", (req: any) => {
      req.respond({ status: "handled", result: { reviewId: "rev-9" } });
    });
    const pi = { events } as any;
    const result = await openPlannotator(pi, "open", {});
    expect(result).toEqual({ opened: true, reviewId: "rev-9" });
    expect(clearSpy).toHaveBeenCalled();
  });
});
