import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBbBridge, type BbState } from "./bb-bridge.js";
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

function harness(env: NodeJS.ProcessEnv = { BB_THREAD_STORAGE: storage }) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
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
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const fire = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const file = join(storage, "pi-pi", "state.json");
  const state = (): BbState => JSON.parse(readFileSync(file, "utf8"));
  const command = (name: string, body: object) => writeFileSync(join(storage, "pi-pi", "commands", name), JSON.stringify(body));
  const call = (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx);
  return { manager, sessions, steered, fire, file, state, command, call };
}

const spec = { type: "explore", description: "look around", prompt: "find the auth module", model: "p/m", thinking: "high", notify: "wake" as const };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("bb bridge", () => {
  it("does nothing outside bb", async () => {
    const { fire, file } = harness({});
    await fire("session_start");
    expect(existsSync(file)).toBe(false);
  });

  it("mirrors the task list as soon as it changes", async () => {
    const { fire, state, call } = harness();
    await fire("session_start");
    expect(state()).toMatchObject({ version: 1, live: true, tasks: [], workers: [] });
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
});
