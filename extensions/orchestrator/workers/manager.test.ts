import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerManager, type WorkerManagerOptions } from "./manager.js";
import type { WorkerSession, WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";

interface FakeSession extends WorkerSession {
  hooks: WorkerSessionHooks;
  runs: string[];
  steers: string[];
  finishRun(text?: string): void;
  failRun(error: Error): void;
  aborted: number;
  disposed: number;
  interrupted: number;
}

function fakeFactory(behaviour: { hangAbort?: boolean; error?: string } = {}) {
  const sessions: FakeSession[] = [];
  const factory = vi.fn(async (_spec: WorkerSpawnSpec, hooks: WorkerSessionHooks) => {
    let resolveRun: (() => void) | null = null;
    let rejectRun: ((error: Error) => void) | null = null;
    let text = "";
    const session: FakeSession = {
      hooks,
      runs: [],
      steers: [],
      aborted: 0,
      disposed: 0,
      interrupted: 0,
      run(prompt) {
        session.runs.push(prompt);
        return new Promise<void>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
      },
      finishRun(next = "done") {
        text = next;
        hooks.onText(next);
        resolveRun?.();
      },
      failRun(error) {
        rejectRun?.(error);
      },
      steer(message) { session.steers.push(message); },
      interruptTool() { session.interrupted++; return true; },
      // A wedged session: abort never makes run() settle.
      abort() { session.aborted++; if (!behaviour.hangAbort) resolveRun?.(); },
      dispose() { session.disposed++; },
      async setModel() { return true; },
      lastAssistantText: () => text,
      lastError: () => behaviour.error,
      contextPercent: () => undefined,
      transcript: () => [],
    };
    sessions.push(session);
    return session;
  });
  return { factory, sessions };
}

function spec(overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec {
  return { type: "explore", description: "look around", prompt: "find it", model: "p/m", thinking: "high", notify: "wake", ...overrides };
}

function manager(factory: WorkerManagerOptions["createSession"], overrides: Partial<WorkerManagerOptions> = {}) {
  return new WorkerManager({
    createSession: factory,
    maxConcurrent: () => 2,
    stallWarnMs: () => 0,
    stallKillMs: () => 0,
    stopGraceMs: 50,
    tickMs: 10_000,
    ...overrides,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerManager — never holding the parent", () => {
  it("kills a worker whose session ignores abort, synchronously", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const started = Date.now();
    expect(workers.kill(record.id)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
    expect(record.status).toBe("killed");
    expect(sessions[0]!.disposed).toBe(1);
  });

  it("ignores events from a killed session", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    workers.kill(record.id);
    sessions[0]!.hooks.onToolStart("bash", "sleep");
    sessions[0]!.hooks.submitResult({ status: "done", summary: "late", body: "late" });
    expect(record.toolUses).toBe(0);
    expect(record.result).toBeUndefined();
    expect(record.status).toBe("killed");
  });

  it("returns from wait at the timeout while the worker keeps running", async () => {
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const outcome = await workers.wait([record.id], 20);
    expect(outcome.kind).toBe("timeout");
    expect(record.status).toBe("running");
  });

  it("returns from wait at once when its signal is already aborted, and when it fires", async () => {
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const pre = new AbortController();
    pre.abort();
    expect((await workers.wait([record.id], 60_000, pre.signal)).kind).toBe("interrupted");
    const live = new AbortController();
    const pending = workers.wait([record.id], 60_000, live.signal);
    live.abort();
    expect((await pending).kind).toBe("interrupted");
  });

  it("returns from wait when a waited worker asks a question", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const pending = workers.wait([record.id], 60_000);
    void sessions[0]!.hooks.askParent("which branch?", undefined);
    const outcome = await pending;
    expect(outcome.kind).toBe("question");
    expect(outcome.records[0]!.question?.text).toBe("which branch?");
  });

  it("kills a worker that ignores a graceful stop once the grace period ends", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory, { stopGraceMs: 20 });
    const record = workers.spawn(spec());
    await flush();
    expect(workers.stop(record.id)).toBe(true);
    expect(sessions[0]!.steers.at(-1)).toContain("submit_result");
    expect(record.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(record.status).toBe("stopped");
    expect(sessions[0]!.disposed).toBe(1);
  });

  it("stops and then kills a silent worker as stalled", async () => {
    let now = 1_000;
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory, { now: () => now, stallWarnMs: () => 100, stallKillMs: () => 500, stopGraceMs: 10 });
    const events: string[] = [];
    workers.subscribe((event) => events.push(event.type));
    const record = workers.spawn(spec());
    await flush();
    now += 150;
    workers.tick();
    expect(events).toContain("stall_warning");
    expect(record.status).toBe("running");
    now += 400;
    workers.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.status).toBe("stalled");
  });

  it("does not count a worker waiting on its parent's answer as stalled", async () => {
    let now = 1_000;
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { now: () => now, stallWarnMs: () => 0, stallKillMs: () => 100, stopGraceMs: 10 });
    const record = workers.spawn(spec());
    await flush();
    void sessions[0]!.hooks.askParent("ok?", undefined);
    now += 1_000;
    workers.tick();
    expect(record.status).toBe("running");
  });

  it("stops a worker at its timeout", async () => {
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory, { stopGraceMs: 10 });
    const record = workers.spawn(spec({ timeoutMs: 20 }));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(record.status).toBe("timed_out");
  });

  it("unblocks a pending question when the worker is killed", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const answer = sessions[0]!.hooks.askParent("?", undefined);
    workers.kill(record.id);
    await expect(answer).resolves.toBeUndefined();
    expect(record.question).toBeUndefined();
  });

  it("times out an unanswered question", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { questionTimeoutMs: () => 10 });
    const record = workers.spawn(spec());
    await flush();
    await expect(sessions[0]!.hooks.askParent("?", undefined)).resolves.toBeUndefined();
    expect(record.question).toBeUndefined();
  });

  it("kills every active worker on shutdown and wakes waiters", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const a = workers.spawn(spec());
    await flush();
    const pending = workers.wait([a.id], 60_000);
    workers.shutdown();
    expect((await pending).kind).toBe("settled");
    expect(sessions[0]!.disposed).toBeGreaterThan(0);
    expect(workers.list()).toEqual([]);
  });

  it("disposes a session that finished building after its worker was killed", async () => {
    let release!: () => void;
    const built = { disposed: 0 };
    const factory = vi.fn(() => new Promise<WorkerSession>((resolve) => {
      release = () => resolve({ ...fakeSessionStub(), dispose: () => { built.disposed++; } });
    }));
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    workers.kill(record.id);
    release();
    await flush();
    expect(built.disposed).toBe(1);
  });
});

function fakeSessionStub(): WorkerSession {
  return {
    run: () => new Promise(() => {}),
    steer() {},
    interruptTool: () => false,
    abort() {},
    dispose() {},
    setModel: async () => true,
    lastAssistantText: () => "",
    lastError: () => undefined,
    contextPercent: () => undefined,
    transcript: () => [],
  };
}

describe("WorkerManager — lifecycle", () => {
  it("queues beyond the concurrency limit and starts the next on settle", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { maxConcurrent: () => 1 });
    const a = workers.spawn(spec());
    const b = workers.spawn(spec());
    await flush();
    expect(a.status).toBe("running");
    expect(b.status).toBe("queued");
    sessions[0]!.finishRun("answer");
    await flush();
    expect(a.status).toBe("completed");
    expect(b.status).toBe("running");
  });

  it("settles with the structured result when the worker submitted one", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.hooks.submitResult({ status: "done", summary: "found it", body: "at a.ts:1" });
    sessions[0]!.finishRun("final");
    await flush();
    expect(record.status).toBe("completed");
    expect(record.result).toMatchObject({ status: "done", summary: "found it" });
    expect(record.undelivered).toBe(true);
  });

  it("falls back to the final text as an unstructured result", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.finishRun("plain answer\nmore");
    await flush();
    expect(record.result).toMatchObject({ status: "unstructured", summary: "plain answer", body: "plain answer\nmore" });
    expect(sessions[0]!.runs).toHaveLength(1);
  });

  it("asks once more for submit_result when the agent type needs structured findings", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec({ resultSchema: "findings" }));
    await flush();
    sessions[0]!.finishRun("text only");
    await flush();
    expect(sessions[0]!.runs[1]).toContain("submit_result");
    sessions[0]!.hooks.submitResult({ status: "done", summary: "s", body: "b", findings: [] });
    sessions[0]!.finishRun("ok");
    await flush();
    expect(record.result?.status).toBe("done");
  });

  it("fails the worker on a provider error", async () => {
    const { factory, sessions } = fakeFactory({ error: "429 rate limited" });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.finishRun("");
    await flush();
    expect(record.status).toBe("failed");
    expect(record.error).toContain("429");
  });

  it("steers a running worker and resumes a settled one in the same session", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    expect(workers.send(record.id, "also check b.ts")).toBe("steered");
    expect(sessions[0]!.steers).toContain("also check b.ts");
    sessions[0]!.finishRun("first");
    await flush();
    expect(workers.send(record.id, "now c.ts")).toBe("resumed");
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.runs.at(-1)).toBe("now c.ts");
    expect(record.status).toBe("running");
    expect(record.runs).toBe(2);
  });

  it("routes a message to a pending question as its answer", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const answer = sessions[0]!.hooks.askParent("which?", undefined);
    expect(workers.send(record.id, "main")).toBe("answered");
    await expect(answer).resolves.toBe("main");
    expect(record.question).toBeUndefined();
  });

  it("interrupts only the current tool", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    expect(workers.interruptTool(record.id)).toBe(true);
    expect(sessions[0]!.interrupted).toBe(1);
    expect(record.status).toBe("running");
  });

  it("steers at the turn limit and stops after the grace turns", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory, { graceTurns: () => 1, stopGraceMs: 10 });
    const record = workers.spawn(spec({ maxTurns: 2 }));
    await flush();
    sessions[0]!.hooks.onTurnEnd();
    sessions[0]!.hooks.onTurnEnd();
    expect(sessions[0]!.steers.at(-1)).toContain("turn limit");
    sessions[0]!.hooks.onTurnEnd();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.status).toBe("completed");
  });

  it("resolves ids by unique prefix", async () => {
    const { factory } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec({ type: "reviewer_gpt-astra-pro_high" }));
    expect(workers.get(record.id.slice(0, 12))?.id).toBe(record.id);
  });

  it("keeps an undelivered settlement out of retention pruning", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { retainMax: 0, retainMs: 0 });
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.finishRun("x");
    await flush();
    expect(workers.get(record.id)).toBeDefined();
    workers.markDelivered([record]);
    workers.spawn(spec());
    expect(workers.get(record.id)).toBeUndefined();
  });

  it("does not resolve an empty or ambiguous id", () => {
    const { factory } = fakeFactory();
    const workers = manager(factory);
    workers.spawn(spec());
    workers.spawn(spec());
    expect(workers.get("")).toBeUndefined();
    expect(workers.get("explore-")).toBeUndefined();
    expect(workers.get("explore-2")?.id).toBe("explore-2");
  });

  it("starts a resumed run with its own text and turn count", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { graceTurns: () => 1 });
    const record = workers.spawn(spec({ maxTurns: 2 }));
    await flush();
    sessions[0]!.hooks.onTurnEnd();
    sessions[0]!.finishRun("first answer");
    await flush();
    workers.send(record.id, "more");
    await flush();
    expect(record.turns).toBe(0);
    expect(record.lastText).toBe("");
    sessions[0]!.hooks.onTurnEnd();
    expect(sessions[0]!.steers.some((steer) => steer.includes("turn limit"))).toBe(false);
  });

  it("emits nothing while shutting down", async () => {
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const events: string[] = [];
    workers.subscribe((event) => events.push(event.type));
    workers.spawn(spec());
    await flush();
    events.length = 0;
    workers.shutdown();
    expect(events).toEqual([]);
  });

  it("lets a question wait indefinitely when its timeout is 0", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { questionTimeoutMs: () => 0 });
    const record = workers.spawn(spec());
    await flush();
    const answer = sessions[0]!.hooks.askParent("?", undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record.question).toBeDefined();
    workers.answer(record.id, "yes");
    await expect(answer).resolves.toBe("yes");
  });

  it("starts queued workers when the limit is raised", async () => {
    const { factory } = fakeFactory();
    let limit = 1;
    const workers = manager(factory, { maxConcurrent: () => limit });
    workers.spawn(spec());
    const second = workers.spawn(spec());
    await flush();
    expect(second.status).toBe("queued");
    limit = 2;
    workers.poke();
    expect(second.status).toBe("running");
  });
});

