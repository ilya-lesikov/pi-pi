import { describe, expect, it, vi } from "vitest";
import { WorkerManager, type WorkerManagerOptions } from "./manager.js";
import type { WorkerSession, WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";

interface FakeSession extends WorkerSession {
  hooks: WorkerSessionHooks;
  runs: string[];
  steers: string[];
  aborted: number;
  disposed: number;
  finishRun(text?: string): void;
  failRun(error: unknown): void;
}

function fakeFactory(behaviour: { hangAbort?: boolean; throwOnAbort?: boolean; throwOnDispose?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const factory = vi.fn(async (_spec: WorkerSpawnSpec, hooks: WorkerSessionHooks) => {
    let resolveRun: (() => void) | null = null;
    let rejectRun: ((error: unknown) => void) | null = null;
    let text = "";
    const session: FakeSession = {
      hooks,
      runs: [],
      steers: [],
      aborted: 0,
      disposed: 0,
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
      interruptTool: () => true,
      abort() {
        session.aborted++;
        if (behaviour.throwOnAbort) throw new Error("abort failed");
        if (!behaviour.hangAbort) resolveRun?.();
      },
      dispose() {
        session.disposed++;
        if (behaviour.throwOnDispose) throw new Error("dispose failed");
      },
      async setModel() { return true; },
      lastAssistantText: () => text,
      lastError: () => undefined,
      contextPercent: () => undefined,
      transcript: () => [],
    };
    sessions.push(session);
    return session;
  });
  return { factory, sessions };
}

const spec = (overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec => ({ type: "explore", description: "look", prompt: "find it", model: "p/m", thinking: "high", notify: "wake", ...overrides });

function manager(factory: WorkerManagerOptions["createSession"], overrides: Partial<WorkerManagerOptions> = {}) {
  return new WorkerManager({ createSession: factory, maxConcurrent: () => 2, stallWarnMs: () => 0, stopGraceMs: 50, tickMs: 10_000, ...overrides });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkerManager — hung-request watchdog", () => {
  async function staleWorker(behaviour: Parameters<typeof fakeFactory>[0] = {}, overrides: Partial<WorkerManagerOptions> = {}) {
    const clock = { now: 1_000 };
    const { factory, sessions } = fakeFactory(behaviour);
    const workers = manager(factory, { now: () => clock.now, modelStaleMs: () => 100, ...overrides });
    const events: string[] = [];
    workers.subscribe((event) => events.push(event.type));
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.hooks.onEvent();
    const hang = () => {
      clock.now += 150;
      workers.tick();
    };
    return { clock, workers, record, session: sessions[0]!, events, hang };
  }

  it("settles as completed with the continued run's answer after a recovered hang", async () => {
    const { record, session, hang } = await staleWorker();
    hang();
    await flush();
    expect(record.step?.label).toBe("retrying a model request that hung for 0m");
    session.finishRun("recovered answer");
    await flush();
    expect(record.status).toBe("completed");
    expect(record.result).toMatchObject({ status: "unstructured", summary: "recovered answer" });
    expect(session.runs).toEqual(["find it", expect.stringContaining("hung")]);
  });

  it("counts hangs per run, so a resumed run gets its full retry budget again", async () => {
    const { record, session, hang, workers } = await staleWorker();
    hang();
    await flush();
    hang();
    await flush();
    session.finishRun("ok");
    await flush();
    expect(record.status).toBe("completed");
    expect(workers.resume(record.id, "again")).toBe(true);
    await flush();
    session.hooks.onEvent();
    hang();
    await flush();
    hang();
    await flush();
    expect(record.status).toBe("running");
    expect(session.runs.filter((run) => run.includes("hung"))).toHaveLength(4);
    hang();
    expect(record.status).toBe("failed");
  });

  it("names the silence in minutes when it gives up", async () => {
    const { record, clock, workers, session } = await staleWorker({}, { modelStaleMs: () => 10 * 60_000 });
    for (let i = 0; i < 3; i++) {
      clock.now += 10 * 60_000;
      workers.tick();
      await flush();
    }
    expect(record.status).toBe("failed");
    expect(record.error).toBe("The model stopped responding: 3 requests in a row went 10m without a response.");
    expect(session.disposed).toBe(1);
  });

  it("leaves a hung request to the stop grace period once a graceful stop is under way", async () => {
    const { record, session, hang, workers } = await staleWorker({ hangAbort: true });
    workers.stop(record.id);
    hang();
    expect(session.aborted).toBe(0);
    await sleep(80);
    expect(record.status).toBe("stopped");
    expect(session.runs).toHaveLength(1);
  });

  it("does not continue a run that was killed while its hung request was being abandoned", async () => {
    const { record, session, hang, workers } = await staleWorker({ hangAbort: true });
    hang();
    expect(session.aborted).toBe(1);
    workers.kill(record.id);
    session.finishRun("late");
    await flush();
    expect(record.status).toBe("killed");
    expect(session.runs).toHaveLength(1);
  });

  it("does not abandon a request while the worker waits on its parent, and counts from the answer", async () => {
    const { record, session, hang, workers, clock } = await staleWorker();
    const answer = session.hooks.askParent("which?", undefined);
    hang();
    hang();
    expect(session.aborted).toBe(0);
    workers.answer(record.id, "that");
    await expect(answer).resolves.toBe("that");
    clock.now += 50;
    workers.tick();
    expect(session.aborted).toBe(0);
  });

  it("resumes watching once every parallel tool has finished", async () => {
    const { session, hang } = await staleWorker();
    session.hooks.onToolStart("bash", "a");
    session.hooks.onToolStart("bash", "b");
    session.hooks.onToolEnd();
    session.hooks.onToolEnd();
    session.hooks.onToolEnd();
    hang();
    expect(session.aborted).toBe(1);
  });

  it("settles as failed when the continued request throws", async () => {
    const { record, session, hang } = await staleWorker();
    hang();
    await flush();
    session.failRun(new Error("socket closed"));
    await flush();
    expect(record.status).toBe("failed");
    expect(record.error).toBe("socket closed");
  });

  it("is disabled at 0 and still warns about the silence", async () => {
    const { session, hang, events } = await staleWorker({}, { modelStaleMs: () => 0, stallWarnMs: () => 100 });
    hang();
    expect(session.aborted).toBe(0);
    expect(events).toContain("stall_warning");
  });
});

describe("WorkerManager — control paths", () => {
  it("adds a message to a queued worker's prompt", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { maxConcurrent: () => 1 });
    const first = workers.spawn(spec());
    const queued = workers.spawn(spec({ prompt: "task" }));
    expect(workers.send(queued.id, "and this")).toBe("queued");
    await flush();
    sessions[0]!.finishRun("x");
    await flush();
    expect(first.status).toBe("completed");
    expect(sessions[1]!.runs[0]).toBe("task\n\nand this");
  });

  it("reports gone for unknown workers and released sessions", async () => {
    const { factory } = fakeFactory();
    const workers = manager(factory);
    expect(workers.send("nope", "x")).toBe("gone");
    const record = workers.spawn(spec());
    await flush();
    workers.kill(record.id);
    expect(workers.send(record.id, "x")).toBe("gone");
    expect(workers.resume(record.id, "x")).toBe(false);
    expect(workers.sessionOf(record.id)).toBeUndefined();
    expect(workers.sessionOf("nope")).toBeUndefined();
  });

  it("exposes the live session and refuses to interrupt a worker that is not running", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { maxConcurrent: () => 1 });
    const running = workers.spawn(spec());
    const queued = workers.spawn(spec());
    await flush();
    expect(workers.sessionOf(running.id)).toBe(sessions[0]);
    expect(workers.interruptTool(queued.id)).toBe(false);
    expect(workers.interruptTool("nope")).toBe(false);
    expect(workers.answer(running.id, "x")).toBe(false);
  });

  it("stops a queued worker before it starts and refuses to stop a settled one", async () => {
    const { factory } = fakeFactory();
    const workers = manager(factory, { maxConcurrent: () => 1 });
    workers.spawn(spec());
    const queued = workers.spawn(spec());
    expect(workers.stop(queued.id)).toBe(true);
    expect(queued.status).toBe("stopped");
    expect(queued.error).toBe("stopped before it started");
    expect(workers.stop(queued.id)).toBe(false);
    expect(workers.kill(queued.id)).toBe(false);
  });

  it("asks once for a graceful stop and releases a pending question with no answer", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const answer = sessions[0]!.hooks.askParent("?", undefined);
    expect(workers.stop(record.id)).toBe(true);
    expect(workers.stop(record.id)).toBe(true);
    await expect(answer).resolves.toBeUndefined();
    expect(sessions[0]!.steers.filter((s) => s.includes("asked you to stop"))).toHaveLength(1);
    expect(await sessions[0]!.hooks.askParent("again?", undefined)).toBeUndefined();
  });

  it("settles a gracefully stopped worker with the stop reason once it finishes", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    workers.stop(record.id, "idle");
    sessions[0]!.finishRun("wrapped up");
    await flush();
    expect(record.status).toBe("idle");
    expect(sessions[0]!.runs).toHaveLength(1);
  });

  it("keeps the stop reason when a stopping worker's run throws", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    workers.stop(record.id);
    sessions[0]!.failRun("plain string");
    await flush();
    expect(record.status).toBe("stopped");
    expect(record.error).toBe("plain string");
  });

  it("survives a session that throws on abort or dispose", async () => {
    const { factory } = fakeFactory({ throwOnAbort: true, throwOnDispose: true });
    const workers = manager(factory, { retainMax: 0, retainMs: 0 });
    const record = workers.spawn(spec());
    await flush();
    expect(workers.kill(record.id)).toBe(true);
    workers.markDelivered([record]);
    workers.spawn(spec());
    expect(workers.get(record.id)).toBeUndefined();
    workers.shutdown();
  });

  it("replaces an earlier unanswered question with a newer one", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const first = sessions[0]!.hooks.askParent("one?", undefined);
    const second = sessions[0]!.hooks.askParent("two?", undefined);
    await expect(first).resolves.toBeUndefined();
    expect(record.question?.text).toBe("two?");
    expect(workers.pendingQuestions()).toEqual([record]);
    workers.answer(record.id, "yes");
    await expect(second).resolves.toBe("yes");
  });

  it("withdraws a question when its signal aborts, but not after it was answered", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const controller = new AbortController();
    const answer = sessions[0]!.hooks.askParent("?", controller.signal);
    controller.abort();
    await expect(answer).resolves.toBeUndefined();
    expect(record.question).toBeUndefined();
    const other = new AbortController();
    const answered = sessions[0]!.hooks.askParent("?", other.signal);
    workers.answer(record.id, "a");
    other.abort();
    await expect(answered).resolves.toBe("a");
  });

  it("orders pending questions by when they were asked", async () => {
    let now = 1_000;
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { now: () => now });
    const a = workers.spawn(spec());
    const b = workers.spawn(spec());
    await flush();
    void sessions[1]!.hooks.askParent("b?", undefined);
    now += 10;
    void sessions[0]!.hooks.askParent("a?", undefined);
    expect(workers.pendingQuestions().map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("accumulates usage and progress, ignoring hooks after the run settled", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    const hooks = sessions[0]!.hooks;
    hooks.onUsage({ input: 10, output: 5, cost: 0.5 });
    hooks.onUsage({ cacheRead: 3, cacheWrite: 2 });
    hooks.reportProgress("half way");
    expect(record.usage).toEqual({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.5 });
    expect(record.progress).toBe("half way");
    sessions[0]!.finishRun("done");
    await flush();
    for (const fire of [() => hooks.onPhase("x"), () => hooks.onEvent(), () => hooks.onStep("x"), () => hooks.onOutput("x"), () => hooks.onToolEnd(), () => hooks.onTurnEnd(), () => hooks.onUsage({ input: 1 }), () => hooks.onText("x"), () => hooks.reportProgress("x")]) fire();
    expect(record.usage.input).toBe(10);
    expect(record.lastText).toBe("done");
    expect(record.turns).toBe(0);
  });

  it("keeps the last text as a partial result when a worker is killed", async () => {
    const { factory, sessions } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.hooks.onText("half an answer\nmore");
    workers.kill(record.id);
    expect(record.result).toEqual({ status: "partial", summary: "half an answer", body: "half an answer\nmore" });
  });

  it("clips a long first line in the summary", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory);
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.finishRun("x".repeat(300));
    await flush();
    expect(record.result!.summary).toBe(`${"x".repeat(197)}…`);
  });

  it("restarts the start timer on a resumed run and fails it if the run never produces an event", async () => {
    const { factory, sessions } = fakeFactory();
    const workers = manager(factory, { startTimeoutMs: () => 30 });
    const record = workers.spawn(spec());
    await flush();
    sessions[0]!.hooks.onEvent();
    sessions[0]!.finishRun("first");
    await flush();
    workers.resume(record.id, "again");
    await flush();
    expect(record.startPhase).toBe("sending the prompt");
    await sleep(60);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("sending the prompt");
  });

  it("waits on nothing for unknown ids, and settles a wait when the waited records are pruned away", async () => {
    const { factory } = fakeFactory({ hangAbort: true });
    const workers = manager(factory);
    expect(await workers.wait(["nope"], 1000)).toEqual({ kind: "settled", records: [] });
    const record = workers.spawn(spec());
    await flush();
    const pending = workers.wait([record.id], 60_000);
    workers.shutdown();
    expect((await pending).kind).toBe("settled");
  });

  it("gives ids a fallback base and skips ids already taken", () => {
    const { factory } = fakeFactory();
    const workers = manager(factory);
    expect(workers.spawn(spec({ type: "!!!" })).id).toBe("worker-1");
    expect(workers.spawn(spec({ type: "Code Reviewer" })).id).toBe("code-reviewer-2");
  });

  it("swallows a listener that throws", async () => {
    const { factory } = fakeFactory();
    const workers = manager(factory);
    workers.subscribe(() => { throw new Error("listener"); });
    const seen: string[] = [];
    workers.subscribe((event) => seen.push(event.type));
    workers.spawn(spec());
    expect(seen).toContain("created");
  });

  it("stops ticking once nothing is active", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sessions } = fakeFactory();
      const workers = manager(factory, { tickMs: 100 });
      const tick = vi.spyOn(workers, "tick");
      workers.spawn(spec());
      await vi.advanceTimersByTimeAsync(0);
      sessions[0]!.finishRun("x");
      await vi.advanceTimersByTimeAsync(250);
      const calls = tick.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tick.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
