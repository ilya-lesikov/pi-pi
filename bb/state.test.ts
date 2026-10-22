import { describe, expect, it } from "vitest";
import { piNow, shownWorkers, staleness, taskSummary, workerActivity, workerElapsed, type BbState, type BbWorker } from "./state.js";

function worker(overrides: Partial<BbWorker> = {}): BbWorker {
  return { id: "explore-1", type: "explore", description: "d", prompt: "p", status: "running", model: "m", createdAt: 0, startedAt: 0, lastEventAt: 5000, silent: false, toolUses: 0, tokens: 0, outputTail: "", ...overrides };
}

function state(overrides: Partial<BbState> = {}): BbState {
  return { version: 1, pid: 1, live: true, heartbeatAt: 0, tasks: [], workers: [worker()], commandResults: [], ...overrides };
}

describe("bb plugin state", () => {
  it("stops trusting the file once pi's session ended or its heartbeat stopped moving", () => {
    expect(staleness(state(), 1000)).toBeNull();
    expect(staleness(state(), 60_000)).toBe("unresponsive");
    expect(staleness(state({ live: false }), 0)).toBe("ended");
  });

  it("shows nothing as still running or asking once pi is gone", () => {
    const running = worker({ step: { label: "running bash", since: 0 } });
    const asking = worker({ id: "explore-2", question: "which one?" });
    const done = worker({ id: "explore-3", status: "completed", settledAt: 9000, result: { status: "done", summary: "found it", body: "" } });
    const current = state({ workers: [running, asking, done] });
    expect(shownWorkers(current, null)).toBe(current.workers);
    const shown = shownWorkers(current, "ended");
    expect(shown.map((entry) => [entry.status, entry.question, entry.settledAt])).toEqual([["stopped", undefined, 5000], ["stopped", undefined, 5000], ["completed", undefined, 9000]]);
    expect(shown.map((entry) => workerActivity(entry, 0))).toEqual(["pi stopped", "pi stopped", "found it"]);
  });

  it("times workers on pi's clock, which may differ from the reader's", () => {
    // pi's clock is an hour behind the reader's: its last heartbeat, at 10s on its clock, was seen 2s ago.
    const hourAhead = 3_600_000;
    const now = piNow(state({ heartbeatAt: 10_000 }), hourAhead + 20_000, hourAhead + 22_000);
    expect(now).toBe(12_000);
    expect(workerElapsed(worker({ startedAt: 2000 }), now)).toBe("10s");
  });

  it("summarizes the checklist only while something is left to do", () => {
    expect(taskSummary([{ id: "1", subject: "a", status: "completed" }])).toBeNull();
    expect(taskSummary([{ id: "1", subject: "a", status: "completed" }, { id: "2", subject: "b", status: "in_progress", activeForm: "Doing b" }])).toEqual({ done: 1, total: 2, current: "Doing b" });
  });
});
