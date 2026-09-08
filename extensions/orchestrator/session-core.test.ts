import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAcpState } from "./acp.js";
import { isSubscriptionFallbackActive, setSubscriptionFallbackActive } from "./model-registry.js";
import { classifyContinuation, isMainTurnStalled, registerEventHandlers, registerLoadSkill, registerSubagentCompaction, renderGenericPrompt } from "./event-handlers.js";
import { createUsageTracker } from "./usage-tracker.js";
import initExtension from "./index.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");
const SUBAGENT_SESSION_SCOPE_KEY = Symbol.for("pi-pi:subagent-session-scope");

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const busHandlers = new Map<string, Array<(data: any) => any>>();
  return {
    handlers,
    busHandlers,
    events: {
      emit: vi.fn((channel: string, data: any) => {
        for (const handler of busHandlers.get(channel) ?? []) void handler(data);
      }),
      on: vi.fn((channel: string, handler: (data: any) => any) => {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
        return () => busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter((h) => h !== handler));
      }),
    },
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function emit(pi: any, name: string, event: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
}

async function emitBus(pi: any, channel: string, data: any): Promise<void> {
  for (const handler of pi.busHandlers.get(channel) ?? []) await handler(data);
}

/** First handler result for an event; several handlers may listen, only one answers. */
async function emitForResult(pi: any, name: string, event: any, ctx: any): Promise<any> {
  for (const handler of pi.handlers.get(name) ?? []) {
    const result = await handler(event, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

describe("session-first core", () => {
  it("renders one generic prompt without workflow state or coding-only policy", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.contextInjection = {
      globalAgents: false,
      globalClaude: false,
      ancestorAgents: false,
      ancestorClaude: false,
      projectAgents: false,
      projectClaude: false,
    };
    const prompt = renderGenericPrompt(orchestrator, {
      model: { provider: "test", id: "model" },
      ui: { notify: vi.fn() },
    }, ["read", "vcc_recall", "load_skill"]);
    expect(prompt).toContain("Own the request end to end");
    expect(prompt).toContain("After two failed attempts driven by the same hypothesis");
    expect(prompt).toContain("vcc_recall: retrieve full detail");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("When reporting finished work");
    expect(prompt).not.toContain("ACTIVE PHASE");
    expect(prompt).not.toContain("There are no task modes");
    expect(prompt).not.toContain("USER_REQUEST.md");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("Implement only the approved plan");
  });

  it("keeps root hooks live after a subagent session has loaded the extension in-process", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { cwd: orchestrator.cwd, model: { provider: "test", id: "model" }, ui: { notify: vi.fn() }, sessionManager: {} };
    expect((await emitForResult(pi, "before_agent_start", { prompt: "first" }, ctx))?.systemPrompt).toContain("<identity>");
    expect((await emitForResult(pi, "before_agent_start", { prompt: "after spawn" }, ctx))?.systemPrompt).toContain("<identity>");
    orchestrator.mainTurnTimer = setInterval(() => {}, 60_000);
    await emit(pi, "session_shutdown", {}, ctx);
    expect(orchestrator.mainTurnTimer).toBeNull();
  });

  // The host re-instantiates every extension on /new, /resume and fork. Before,
  // a global "already initialized" flag made the second instantiation take the
  // subagent branch, so the new root session silently lost its event handlers,
  // its /pp command, its footer and its configured main model.
  it("registers root handlers again each time the host re-instantiates the extension", () => {
    (globalThis as any)[ORCHESTRATOR_KEY] = true;
    try {
      const second = makePi();
      initExtension(second);
      expect(second.handlers.get("session_start")?.length).toBe(1);
      expect(second.handlers.get("before_agent_start")?.length).toBeGreaterThan(0);
      expect(second.registerCommand).toHaveBeenCalledWith("pp", expect.anything());
    } finally {
      delete (globalThis as any)[ORCHESTRATOR_KEY];
    }
  });

  it("takes the subagent branch only inside a subagent-session scope", () => {
    (globalThis as any)[ORCHESTRATOR_KEY] = true;
    (globalThis as any)[SUBAGENT_SESSION_SCOPE_KEY] = { getStore: () => ({ depth: 1 }) };
    try {
      const child = makePi();
      initExtension(child);
      expect(child.handlers.get("session_start")).toBeUndefined();
      expect(child.registerCommand).not.toHaveBeenCalledWith("pp", expect.anything());
    } finally {
      delete (globalThis as any)[SUBAGENT_SESSION_SCOPE_KEY];
      delete (globalThis as any)[ORCHESTRATOR_KEY];
    }
  });

  it("applies the configured main agent model and thinking to the root session", async () => {
    const pi = makePi();
    pi.setModel = vi.fn(async () => true);
    pi.setThinkingLevel = vi.fn();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.agents.main = { model: "test/main-model", thinking: "low" };
    const model = { provider: "test", id: "main-model" };
    const ctx: any = { modelRegistry: { find: vi.fn((p: string, id: string) => (p === "test" && id === "main-model" ? model : undefined)) } };
    expect(await orchestrator.applyMainAgent(ctx)).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(model);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");

    orchestrator.config.agents.main = { model: "test/missing", thinking: "high" };
    expect(await orchestrator.applyMainAgent(ctx)).toBe(false);
    expect(pi.setModel).toHaveBeenCalledTimes(1);
  });

  it("publishes session activity rather than a phase plan", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    expect(buildAcpState(orchestrator)).toEqual({ status: "idle", subagents: [] });
    orchestrator.mainTurnInFlight = true;
    expect(buildAcpState(orchestrator)).toEqual({ status: "running", subagents: [] });
    orchestrator.interactivePromptOpen = true;
    expect(buildAcpState(orchestrator)).toEqual({ status: "waiting", subagents: [] });
  });

  it("classifies only objective stops and substantial action-backed prose stops for continuation", () => {
    const idle = { hadTools: false, toolCallCount: 0, hadFileMutation: false };
    const trivial = { hadTools: true, toolCallCount: 2, hadFileMutation: false };
    const manyTools = { hadTools: true, toolCallCount: 4, hadFileMutation: false };
    const mutated = { hadTools: true, toolCallCount: 1, hadFileMutation: true };
    expect(classifyContinuation({ stopReason: "length", content: [{ type: "text", text: "cut" }] }, idle)).toBe("objective");
    expect(classifyContinuation({ stopReason: "stop", content: [] }, idle)).toBe("objective");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "answer" }] }, idle)).toBe("none");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "it is 5pm" }] }, trivial)).toBe("none");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "done" }] }, manyTools)).toBe("adjudicate");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "done" }] }, mutated)).toBe("adjudicate");
    expect(classifyContinuation({ stopReason: "error", content: [] }, mutated)).toBe("none");
  });

  it("recognizes a stalled main turn only when recovery is safe", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.performance.internals.mainTurnStale = 1000;
    orchestrator.mainTurnInFlight = true;
    orchestrator.mainTurnLastActivity = 1000;
    expect(isMainTurnStalled(orchestrator, 2000)).toBe(true);
    orchestrator.interactivePromptOpen = true;
    expect(isMainTurnStalled(orchestrator, 3000)).toBe(false);
    orchestrator.interactivePromptOpen = false;
    orchestrator.spawnedAgentIds.add("worker");
    expect(isMainTurnStalled(orchestrator, 3000)).toBe(false);
    orchestrator.spawnedAgentIds.clear();
    orchestrator.mainTurnToolInFlight = 1;
    expect(isMainTurnStalled(orchestrator, 3000)).toBe(false);
  });

  // The host reports idle while a compaction runs, so a continuation queued by
  // the rate-limit fallback would otherwise land mid-rebuild.
  it("holds a queued continuation until an in-flight compaction settles", () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.lastCtx = { isIdle: () => true } as any;
      orchestrator.adaptiveCompaction.inFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      orchestrator.adaptiveCompaction.inFlight = false;
      vi.advanceTimersByTime(1000);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Polling gives up after two minutes, so a compaction that outlasts it has to
  // hand the continuation back instead of dropping it.
  it("redelivers a continuation stranded by a long compaction", async () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      const ctx = { isIdle: () => true } as any;
      orchestrator.lastCtx = ctx;
      orchestrator.adaptiveCompaction.inFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      vi.advanceTimersByTime(200_000);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      orchestrator.adaptiveCompaction.inFlight = false;
      await emit(pi, "session_compact", {}, ctx);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A redelivery does not cancel the poll chain it overlaps, so the queue entry
  // is the claim that keeps one continuation from being sent twice.
  it("delivers a continuation once even when redelivery overlaps a live poll", async () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      const ctx = { isIdle: () => true } as any;
      orchestrator.lastCtx = ctx;
      orchestrator.adaptiveCompaction.inFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      vi.advanceTimersByTime(3000);
      orchestrator.adaptiveCompaction.inFlight = false;
      await emit(pi, "session_compact", {}, ctx);
      vi.advanceTimersByTime(5000);

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Claiming the queue entry before sending must not lose the message when the
  // host refuses it — a later redelivery is the only thing that can recover it.
  it("re-queues a continuation the host refused", async () => {
    const pi = makePi();
    pi.sendUserMessage = vi.fn(() => { throw new Error("host busy"); });
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { isIdle: () => true } as any;
    orchestrator.lastCtx = ctx;

    orchestrator.queueContinuation("[PI-PI] continue");
    expect(orchestrator.pendingContinuations.size).toBe(1);

    pi.sendUserMessage = vi.fn();
    await emit(pi, "session_compact", {}, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingContinuations.size).toBe(0);
  });

  // A provider switch resends everything with a cold cache, so the pre-switch
  // context is billed again in full at the new provider.
  it("compacts a large context before a model switch, but not a small one", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const compact = vi.fn();
    const ctx = (tokens: number) => ({ compact, getContextUsage: () => ({ tokens, contextWindow: 200_000 }) });
    const select = (from: string, to: string) => ({
      source: "set",
      previousModel: { provider: "pp-flant-anthropic-sub", id: from },
      model: { provider: "github-copilot", id: to },
    });

    await emit(pi, "model_select", select("a", "b"), ctx(5_000));
    expect(compact).not.toHaveBeenCalled();

    await emit(pi, "model_select", select("a", "b"), ctx(120_000));
    expect(compact).toHaveBeenCalledTimes(1);

    orchestrator.adaptiveCompaction.inFlight = false;
    await emit(pi, "model_select", { source: "restore", previousModel: { provider: "p", id: "a" }, model: { provider: "q", id: "b" } }, ctx(120_000));
    await emit(pi, "model_select", { source: "set", previousModel: { provider: "p", id: "a" }, model: { provider: "p", id: "a" } }, ctx(120_000));
    expect(compact).toHaveBeenCalledTimes(1);
  });

  // The tracing toggle and the report bundle both promise recorded traces, but
  // nothing called into the tracer, so enabled traces held only the finalizer.
  it("records main and worker events into the session trace", async () => {
    const { initTracer, finalizeTracer } = await import("./tracer.js");
    const dir = mkdtempSync(join(tmpdir(), "pp-trace-"));
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.cwd = dir;
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      initTracer(join(dir, ".pp"), "trace-session");

      await emit(pi, "tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "a.ts" } }, {});
      await emitBus(pi, "subagents:created", { id: "worker", type: "explore", description: "Worker", toolCallId: "call-7" });
      await emitBus(pi, "subagents:completed", { id: "worker", status: "completed" });
      finalizeTracer();

      const main = readFileSync(join(dir, ".pp", "logs", "traces", "trace-session", "main.jsonl"), "utf-8");
      expect(main).toContain('"kind":"tool_execution_start"');
      expect(main).toContain('"kind":"subagent_spawned"');
      // The spawning tool call is what ties a worker trace back to the turn that started it.
      expect(main).toContain('"parentToolCallId":"call-7"');
      const worker = readFileSync(join(dir, ".pp", "logs", "traces", "trace-session", "worker.jsonl"), "utf-8");
      expect(worker).toContain('"kind":"subagent_settled"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the stale-agent watchdog disabled by default", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);

    await emitBus(pi, "subagents:created", { id: "worker", description: "Worker" });

    expect(orchestrator.staleAgentTimer).toBeNull();
    expect(orchestrator.spawnedAgentIds.has("worker")).toBe(true);
  });

  // pi-subagents publishes on the shared event bus; wiring these to pi.on()
  // silently detached worker tracking and worker usage accounting.
  it("records worker usage and clears worker tracking on the completed event", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const usage = createUsageTracker();
    (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] = usage;
    try {
      await emitBus(pi, "subagents:created", { id: "worker", description: "Worker" });
      await emitBus(pi, "subagents:completed", {
        id: "worker",
        type: "explore",
        description: "Worker",
        modelId: "test/model",
        tokens: { input: 10, output: 4 },
      });
    } finally {
      delete (globalThis as any)[Symbol.for("pi-pi:usage-tracker")];
    }

    expect(orchestrator.spawnedAgentIds.has("worker")).toBe(false);
    expect(usage.getSubagentTotals()).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(usage.getSubagentList()[0]).toMatchObject({ agentType: "explore", modelId: "test/model" });
  });

  it("enforces a user-configured stale-agent time limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.performance.internals.subagentStale = 1000;
    registerEventHandlers(orchestrator);

    await emitBus(pi, "subagents:created", { id: "worker", description: "Worker" });
    vi.setSystemTime(1001);
    await vi.advanceTimersByTimeAsync(1000);

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:rpc:stop", expect.objectContaining({ agentId: "worker" }));
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pp-agent-stale" }), { deliverAs: "steer" });
    expect(orchestrator.spawnedAgentIds.has("worker")).toBe(false);
    vi.useRealTimers();
  });

  it("marks ask_user execution as waiting, suppresses recovery, and clears abnormal terminal state", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { ui: { notify: vi.fn() } };
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "tool_execution_start", { toolName: "ask_user" }, ctx);
    expect(orchestrator.interactivePromptOpen).toBe(true);
    expect(buildAcpState(orchestrator).status).toBe("waiting");
    expect(isMainTurnStalled(orchestrator, Date.now() + orchestrator.config.performance.internals.mainTurnStale)).toBe(false);
    await emit(pi, "turn_end", { message: { stopReason: "aborted", content: [] } }, ctx);
    expect(orchestrator.interactivePromptOpen).toBe(false);
    await emit(pi, "tool_execution_start", { toolName: "ask_user" }, ctx);
    await emit(pi, "session_shutdown", {}, ctx);
    expect(orchestrator.interactivePromptOpen).toBe(false);
  });

  it("self-adjudicates action-backed prose once and resets on genuine user input", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = {
      cwd: orchestrator.cwd,
      model: { provider: "test", id: "model" },
      isIdle: () => true,
      getContextUsage: () => null,
      ui: { notify: vi.fn() },
    };
    await emit(pi, "before_agent_start", { prompt: "Implement the change" }, ctx);
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "tool_execution_start", { toolName: "edit" }, ctx);
    await emit(pi, "tool_execution_end", { toolName: "edit" }, ctx);
    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "turn_end", { message: { stopReason: "stop", content: [{ type: "text", text: "I changed it." }] } }, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const nudge = pi.sendUserMessage.mock.calls[0][0];
    expect(nudge).toContain("If the user's request is fully complete");
    expect(orchestrator.continuationCount).toBe(1);
    await emit(pi, "before_agent_start", { prompt: nudge }, ctx);
    expect(orchestrator.continuationCount).toBe(1);
    await emit(pi, "before_agent_start", { prompt: "New user request" }, ctx);
    expect(orchestrator.continuationCount).toBe(0);
    expect(orchestrator.continuationHalted).toBe(false);
    const stale = await emitForResult(pi, "before_agent_start", { prompt: nudge }, ctx);
    expect(stale.systemPrompt).toContain("obsolete automatic continuation");
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("recovers a stalled turn once and suppresses repeated watchdog ticks", async () => {
    vi.useFakeTimers();
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.performance.internals.mainTurnStale = 1000;
    registerEventHandlers(orchestrator);
    const ctx = { abort: vi.fn(), isIdle: () => true, getContextUsage: () => null, ui: { notify: vi.fn() } };
    await emit(pi, "turn_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    await emit(pi, "session_shutdown", {}, ctx);
    vi.useRealTimers();
  });

  it("resets process-global provider fallback during shutdown", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackModelId = "sub/model";
    setSubscriptionFallbackActive(true);
    registerEventHandlers(orchestrator);
    await emit(pi, "session_shutdown", {}, { sessionManager: {}, ui: {} });
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.subFallbackModelId).toBeNull();
    expect(isSubscriptionFallbackActive()).toBe(false);
  });

  it("does not nudge a pure prose answer", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { getContextUsage: () => null, ui: { notify: vi.fn() } };
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "turn_end", { message: { stopReason: "stop", content: [{ type: "text", text: "The answer is 42." }] } }, ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("does not compact a worker between a tool result and its next model step", async () => {
    const pi = makePi();
    const config = normalizeConfigDurations(getDefaultConfig());
    config.compaction.floorTokens = 1_000;
    config.compaction.fraction = 0.1;
    registerSubagentCompaction(pi, config);
    const compact = vi.fn();
    const ctx = {
      model: { provider: "test", id: "worker-model" },
      getContextUsage: () => ({ contextWindow: 100_000, tokens: 20_000 }),
      compact,
    };
    await emit(pi, "turn_end", { message: { stopReason: "toolUse" } }, ctx);
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact the main agent between a tool result and its next model step", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.compaction.floorTokens = 1_000;
    orchestrator.config.compaction.fraction = 0.1;
    registerEventHandlers(orchestrator);
    const compact = vi.fn();
    const ctx = {
      model: { provider: "test", id: "main-model" },
      getContextUsage: () => ({ contextWindow: 100_000, tokens: 20_000 }),
      compact,
      ui: { notify: vi.fn() },
    };
    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);
    expect(compact).not.toHaveBeenCalled();
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("uses VCC and configured per-model thresholds in worker sessions", async () => {
    const pi = makePi();
    const config = normalizeConfigDurations(getDefaultConfig());
    config.compaction.floorTokens = 90_000;
    config.compaction.fraction = 0.9;
    config.compaction.perModel["worker-model"] = { fraction: 0.1, floorTokens: 1_000 };
    registerSubagentCompaction(pi, config);
    const compact = vi.fn();
    const ctx = {
      model: { provider: "test", id: "worker-model" },
      getContextUsage: () => ({ contextWindow: 100_000, tokens: 20_000 }),
      compact,
    };
    await emit(pi, "turn_end", { message: { stopReason: "stop" } }, ctx);
    expect(compact).toHaveBeenCalledTimes(1);

    const beforeCompact = pi.handlers.get("session_before_compact")?.[0] as any;
    const result = await beforeCompact({
      preparation: {
        messagesToSummarize: [{ role: "user", content: "worker detail" }],
        previousSummary: undefined,
        firstKeptEntryId: "kept",
        tokensBefore: 20_000,
      },
      branchEntries: [{ id: "old" }, { id: "kept" }],
    });
    expect(result.compaction.summary).toContain("[Session Goal]");
    expect(result.compaction.details.compactor).toBe("pi-vcc");

    // On a split turn the host discards the prefix of the cut turn too, so it
    // must reach the summary rather than vanishing with the dropped history.
    const split = await beforeCompact({
      preparation: {
        messagesToSummarize: [{ role: "user", content: "older history" }],
        turnPrefixMessages: [{ role: "assistant", content: "split-turn prefix detail" }],
        firstKeptEntryId: "kept",
        tokensBefore: 20_000,
      },
      branchEntries: [{ id: "old" }, { id: "kept" }],
    });
    expect(split.compaction.details.sourceMessageCount).toBe(2);
  });

  it("never hands a compaction back to the host LLM summarizer", async () => {
    const pi = makePi();
    registerSubagentCompaction(pi, normalizeConfigDurations(getDefaultConfig()));
    const beforeCompact = pi.handlers.get("session_before_compact")?.[0] as any;

    // Nothing to summarize: the host would otherwise LLM-summarize the split
    // turn prefix, or write an LLM summary of an empty history.
    const empty = await beforeCompact({
      preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: "kept", tokensBefore: 900_000 },
      branchEntries: [{ id: "kept" }],
    });
    expect(empty.compaction.details.compactor).toBe("pi-vcc");
    expect(typeof empty.compaction.summary).toBe("string");
    expect(empty.compaction.firstKeptEntryId).toBe("kept");

    // Messages that carry no extractable content compile to an empty summary,
    // which is still ours rather than a fallback to the host.
    const blank = await beforeCompact({
      preparation: { messagesToSummarize: [{ role: "user", content: "" }], firstKeptEntryId: "kept", tokensBefore: 10 },
      branchEntries: [{ id: "old" }, { id: "kept" }],
    });
    expect(blank.compaction.details.compactor).toBe("pi-vcc");
    expect(blank.compaction.summary.length).toBeGreaterThan(0);

    // A summarizer crash must not silently yield to the host either.
    const crashed = await beforeCompact({
      preparation: {
        get messagesToSummarize(): never { throw new Error("boom"); },
        firstKeptEntryId: "kept",
        tokensBefore: 5,
      },
      branchEntries: [{ id: "old" }, { id: "kept" }],
    });
    expect(crashed.compaction.details.compactor).toBe("pi-vcc");
    expect(crashed.compaction.firstKeptEntryId).toBe("kept");

    // A preparation the host could not build is the only legitimate bail-out.
    expect(await beforeCompact({ branchEntries: [] })).toBeUndefined();
  });

  it("makes layered skills loadable in worker processes", async () => {
    const pi = makePi();
    registerLoadSkill(pi, "/tmp/project");
    const registration = pi.registerTool.mock.calls.find((call: any[]) => call[0].name === "load_skill")[0];
    expect(registration.description).toContain("software-engineering");
    const result = await registration.execute("id", { name: "software-engineering" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('<skill name="software-engineering" source="bundled">');
  });

  it("registers workers without context inheritance or worktree isolation", () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.registerAgents();
    const registration = pi.events.emit.mock.calls.find((call: any[]) => call[0] === "subagents:register-agents");
    const agents = registration[1].agents as Map<string, any>;
    expect(agents.size).toBeGreaterThanOrEqual(6);
    for (const agent of agents.values()) {
      expect(agent.inheritContext).toBe(false);
      expect(agent.isolated).toBe(false);
      expect(agent.builtinToolNames).toContain("vcc_recall");
    }
  });
});
