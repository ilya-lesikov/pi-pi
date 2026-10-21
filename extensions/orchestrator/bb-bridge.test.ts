import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbState as PluginState } from "../../bb/state.js";
import { registerBbBridge, type BbState } from "./bb-bridge.js";
import { resetBbForms, type BbForms, type FormOutcome } from "./bb-forms.js";
import { registerTasks } from "./tasks/index.js";
import { WorkerManager } from "./workers/manager.js";
import type { WorkerSession, WorkerSessionHooks } from "./workers/types.js";

let storage: string;

beforeEach(() => {
  vi.useFakeTimers();
  storage = mkdtempSync(join(tmpdir(), "pp-bb-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(storage, { recursive: true, force: true });
});

function harness(env: NodeJS.ProcessEnv = { BB_THREAD_ID: "thr_1", BB_THREAD_STORAGE: storage }, mode = "rpc") {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const steered: string[] = [];
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(): void }> = [];
  const manager = new WorkerManager({
    createSession: async (_spec, hooks) => {
      let resolve = () => {};
      sessions.push({ hooks, finish: () => resolve() });
      return {
        run: () => new Promise<void>((done) => { resolve = done; }),
        steer: (message: string) => steered.push(message),
        interruptTool: () => false,
        abort() { resolve(); },
        dispose() {},
        setModel: async () => true,
        lastAssistantText: () => "all done\nwith details",
        lastError: () => undefined,
        contextPercent: () => undefined,
        transcript: () => [],
      } satisfies WorkerSession;
    },
    maxConcurrent: () => 2,
    stallWarnMs: () => 100_000,
    stopGraceMs: 60_000,
  });
  const orchestrator: any = { pi, workers: manager };
  registerBbBridge(orchestrator, registerTasks(pi), env);
  const ctx = { mode, hasUI: false, sessionManager: { getBranch: () => [] } };
  const fire = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const file = join(storage, "pi-pi", "state.json");
  const state = (): BbState => JSON.parse(readFileSync(file, "utf8"));
  const command = (name: string, body: object) => writeFileSync(join(storage, "pi-pi", "commands", name), JSON.stringify(body));
  const call = (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx);
  return { manager, sessions, steered, fire, file, state, command, call, orchestrator, sent, handlers };
}

/** A stand-in for the plugin's forms: each ask waits until the test settles it. */
function fakeForms() {
  const asked: Array<{ spec: any; signal?: AbortSignal; settle(outcome: FormOutcome): void }> = [];
  const forms = {
    ask: (spec: any, options: any) => new Promise<FormOutcome>((resolve) => {
      asked.push({ spec, signal: options.signal, settle: resolve });
      options.signal?.addEventListener("abort", () => resolve({ outcome: "cancelled", reason: "signal" }), { once: true });
    }),
    cancelStale: vi.fn(async () => {}),
    takeTyped: vi.fn(() => false),
    busy: false,
    lastAskEndedAt: 0,
  } as unknown as BbForms;
  return { forms, asked };
}

const spec = { type: "explore", description: "look around", prompt: "find the auth module", model: "p/m", thinking: "high", notify: "wake" as const };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// The bb plugin keeps its own copy of the file's types; this fails to compile when they drift apart.
const readableByPlugin = (state: BbState): PluginState => state;

describe("bb bridge", () => {
  it("does nothing outside bb", async () => {
    const { fire, file } = harness({});
    await fire("session_start");
    expect(existsSync(file)).toBe(false);
  });

  it("leaves the thread's file alone in a pi started from one of the thread's shells", async () => {
    const { fire, file } = harness(undefined, "tui");
    await fire("session_start");
    expect(existsSync(file)).toBe(false);
  });

  it("records a command that throws as failed instead of crashing pi", async () => {
    const { fire, state, manager, command } = harness();
    await fire("session_start");
    const record = manager.spawn(spec);
    await flush();
    vi.spyOn(manager, "stop").mockImplementation(() => { throw new Error("boom"); });
    command("1-a.json", { id: "a", workerId: record.id, action: "stop" });
    vi.advanceTimersByTime(500);
    expect(state().commandResults).toEqual([expect.objectContaining({ id: "a", ok: false, message: "Failed: boom" })]);
  });

  it("mirrors the task list as soon as it changes", async () => {
    const { fire, state, call } = harness();
    await fire("session_start");
    expect(readableByPlugin(state())).toMatchObject({ version: 1, live: true, tasks: [], workers: [] });
    await call("TaskCreate", { subject: "Write tests", description: "", activeForm: "Writing tests" });
    await call("TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(state().tasks).toEqual([{ id: "1", subject: "Write tests", status: "in_progress", activeForm: "Writing tests" }]);
  });

  it("mirrors workers on its tick, and marks the state dead when the session ends", async () => {
    const { fire, state, manager, sessions } = harness();
    await fire("session_start");
    const record = manager.spawn(spec);
    await flush();
    sessions[0]!.hooks.onStep("running read src/auth.ts");
    vi.advanceTimersByTime(500);
    expect(state().workers[0]).toMatchObject({ id: record.id, type: "explore", description: "look around", prompt: "find the auth module", status: "running", step: { label: "running read src/auth.ts" } });
    sessions[0]!.finish();
    await flush();
    vi.advanceTimersByTime(500);
    expect(state().workers[0]).toMatchObject({ status: "completed", result: { summary: "all done" } });
    await fire("session_shutdown");
    expect(state().live).toBe(false);
  });

  it("refreshes its heartbeat while nothing changes", async () => {
    const { fire, state } = harness();
    await fire("session_start");
    const first = state().heartbeatAt;
    vi.advanceTimersByTime(1000);
    expect(state().heartbeatAt).toBe(first);
    vi.advanceTimersByTime(5000);
    expect(state().heartbeatAt).toBeGreaterThan(first);
  });

  it("runs Stop, Kill and Message commands once each and reports how they went", async () => {
    const { fire, state, manager, command, steered } = harness();
    await fire("session_start");
    const first = manager.spawn(spec);
    const second = manager.spawn({ ...spec, description: "other" });
    await flush();
    command("1-a.json", { id: "a", workerId: first.id, action: "message", text: "check the tests too" });
    command("2-b.json", { id: "b", workerId: second.id, action: "kill" });
    command("3-c.json", { id: "c", workerId: second.id, action: "stop" });
    command("4-d.json", { id: "d", workerId: "nobody", action: "kill" });
    vi.advanceTimersByTime(500);
    expect(steered).toEqual(["check the tests too"]);
    expect(manager.get(second.id)!.status).toBe("killed");
    expect(state().commandResults.map(({ id, ok, message }) => ({ id, ok, message }))).toEqual([
      { id: "a", ok: true, message: "Message sent." },
      { id: "b", ok: true, message: "Killed explore." },
      { id: "c", ok: false, message: "explore is not running." },
      { id: "d", ok: false, message: "That worker is no longer retained." },
    ]);
    vi.advanceTimersByTime(500);
    expect(steered).toHaveLength(1);
    command("5-e.json", { id: "e", workerId: first.id, action: "stop" });
    vi.advanceTimersByTime(500);
    expect(state().commandResults.at(-1)).toMatchObject({ id: "e", ok: true });
  });

  it("drops a command file it cannot parse instead of retrying it forever", async () => {
    const { fire, state } = harness();
    await fire("session_start");
    writeFileSync(join(storage, "pi-pi", "commands", "bad.json"), "{nope");
    vi.advanceTimersByTime(500);
    expect(existsSync(join(storage, "pi-pi", "commands", "bad.json"))).toBe(false);
    expect(state().commandResults).toEqual([]);
  });

  describe("a worker's question", () => {
    afterEach(() => resetBbForms(undefined));

    async function asking(parentBusy = false) {
      const { forms, asked } = fakeForms();
      resetBbForms(forms);
      const h = harness();
      h.orchestrator.mainTurnInFlight = parentBusy;
      await h.fire("session_start");
      expect(forms.cancelStale).toHaveBeenCalled();
      const record = h.manager.spawn(spec);
      await flush();
      const answer = h.sessions[0]!.hooks.askParent!("Which branch?", undefined);
      vi.advanceTimersByTime(500);
      return { ...h, asked, record, answer };
    }

    it("asks the user in a form at once while the parent is idle, and hands the worker their answer", async () => {
      const { asked, record, answer, sent } = await asking();
      expect(asked).toHaveLength(1);
      expect(asked[0]!.spec).toEqual({ version: 1, kind: "worker-question", workerId: record.id, workerLabel: "explore: look around", questionId: record.question!.id, question: "Which branch?" });
      asked[0]!.settle({ outcome: "submitted", value: { kind: "answer", text: "main" } });
      expect(await answer).toBe("main");
      // The parent learns it was answered, so it does not answer again.
      expect(sent[0]!.message.content).toContain(`The user answered ${record.id}'s question in bb: "main"`);
    });

    it("waits a little before asking while the parent's turn runs, since the agent usually answers first", async () => {
      const { asked } = await asking(true);
      expect(asked).toHaveLength(0);
      vi.advanceTimersByTime(12_000);
      expect(asked).toHaveLength(1);
    });

    it("ignores an answer that arrives after the agent answered, and takes the form down", async () => {
      const { asked, record, answer, manager, sent, steered } = await asking();
      manager.send(record.id, "dev");
      expect(await answer).toBe("dev");
      // Submitted before the bridge noticed: it must not become a second answer.
      asked[0]!.settle({ outcome: "submitted", value: { kind: "answer", text: "late" } });
      await flush();
      expect(sent).toHaveLength(0);
      expect(steered).toEqual([]);
    });

    it("takes the form down once the question is answered elsewhere", async () => {
      const { asked, record, manager } = await asking();
      manager.send(record.id, "dev");
      vi.advanceTimersByTime(500);
      expect(asked[0]!.signal!.aborted).toBe(true);
    });

    it("does not ask while the agent has its own form up, since it is most likely relaying the question", async () => {
      const { forms, asked } = fakeForms();
      Object.defineProperty(forms, "busy", { get: () => true });
      resetBbForms(forms);
      const h = harness();
      await h.fire("session_start");
      h.manager.spawn(spec);
      await flush();
      void h.sessions[0]!.hooks.askParent!("Which branch?", undefined);
      vi.advanceTimersByTime(30_000);
      expect(asked).toHaveLength(0);
    });

    it("waits again after the agent's own form closes, since its answer to the worker is on its way", async () => {
      const { forms, asked } = fakeForms();
      let busy = true;
      let endedAt = 0;
      Object.defineProperty(forms, "busy", { get: () => busy });
      Object.defineProperty(forms, "lastAskEndedAt", { get: () => endedAt });
      resetBbForms(forms);
      const h = harness();
      h.orchestrator.mainTurnInFlight = true;
      await h.fire("session_start");
      h.manager.spawn(spec);
      await flush();
      void h.sessions[0]!.hooks.askParent!("Which branch?", undefined);
      vi.advanceTimersByTime(30_000);
      busy = false;
      endedAt = Date.now();
      vi.advanceTimersByTime(5_000);
      expect(asked).toHaveLength(0);
      vi.advanceTimersByTime(8_000);
      expect(asked).toHaveLength(1);
    });

    it("takes a worker's form down while the agent asks the user itself, and shows it again after if still unanswered", async () => {
      const { forms, asked } = fakeForms();
      let busy = false;
      let endedAt = 0;
      Object.defineProperty(forms, "busy", { get: () => busy });
      Object.defineProperty(forms, "lastAskEndedAt", { get: () => endedAt });
      resetBbForms(forms);
      const h = harness();
      await h.fire("session_start");
      h.manager.spawn(spec);
      await flush();
      void h.sessions[0]!.hooks.askParent!("Which branch?", undefined);
      vi.advanceTimersByTime(500);
      expect(asked).toHaveLength(1);
      busy = true;
      vi.advanceTimersByTime(500);
      expect(asked[0]!.signal!.aborted).toBe(true);
      busy = false;
      endedAt = Date.now();
      await flush();
      vi.advanceTimersByTime(500);
      expect(asked).toHaveLength(2);
    });

    it("tries a worker's form again a while after bb could not show it, but not once the user closed it", async () => {
      const { asked, record } = await asking();
      asked[0]!.settle({ outcome: "unavailable" });
      await flush();
      vi.advanceTimersByTime(5000);
      expect(asked).toHaveLength(1);
      vi.advanceTimersByTime(25_500);
      expect(asked).toHaveLength(2);
      expect(asked[1]!.spec.questionId).toBe(record.question!.id);
      asked[1]!.settle({ outcome: "cancelled", reason: "user" });
      await flush();
      vi.advanceTimersByTime(5000);
      expect(asked).toHaveLength(2);
    });

    it("leaves the question to the agent when the user cancels the form", async () => {
      const { asked, record, manager, sent } = await asking();
      asked[0]!.settle({ outcome: "cancelled", reason: "user" });
      await flush();
      expect(manager.get(record.id)!.question).toBeDefined();
      expect(sent).toHaveLength(0);
      // Not asked again for the same question.
      vi.advanceTimersByTime(5000);
      expect(asked).toHaveLength(1);
    });
  });

  it("hands a reply the user typed to an open form, and leaves the agent's own messages alone", async () => {
    const { forms } = fakeForms();
    (forms.takeTyped as any).mockReturnValue(true);
    resetBbForms(forms);
    const { fire, handlers } = harness();
    await fire("session_start");
    const input = handlers.get("input")![0]!;
    expect(await input({ text: "B please", source: "rpc" }, {})).toEqual({ action: "handled" });
    expect(await input({ text: "B please", source: "extension" }, {})).toEqual({ action: "continue" });
    expect(await input({ text: "see this", source: "rpc", images: [{ type: "image" }] }, {})).toEqual({ action: "continue" });
  });
});
