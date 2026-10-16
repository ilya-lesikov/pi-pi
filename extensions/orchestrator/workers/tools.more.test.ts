import { describe, expect, it } from "vitest";
import { WorkerManager } from "./manager.js";
import { registerWorkerTools, statusDetail, statusLine } from "./tools.js";
import type { WorkerRecord, WorkerSession, WorkerSessionHooks } from "./types.js";

function setup(options: { maxConcurrent?: number; noManager?: boolean } = {}) {
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(text: string): void }> = [];
  const manager = new WorkerManager({
    createSession: async (_spec, hooks) => {
      let resolve: () => void = () => {};
      let text = "";
      sessions.push({ hooks, finish(next) { text = next; hooks.onText(next); resolve(); } });
      const session: WorkerSession = {
        run: () => new Promise<void>((done) => { resolve = done; }),
        steer() {},
        interruptTool: () => true,
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
    maxConcurrent: () => options.maxConcurrent ?? 4,
    stallWarnMs: () => 0,
    stopGraceMs: 60_000,
  });
  const tools = new Map<string, any>();
  const consumed: WorkerRecord[] = [];
  registerWorkerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    manager: () => (options.noManager ? null : manager),
    prepareSpawn: (params) => ({ type: params.subagent_type, description: params.description, prompt: params.prompt, model: "p/m", thinking: "high", notify: "wake" }),
    consumed: (records) => consumed.push(...records),
  });
  const call = (name: string, params: unknown) => tools.get(name).execute("call", params, undefined, undefined, {});
  const spawn = () => call("Agent", { subagent_type: "explore", description: "d", prompt: "p" });
  return { manager, sessions, call, spawn, consumed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (result: any) => result.content[0].text as string;

describe("worker tools — more", () => {
  it("refuses every tool when the session is not ready", async () => {
    const { call } = setup({ noManager: true });
    for (const [name, params] of [["Agent", {}], ["agent_wait", { ids: ["x"] }], ["agent_send", { id: "x", message: "m" }], ["agent_status", {}], ["agent_stop", { id: "x" }]] as const) {
      const result = await call(name, params);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^Workers are unavailable/);
    }
  });

  it("says a spawn is queued behind the concurrency limit", async () => {
    const { spawn } = setup({ maxConcurrent: 1 });
    await spawn();
    expect(text(await spawn())).toContain("It is queued behind the concurrency limit");
  });

  it("reports each agent_send outcome", async () => {
    const { manager, call, spawn, sessions } = setup({ maxConcurrent: 1 });
    await spawn();
    await spawn();
    await flush();
    expect(text(await call("agent_send", { id: "explore-1", message: "x" }))).toBe("Steered explore-1; it sees the message at its next step.");
    expect(text(await call("agent_send", { id: "explore-2" }))).toBe("explore-2 has not started yet; the message was added to its task.");
    sessions[0]!.finish("done");
    await flush();
    expect(text(await call("agent_send", { id: "explore-1", message: "more" }))).toBe("Resumed explore-1 (was completed) with its context intact. Its result will arrive as a worker update.");
    manager.kill("explore-1");
    const gone = await call("agent_send", { id: "explore-1", message: "x" });
    expect(gone.isError).toBe(true);
    expect(text(gone)).toBe("explore-1 can no longer take messages (its session was released).");
  });

  it("lists no workers, and shows a settled worker's full result, marking it seen", async () => {
    const { call, spawn, sessions, consumed } = setup();
    expect(text(await call("agent_status", {}))).toBe("No workers.");
    await spawn();
    await flush();
    sessions[0]!.hooks.reportProgress("halfway");
    sessions[0]!.hooks.submitResult({ status: "done", summary: "found", body: "details", findings: [{ severity: "major", location: "a.ts:1", issue: "bug" }], openQuestions: ["why?"] } as any);
    sessions[0]!.finish("x");
    await flush();
    const detail = text(await call("agent_status", { id: "explore-1" }));
    expect(detail.split("\n").slice(1)).toEqual(["Progress: halfway", "Result (done): found", "- [major] a.ts:1: bug", "details", "Open questions:\n- why?"].join("\n").split("\n"));
    expect(consumed.map((r) => r.id)).toEqual(["explore-1"]);
  });

  it("waits with the default timeout, ignoring unknown ids, and reports a timeout with the workers still running", async () => {
    const { manager, call, spawn } = setup();
    await spawn();
    await flush();
    const wait = manager.wait.bind(manager);
    let timeoutMs = 0;
    manager.wait = (ids, ms, signal) => { timeoutMs = ms; return wait(ids, 5, signal); };
    const result = await call("agent_wait", { ids: ["explore-1", "ghost"], timeout_sec: "nonsense" });
    expect(timeoutMs).toBe(300_000);
    expect(text(result)).toMatch(/^Timed out; the workers are still running:\n\nexplore-1 \[running\]/);
    expect(text(result)).toContain("Unknown ids ignored: ghost.");
    await call("agent_wait", { ids: ["explore-1"], timeout_sec: 10_000 });
    expect(timeoutMs).toBe(600_000);
  });

  it("interrupts tools, reports settled workers as such, and kills a worker that left a partial result", async () => {
    const { manager, call, spawn, sessions, consumed } = setup();
    await spawn();
    await spawn();
    await flush();
    expect(text(await call("agent_stop", { id: "explore-1", mode: "tool" }))).toBe("explore-1: interrupted its running tool calls.");
    sessions[0]!.hooks.onText("partial");
    expect(text(await call("agent_stop", { id: "explore-1", mode: "kill" }))).toBe("explore-1: killed; its partial result follows as a worker update.");
    expect(consumed).toEqual([]);
    expect(text(await call("agent_stop", { id: "explore-1" }))).toBe("explore-1: already killed.");
    expect(text(await call("agent_stop", { id: "explore-1", mode: "tool" }))).toBe("explore-1: no tool call in progress.");
    expect(text(await call("agent_stop", { id: "explore-2" }))).toBe("explore-2: asked to wrap up; killed in a minute if it does not.");
    manager.shutdown();
  });

  it("reports a stopped queued worker by its new status, and that nothing is active", async () => {
    const { call, spawn } = setup({ maxConcurrent: 1 });
    await spawn();
    await spawn();
    expect(text(await call("agent_stop", { id: "explore-2" }))).toBe("explore-2: stopped.");
    await call("agent_stop", { id: "all", mode: "kill" });
    const none = await call("agent_stop", { id: "all" });
    expect(text(none)).toBe("No active workers.");
    expect(none.isError).toBe(false);
    expect((await call("agent_stop", { id: "nope" })).isError).toBe(true);
  });
});

describe("statusLine / statusDetail", () => {
  const base = (overrides: Partial<WorkerRecord> = {}): WorkerRecord => ({
    id: "w-1",
    spec: { type: "explore", description: "d", prompt: "p", model: "p/m", thinking: "high", notify: "wake" },
    status: "running",
    createdAt: 0,
    lastEventAt: 0,
    turns: 0,
    toolUses: 2,
    lastText: "",
    outputTail: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    runUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    modelId: "p/m",
    runs: 1,
    undelivered: false,
    waitHolds: 0,
    stallWarned: false,
    ...overrides,
  });

  it("flags a long silence and shows a pending question", () => {
    const line = statusLine(base({ question: { id: "q", text: "which?", askedAt: 0 } }), 120_000);
    expect(line).toBe("w-1 [running] · explore: d · 2m · 2 tools · turn 1 · asks: which? · no output yet · silent 2m");
  });

  it("shows a settled worker's summary and error, and no running details", () => {
    const record = base({ status: "failed", startedAt: 1000, settledAt: 4000, error: "boom", outputTail: "tail", result: { status: "partial", summary: "same", body: "same" } });
    expect(statusDetail(record, 10_000)).toBe("w-1 [failed] · explore: d · 3s · 2 tools · same\nError: boom\nResult (partial): same");
  });
});
