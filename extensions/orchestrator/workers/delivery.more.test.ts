import { describe, expect, it } from "vitest";
import { WorkerDelivery, formatDuration, renderForModel } from "./delivery.js";
import type { WorkerRecord } from "./types.js";

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: "w-1",
    spec: { type: "explore", description: 'say "hi" <b> & go', prompt: "p", model: "p/m", thinking: "high", notify: "wake" },
    status: "completed",
    createdAt: 0,
    startedAt: 0,
    settledAt: 5_000,
    lastEventAt: 5_000,
    turns: 1,
    toolUses: 0,
    lastText: "",
    outputTail: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    runUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    modelId: "p/m",
    runs: 1,
    undelivered: true,
    waitHolds: 0,
    stallWarned: false,
    ...overrides,
  };
}

describe("worker delivery — more", () => {
  it("says a worker produced nothing, in plain text a host can show as is", () => {
    const out = renderForModel([{ kind: "settled", record: record() }], 0);
    expect(out).toContain('w-1 · explore · say "hi" <b> & go');
    expect(out).not.toMatch(/<\/?worker/);
    expect(out).toContain("No output.");
  });

  it("names the tool a silent worker is stuck in, and reports how long", () => {
    const stuck = record({ status: "running", lastEventAt: 0, activity: { toolName: "bash", summary: "sleep 9", startedAt: 0 } });
    expect(renderForModel([{ kind: "stall", record: stuck }], 3_600_000)).toContain('· silent for 1h\nNo activity from this worker (in bash: sleep 9).');
    expect(renderForModel([{ kind: "stall", record: record({ status: "running" }) }], 5_000)).toContain("No activity from this worker. Inspect");
  });

  it("sends stall details and drops a stall that resolved before delivery", () => {
    const sent: any[] = [];
    const delivery = new WorkerDelivery({ isStreaming: () => false, canWake: () => true, send: (message) => sent.push(message), now: () => 65_000 });
    const silent = record({ status: "running", stallWarned: true, lastEventAt: 5_000 });
    const recovered = record({ id: "w-2", status: "running", stallWarned: false });
    delivery.enqueue({ kind: "stall", record: silent });
    delivery.enqueue({ kind: "stall", record: recovered });
    delivery.enqueue({ kind: "stall", record: silent });
    expect(delivery.pending()).toBe(2);
    delivery.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].details.items).toEqual([{ kind: "stall", id: "w-1", type: "explore", description: 'say "hi" <b> & go', status: "running", summary: "", toolUses: 0, silentMs: 60_000 }]);
  });

  it("formats durations across units", () => {
    expect([formatDuration(-5), formatDuration(59_400), formatDuration(60_000), formatDuration(61_000), formatDuration(7_200_000), formatDuration(7_260_000)]).toEqual(["0s", "59s", "1m", "1m1s", "2h", "2h1m"]);
  });
});
