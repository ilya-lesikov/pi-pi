import { describe, expect, it, vi } from "vitest";
import { WorkerManager } from "./manager.js";
import { registerWorkerTools } from "./tools.js";
import type { WorkerRecord, WorkerSession, WorkerSessionHooks } from "./types.js";

function setup() {
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(text: string): void }> = [];
  const manager = new WorkerManager({
    createSession: async (_spec, hooks) => {
      let resolve: () => void = () => {};
      let text = "";
      sessions.push({ hooks, finish(next) { text = next; resolve(); } });
      const session: WorkerSession = {
        run: () => new Promise<void>((done) => { resolve = done; }),
        steer() {},
        interruptTool: () => false,
        // A wedged session: abort does not end the run.
        abort() {},
        dispose() {},
        setModel: async () => true,
        lastAssistantText: () => text,
        lastError: () => undefined,
        contextPercent: () => undefined,
        transcript: () => [],
      };
      return session;
    },
    maxConcurrent: () => 4,
    stallWarnMs: () => 0,
    stallKillMs: () => 0,
  });
  const tools = new Map<string, any>();
  const consumed: WorkerRecord[] = [];
  registerWorkerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    manager: () => manager,
    prepareSpawn: (params) => params.subagent_type === "bad" ? "subagent_type must be one of: explore" : { type: params.subagent_type, description: params.description, prompt: params.prompt, model: "p/m", thinking: "high", notify: "wake" },
    consumed: (records) => consumed.push(...records),
  });
  const call = (name: string, params: unknown, signal?: AbortSignal) => tools.get(name).execute("call", params, signal, undefined, {});
  return { manager, sessions, call, consumed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("worker tools", () => {
  it("spawns without waiting and refuses an invalid type", async () => {
    const { call, manager } = setup();
    const started = await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    expect(started.content[0].text).toMatch(/^Started worker explore-1/);
    expect(manager.get("explore-1")?.status).toBe("running");
    const refused = await call("Agent", { subagent_type: "bad", description: "d", prompt: "p" });
    expect(refused.isError).toBe(true);
  });

  it("returns from agent_wait when the user interrupts it, leaving the worker running", async () => {
    const { call, manager } = setup();
    await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    const controller = new AbortController();
    const pending = call("agent_wait", { ids: ["explore-1"], timeout_sec: 600 }, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.content[0].text).toContain("Wait interrupted");
    expect(manager.get("explore-1")?.status).toBe("running");
  });

  it("hands a finished result to agent_wait and marks it seen", async () => {
    const { call, sessions, consumed } = setup();
    await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    const pending = call("agent_wait", { ids: ["explore-1"] });
    sessions[0]!.hooks.submitResult({ status: "done", summary: "found", body: "a.ts:1" });
    sessions[0]!.finish("x");
    const result = await pending;
    expect(result.content[0].text).toContain("Result (done): found");
    expect(consumed.map((record) => record.id)).toEqual(["explore-1"]);
  });

  it("kills a wedged worker at once and does not announce it again when it left nothing", async () => {
    const { call, manager, consumed } = setup();
    await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    const result = await call("agent_stop", { id: "explore-1", mode: "kill" });
    expect(result.content[0].text).toBe("explore-1: killed; it left no result.");
    expect(manager.get("explore-1")?.status).toBe("killed");
    expect(consumed.map((record) => record.id)).toEqual(["explore-1"]);
  });

  it("marks a question agent_wait returned as seen, so it is not pushed again", async () => {
    const { call, sessions, consumed } = setup();
    await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    const pending = call("agent_wait", { ids: ["explore-1"] });
    void sessions[0]!.hooks.askParent("main or dev?", undefined);
    const result = await pending;
    expect(result.content[0].text).toContain("asks: main or dev?");
    expect(consumed.map((record) => record.id)).toEqual(["explore-1"]);
  });

  it("routes agent_send to a pending question as its answer", async () => {
    const { call, sessions } = setup();
    await call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    const answer = sessions[0]!.hooks.askParent("main or dev?", undefined);
    const sent = await call("agent_send", { id: "explore-1", message: "dev" });
    expect(sent.content[0].text).toContain("Answered");
    await expect(answer).resolves.toBe("dev");
  });

  it("stops every active worker with id all", async () => {
    const { call, manager } = setup();
    await call("Agent", { subagent_type: "explore", description: "a", prompt: "p" });
    await call("Agent", { subagent_type: "explore", description: "b", prompt: "p" });
    await flush();
    await call("agent_stop", { id: "all", mode: "kill" });
    expect(manager.active()).toEqual([]);
  });

  it("errors on an unknown worker", async () => {
    const { call } = setup();
    expect((await call("agent_status", { id: "nope" })).isError).toBe(true);
    expect((await call("agent_send", { id: "nope", message: "x" })).isError).toBe(true);
    expect((await call("agent_wait", { ids: ["nope"] })).isError).toBe(true);
    vi.restoreAllMocks();
  });
});
