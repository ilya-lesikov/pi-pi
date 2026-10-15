import { describe, expect, it, vi } from "vitest";
import { WorkerDelivery, WORKER_MESSAGE_TYPE, type DeliveryHost } from "./delivery.js";
import type { WorkerRecord } from "./types.js";

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: "explore-1",
    spec: { type: "explore", description: "find x", prompt: "p", model: "p/m", thinking: "high", notify: "wake" },
    status: "completed",
    createdAt: 0,
    startedAt: 0,
    settledAt: 5_000,
    lastEventAt: 5_000,
    turns: 2,
    toolUses: 3,
    lastText: "",
    result: { status: "done", summary: "found x", body: "x is at a.ts:1" },
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

function host(overrides: Partial<DeliveryHost> = {}) {
  const sent: Array<{ message: any; options: any }> = [];
  const value: DeliveryHost = {
    isStreaming: () => false,
    canWake: () => true,
    send: (message, options) => { sent.push({ message, options }); },
    now: () => 10_000,
    ...overrides,
  };
  return { host: value, sent };
}

describe("WorkerDelivery", () => {
  it("steers a busy parent at its next tool-batch boundary", () => {
    const { host: h, sent } = host({ isStreaming: () => true });
    const delivery = new WorkerDelivery(h);
    delivery.enqueue({ kind: "settled", record: record() });
    delivery.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer" });
    expect(sent[0]!.message.customType).toBe(WORKER_MESSAGE_TYPE);
    expect(sent[0]!.message.content).toContain("found x");
  });

  it("wakes an idle parent with one message for everything ready", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    const a = record({ id: "a" });
    const b = record({ id: "b" });
    delivery.enqueue({ kind: "settled", record: a });
    delivery.enqueue({ kind: "settled", record: b });
    delivery.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ triggerTurn: true });
    expect(sent[0]!.message.details.items.map((item: any) => item.id)).toEqual(["a", "b"]);
    expect(a.undelivered).toBe(false);
  });

  it("holds the wake while the user is mid-dialog and retries", () => {
    vi.useFakeTimers();
    try {
      let canWake = false;
      const { host: h, sent } = host({ canWake: () => canWake });
      const delivery = new WorkerDelivery(h, { pollMs: 100 });
      delivery.enqueue({ kind: "settled", record: record() });
      delivery.flush();
      expect(sent).toHaveLength(0);
      canWake = true;
      vi.advanceTimersByTime(150);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not push what a wait already handed over", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    const r = record();
    delivery.enqueue({ kind: "settled", record: r });
    r.undelivered = false;
    delivery.flush();
    expect(sent).toHaveLength(0);
  });

  it("holds a settlement while a wait covers the worker", () => {
    vi.useFakeTimers();
    try {
      const { host: h, sent } = host();
      const delivery = new WorkerDelivery(h, { pollMs: 100 });
      const r = record({ waitHolds: 1 });
      delivery.enqueue({ kind: "settled", record: r });
      delivery.flush();
      expect(sent).toHaveLength(0);
      r.waitHolds = 0;
      r.undelivered = false;
      vi.advanceTimersByTime(150);
      expect(sent).toHaveLength(0);
      expect(delivery.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a question that was answered before delivery", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    const r = record({ status: "running", question: { id: "q", text: "?", askedAt: 0 } });
    delivery.enqueue({ kind: "question", record: r });
    r.question = undefined;
    delivery.flush();
    expect(sent).toHaveLength(0);
  });

  it("delivers a silent worker's result without waking the parent", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    delivery.enqueue({ kind: "settled", record: record({ spec: { ...record().spec, notify: "silent" } }) });
    delivery.flush();
    expect(sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
  });

  it("wakes for a question even when other items are silent", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    delivery.enqueue({ kind: "settled", record: record({ id: "s", spec: { ...record().spec, notify: "silent" } }) });
    delivery.enqueue({ kind: "question", record: record({ id: "q", status: "running", question: { id: "q1", text: "which?", askedAt: 0 } }) });
    delivery.flush();
    expect(sent[0]!.options).toEqual({ triggerTurn: true });
    expect(sent[0]!.message.content).toContain("which?");
  });

  it("puts findings and errors in front of the model and truncates a long body", () => {
    const { host: h, sent } = host();
    const delivery = new WorkerDelivery(h);
    delivery.enqueue({ kind: "settled", record: record({ id: "r", result: { status: "done", summary: "2 issues", body: "y".repeat(10_000), findings: [{ severity: "major", location: "a.ts:3", issue: "race" }] } }) });
    delivery.enqueue({ kind: "settled", record: record({ id: "f", status: "failed", error: "429 too many requests", result: undefined }) });
    delivery.flush();
    const content = sent[0]!.message.content as string;
    expect(content).toContain("[major] a.ts:3: race");
    expect(content).toContain("truncated");
    expect(content).toContain("Error: 429 too many requests");
    expect(sent[0]!.message.details.items[0]).toMatchObject({ findings: 1, seriousFindings: 1 });
  });
});
