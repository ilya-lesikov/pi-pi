import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSessionEnv } from "./session.js";

const childEnv = vi.hoisted(() => ({ value: null as ChildSessionEnv | null }));
vi.mock("./session.js", () => ({
  createChildSessionFactory: (env: ChildSessionEnv) => {
    childEnv.value = env;
    return async () => { throw new Error("no real sessions in this test"); };
  },
}));

import { getDefaultConfig } from "../config.js";
import { registerAgentDefinitions } from "../agents/registry.js";
import { configureRouting, setCatalog } from "../routing.js";
import { createWorkers, registerWorkerToolsFor, resumeOnNewRouting, type WorkerHooks } from "./index.js";
import { WORKER_MESSAGE_TYPE } from "./delivery.js";
import { attachHost } from "../notices.js";
import type { WorkerRecord, WorkerSession, WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";

const TRACER_KEY = Symbol.for("pi-pi:tracer");

function fakeFactory() {
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(): void; fail(error: Error): void; error?: string; setModel: ReturnType<typeof vi.fn> }> = [];
  const factory = vi.fn(async (_spec: WorkerSpawnSpec, hooks: WorkerSessionHooks): Promise<WorkerSession> => {
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const entry = {
      hooks,
      finish: () => resolve(),
      fail: (error: Error) => reject(error),
      error: undefined as string | undefined,
      setModel: vi.fn(async () => true),
    };
    sessions.push(entry);
    return {
      run: () => new Promise<void>((done, failed) => { resolve = done; reject = failed; }),
      steer() {},
      interruptTool: () => false,
      abort() { resolve(); },
      dispose() {},
      setModel: entry.setModel,
      lastAssistantText: () => "all done",
      lastError: () => entry.error,
      contextPercent: () => undefined,
      transcript: () => [],
    };
  });
  return { factory, sessions };
}

function workerHooks(overrides: Partial<WorkerHooks> = {}): WorkerHooks {
  return {
    preloadSkills: vi.fn(() => []),
    refreshDefinitions: vi.fn(),
    childExtension: vi.fn(),
    onSettled: vi.fn(),
    onProviderFailure: vi.fn(async () => false),
    onChange: vi.fn(),
    ...overrides,
  };
}

function orchestrator(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ message: any; options: any }> = [];
  const tools = new Map<string, any>();
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, ui: { getEditorText: () => "" }, modelRegistry: { registry: true } };
  const value: any = {
    cwd: "/repo",
    config: getDefaultConfig(),
    lastCtx: ctx,
    mainTurnInFlight: false,
    modelSwitchInFlight: false,
    interactivePromptOpen: false,
    workers: null,
    workerDelivery: null,
    pi: {
      sendMessage: (message: any, options: any) => sent.push({ message, options }),
      registerTool: (tool: any) => tools.set(tool.name, tool),
    },
    ...overrides,
  };
  return { orchestrator: value, sent, tools, ctx };
}

function spec(overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec {
  return { type: "explore", description: "look", prompt: "find it", model: "p/m", thinking: "high", notify: "wake", ...overrides };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function definition(type: string, frontmatter: Partial<{ model: string; ref: string; tools: string; thinking: string }> = {}) {
  return { type, variant: null, frontmatter: { description: type, tools: "read, grep", model: "p/m", thinking: "medium", ...frontmatter }, prompt: `You are ${type}.` };
}

beforeEach(() => {
  vi.useFakeTimers();
  configureRouting(getDefaultConfig());
  setCatalog(["p/m", "p/n"]);
  registerAgentDefinitions([definition("explore"), definition("task", { model: "p/n" })]);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any)[TRACER_KEY];
});

describe("createWorkers", () => {
  it("builds child sessions from the root session's registry, the role's tools and the configured bash timeout", () => {
    const hooks = workerHooks();
    const { orchestrator: orch, ctx } = orchestrator();
    orch.config.performance.internals.workerBashTimeout = 90_400;
    createWorkers(orch, hooks);
    const env = childEnv.value!;
    expect(env.cwd).toBe("/repo");
    expect(env.modelRegistry()).toBe(ctx.modelRegistry);
    expect(env.toolNames(spec())).toEqual(["read", "grep"]);
    expect(env.toolNames(spec({ type: "nobody" }))).toEqual([]);
    expect(env.bashTimeoutSec()).toBe(90);
    orch.config = null;
    expect(env.bashTimeoutSec()).toBe(0);
    const prompt = env.systemPrompt(spec());
    expect(prompt).toContain('<active_agent name="explore"/>');
    expect(prompt).toContain("Working directory: /repo");
    expect(prompt).toContain("You are explore.");
    expect(prompt).toContain("<worker_channel>");
    env.childExtension("child-pi" as any);
    expect(hooks.childExtension).toHaveBeenCalledWith("child-pi");
  });

  it("limits concurrency to the configured maximum", async () => {
    const { factory } = fakeFactory();
    const { orchestrator: orch } = orchestrator();
    orch.config.agents.maxConcurrentSubagents = 1;
    const { manager } = createWorkers(orch, workerHooks(), factory);
    manager.spawn(spec());
    const second = manager.spawn(spec());
    expect(second.status).toBe("queued");
  });

  it("wakes an idle parent with a settled worker's result and tells the host about the change", async () => {
    const { factory, sessions } = fakeFactory();
    const hooks = workerHooks();
    const { orchestrator: orch, sent } = orchestrator();
    const { manager } = createWorkers(orch, hooks, factory);
    const record = manager.spawn(spec());
    await flush();
    sessions[0]!.finish();
    await flush();
    expect(record.status).toBe("completed");
    expect(hooks.onSettled).toHaveBeenCalledWith(record);
    expect(hooks.onChange).toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.customType).toBe(WORKER_MESSAGE_TYPE);
    expect(sent[0]!.options).toEqual({ triggerTurn: true });
  });

  it("hides the update from bb, which would show its raw text, while still sending it to the model", async () => {
    process.env.BB_THREAD_ID = "thr_1";
    attachHost({ mode: "rpc" });
    try {
      const { factory, sessions } = fakeFactory();
      const { orchestrator: orch, sent } = orchestrator();
      const { manager } = createWorkers(orch, workerHooks(), factory);
      manager.spawn(spec());
      await flush();
      sessions[0]!.finish();
      await flush();
      vi.advanceTimersByTime(300);
      expect(sent[0]!.message).toMatchObject({ customType: WORKER_MESSAGE_TYPE, display: false });
    } finally {
      delete process.env.BB_THREAD_ID;
      attachHost({ mode: "tui" });
    }
  });

  it("steers a result into a running main turn", async () => {
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch, sent } = orchestrator({ mainTurnInFlight: true });
    const { manager } = createWorkers(orch, workerHooks(), factory);
    manager.spawn(spec());
    await flush();
    sessions[0]!.finish();
    await flush();
    vi.advanceTimersByTime(300);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer" });
  });

  it.each([
    ["a dialog is open", (o: any) => { o.interactivePromptOpen = true; }],
    ["the model is switching", (o: any) => { o.modelSwitchInFlight = true; }],
    ["messages are pending", (o: any) => { o.lastCtx.hasPendingMessages = () => true; }],
    ["the user is typing", (o: any) => { o.lastCtx.ui.getEditorText = () => "half a sentence"; }],
    ["there is no session context", (o: any) => { o.lastCtx = null; }],
  ])("holds the wake while %s", async (_name, block) => {
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch, sent } = orchestrator();
    const { manager } = createWorkers(orch, workerHooks(), factory);
    manager.spawn(spec());
    await flush();
    sessions[0]!.finish();
    await flush();
    const saved = orch.lastCtx;
    block(orch);
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(0);
    orch.lastCtx = { ...saved, hasPendingMessages: () => false, ui: { getEditorText: () => "  " } };
    orch.interactivePromptOpen = false;
    orch.modelSwitchInFlight = false;
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it("holds delivery while the host is between turns, then delivers", async () => {
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch, sent } = orchestrator();
    let idle = false;
    orch.lastCtx.isIdle = () => idle;
    const { manager } = createWorkers(orch, workerHooks(), factory);
    manager.spawn(spec());
    await flush();
    sessions[0]!.finish();
    await flush();
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(0);
    idle = true;
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it("delivers a question and a stall warning, but not a start phase", async () => {
    const { factory, sessions } = fakeFactory();
    const hooks = workerHooks();
    const { orchestrator: orch, sent } = orchestrator();
    orch.config.performance.internals.workerStallWarn = 1000;
    const { manager } = createWorkers(orch, hooks, factory);
    manager.spawn(spec());
    await flush();
    sessions[0]!.hooks.onEvent();
    vi.mocked(hooks.onChange).mockClear();
    manager.tick();
    expect(hooks.onChange).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2000);
    manager.tick();
    expect(hooks.onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(sent.at(-1)!.message.details.items.map((item: any) => item.kind)).toEqual(["stall"]);
    void sessions[0]!.hooks.askParent("which db?", undefined);
    vi.advanceTimersByTime(300);
    expect(sent.at(-1)!.message.details.items.map((item: any) => item.kind)).toEqual(["question"]);
  });

  it("traces the worker's life when a tracer is installed", async () => {
    const tracer = { openSubagent: vi.fn(), traceSubagent: vi.fn() };
    (globalThis as any)[TRACER_KEY] = tracer;
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch } = orchestrator();
    const { manager } = createWorkers(orch, workerHooks(), factory);
    const record = manager.spawn(spec({ parentToolCallId: "call-1" }));
    expect(tracer.openSubagent).toHaveBeenCalledWith({ subagentId: record.id, type: "explore", description: "look", parentToolCallId: "call-1", depth: 1 });
    await flush();
    sessions[0]!.finish();
    await flush();
    const kinds = tracer.traceSubagent.mock.calls.map(([, kind]) => kind);
    expect(kinds).toContain("subagent_phase");
    expect(tracer.traceSubagent).toHaveBeenCalledWith(record.id, "subagent_settled", expect.objectContaining({ status: "completed", toolUses: 0, modelId: "p/m" }));
  });

  describe("a worker that failed with an error", () => {
    async function failed(onProviderFailure: WorkerHooks["onProviderFailure"]) {
      const { factory, sessions } = fakeFactory();
      const { orchestrator: orch, sent } = orchestrator();
      const hooks = workerHooks({ onProviderFailure: vi.fn(onProviderFailure) });
      const { manager } = createWorkers(orch, hooks, factory);
      const record = manager.spawn(spec());
      await flush();
      sessions[0]!.fail(new Error("429 rate limited"));
      await flush();
      expect(hooks.onProviderFailure).toHaveBeenCalledWith(record);
      return { record, sent, manager };
    }

    it("is not reported when it was resumed on another provider", async () => {
      const { sent, record } = await failed(async (r) => { r.status = "running"; return true; });
      vi.advanceTimersByTime(60_000);
      expect(sent).toHaveLength(0);
      expect(record.status).toBe("running");
    });

    it("is reported when the routing could not move", async () => {
      const { sent, record } = await failed(async () => false);
      expect(record.status).toBe("failed");
      vi.advanceTimersByTime(300);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.message.content).toContain("429 rate limited");
    });

    it("is reported when handling the failure throws", async () => {
      const { sent } = await failed(async () => { throw new Error("boom"); });
      vi.advanceTimersByTime(300);
      expect(sent).toHaveLength(1);
    });

    it("is reported once the routing decision takes too long", async () => {
      const { sent } = await failed(() => new Promise<boolean>(() => {}));
      vi.advanceTimersByTime(29_000);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_300);
      expect(sent).toHaveLength(1);
    });
  });
});

describe("resumeOnNewRouting", () => {
  async function failedWorker() {
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch } = orchestrator();
    const { manager } = createWorkers(orch, workerHooks(), factory);
    const record = manager.spawn(spec());
    await flush();
    sessions[0]!.fail(new Error("refused"));
    await flush();
    return { manager, record };
  }

  it("moves a refused worker onto its role's current model and resumes it in place, once", async () => {
    const { manager, record } = await failedWorker();
    registerAgentDefinitions([definition("explore", { model: "p/n" })]);
    const retried = new Set<string>();
    const setModel = vi.fn(async () => true);
    expect(await resumeOnNewRouting(manager, record, retried, setModel)).toBe(true);
    expect(setModel).toHaveBeenCalledWith(record, "p/n");
    expect(record.modelId).toBe("p/n");
    expect(record.spec.model).toBe("p/n");
    expect(record.status).not.toBe("failed");
    expect(retried.has(record.id)).toBe(true);
    record.status = "failed";
    expect(await resumeOnNewRouting(manager, record, retried, setModel)).toBe(false);
  });

  it("leaves the worker failed when there is nowhere else to go", async () => {
    const { manager, record } = await failedWorker();
    const setModel = vi.fn(async () => true);
    expect(await resumeOnNewRouting(manager, record, new Set(), setModel)).toBe(false);
    registerAgentDefinitions([]);
    expect(await resumeOnNewRouting(manager, record, new Set(), setModel)).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    registerAgentDefinitions([definition("explore", { model: "p/n" })]);
    expect(await resumeOnNewRouting(manager, record, new Set(), async () => false)).toBe(false);
    expect(record.modelId).toBe("p/m");
    expect(record.status).toBe("failed");
  });

  it("does not touch a worker that is not failed", async () => {
    const { manager, record } = await failedWorker();
    record.status = "completed";
    registerAgentDefinitions([definition("explore", { model: "p/n" })]);
    const setModel = vi.fn(async () => true);
    expect(await resumeOnNewRouting(manager, record, new Set(), setModel)).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("registerWorkerToolsFor", () => {
  function setup(hookOverrides: Partial<WorkerHooks> = {}, orchOverrides: Record<string, unknown> = {}) {
    const { factory, sessions } = fakeFactory();
    const { orchestrator: orch, tools, sent } = orchestrator(orchOverrides);
    const hooks = workerHooks(hookOverrides);
    const { manager, delivery } = createWorkers(orch, hooks, factory);
    orch.workers = manager;
    orch.workerDelivery = delivery;
    registerWorkerToolsFor(orch, hooks);
    const spawn = (params: Record<string, unknown>, ctx?: any) => tools.get("Agent").execute("call-7", params, undefined, undefined, ctx);
    return { orch, tools, hooks, manager, sessions, spawn, sent };
  }

  it("spawns a worker with the role's model, the preloaded skills ahead of the prompt, and the caller's tool call id", async () => {
    const { spawn, manager, hooks } = setup({ preloadSkills: vi.fn(() => ["<skill>a</skill>"]) });
    const result = await spawn({ subagent_type: "Explore", description: "d".repeat(200), prompt: "find it", skills: ["a"], notify: "silent" });
    expect(result.isError).toBeUndefined();
    expect(hooks.preloadSkills).toHaveBeenCalledWith(["a"]);
    const record = manager.list()[0]!;
    expect(record.spec).toEqual({
      type: "explore",
      description: "d".repeat(120),
      prompt: "<skill>a</skill>\n\nfind it",
      model: "p/m",
      thinking: "medium",
      notify: "silent",
      parentToolCallId: "call-7",
    });
  });

  it("asks a reviewer for findings and defaults to waking the parent", async () => {
    const { spawn, manager, orch } = setup();
    const reviewer = `reviewer_${orch.config.agents.subagents.pools.reviewers[0].model.replace(/[/:]/g, "-")}_high`;
    registerAgentDefinitions([definition(reviewer)]);
    await spawn({ subagent_type: reviewer, description: "review", prompt: "p" });
    expect(manager.list()[0]!.spec).toMatchObject({ type: reviewer, resultSchema: "findings", notify: "wake" });
  });

  it("refuses an unknown type, listing the valid ones", async () => {
    const { spawn, manager } = setup();
    const result = await spawn({ subagent_type: "wizard", description: "d", prompt: "p" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^subagent_type must be one of: explore, librarian, task/);
    expect(manager.list()).toHaveLength(0);
  });

  it("refuses when the configuration did not load", async () => {
    const { spawn } = setup({}, { config: null });
    const result = await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    expect(result.content[0].text).toBe("Workers are unavailable: the configuration did not load.");
  });

  it("refuses a valid type whose definition is not registered yet", async () => {
    const { spawn } = setup();
    const result = await spawn({ subagent_type: "librarian", description: "d", prompt: "p" });
    expect(result.content[0].text).toBe("librarian is not registered yet; try again in a moment.");
  });

  it("passes on the skill preload's refusal", async () => {
    const { spawn } = setup({ preloadSkills: () => "Skill x is not usable by subagents." });
    const result = await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Skill x is not usable by subagents.");
  });

  it("refreshes definitions once for a role whose model has gone, and spawns on the refreshed one", async () => {
    registerAgentDefinitions([definition("explore", { model: "p/gone", ref: "claude/opus" })]);
    const refreshDefinitions = vi.fn(() => registerAgentDefinitions([definition("explore", { model: "p/n", ref: "claude/opus" })]));
    const { spawn, manager } = setup({ refreshDefinitions });
    const ctx = { ctx: true };
    await spawn({ subagent_type: "explore", description: "d", prompt: "p" }, ctx);
    expect(refreshDefinitions).toHaveBeenCalledWith(ctx);
    expect(manager.list()[0]!.spec.model).toBe("p/n");
  });

  it("explains the routing when a role still has no model after a refresh", async () => {
    registerAgentDefinitions([definition("explore", { model: "p/gone", ref: "p/gone" })]);
    const { spawn, hooks, orch } = setup();
    const result = await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    expect(hooks.refreshDefinitions).toHaveBeenCalledWith(orch.lastCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("explore has no model to run on right now (p/gone):");
    expect(result.content[0].text).toContain("pinned p/gone");
  });

  it("marks a settlement a tool showed as delivered and drops it from the push queue", async () => {
    const { spawn, tools, sessions, manager, sent } = setup();
    await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    sessions[0]!.finish();
    await flush();
    const record = manager.list()[0]!;
    expect(record.undelivered).toBe(true);
    await tools.get("agent_status").execute("s", { id: record.id });
    expect(record.undelivered).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(0);
  });

  it("drops a question a wait already showed from the push queue without touching settlements", async () => {
    const { spawn, tools, sessions, manager, sent } = setup();
    await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    await flush();
    void sessions[0]!.hooks.askParent("which?", undefined);
    const outcome = await tools.get("agent_wait").execute("w", { ids: [manager.list()[0]!.id], timeout_sec: 1 });
    expect(outcome.details.kind).toBe("question");
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(0);
  });

  it("has nothing to consume once the session's workers are gone", async () => {
    const { spawn, orch } = setup();
    orch.workers = null;
    orch.workerDelivery = null;
    const result = await spawn({ subagent_type: "explore", description: "d", prompt: "p" });
    expect(result.content[0].text).toBe("Workers are unavailable: the session is not ready.");
  });
});

describe("Paseo sub-agent cards", () => {
  afterEach(() => { delete process.env.PASEO_AGENT_ID; });

  it("sends a hidden lifecycle message per settlement under Paseo, and nothing elsewhere", async () => {
    for (const paseo of [false, true]) {
      if (paseo) process.env.PASEO_AGENT_ID = "a";
      const { factory, sessions } = fakeFactory();
      const sendMessage = vi.fn();
      const hooks = workerHooks({ sendMessage });
      const { orchestrator: orch } = orchestrator();
      const { manager } = createWorkers(orch, hooks, factory);
      manager.spawn(spec());
      await flush();
      sessions[0]!.finish();
      await flush();
      expect(sendMessage.mock.calls.length).toBe(paseo ? 1 : 0);
      if (paseo) expect(sendMessage.mock.calls[0]![0]).toEqual({ customType: "subagent-notification", content: "", display: false, details: { id: "explore-1", status: "completed", description: "look" } });
    }
  });

  it("sends a run's final status with its own file before a resumed run's update", async () => {
    process.env.PASEO_AGENT_ID = "a";
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "pp-paseo-"));
    mkdirSync(join(cwd, ".pp"));
    try {
      const { factory, sessions } = fakeFactory();
      const sendMessage = vi.fn();
      const { orchestrator: orch } = orchestrator();
      orch.cwd = cwd;
      orch.lastCtx.sessionManager = { getSessionId: () => "s" };
      const { manager } = createWorkers(orch, workerHooks({ sendMessage }), factory);
      const record = manager.spawn(spec());
      await flush();
      sessions[0]!.hooks.onMessage?.({ role: "assistant", content: [{ type: "text", text: "first run" }] });
      sessions[0]!.finish();
      await flush();
      // Resumed before the first run's transcript has necessarily drained.
      manager.send(record.id, "more");
      // Real fs writes underneath: wait on real time, not the file's fake timers.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const details = sendMessage.mock.calls.map((call) => call[0].details);
      expect(details[0]).toMatchObject({ status: "completed", outputFile: join(cwd, ".pp", "workers", "s", "explore-1.jsonl") });
      expect(details[1]).toMatchObject({ status: "running", outputFile: join(cwd, ".pp", "workers", "s", "explore-1-2.jsonl") });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
