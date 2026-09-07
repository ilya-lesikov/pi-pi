import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAcpState } from "./acp.js";
import { isSubscriptionFallbackActive, setSubscriptionFallbackActive } from "./model-registry.js";
import { classifyContinuation, isMainTurnStalled, registerEventHandlers, registerLoadSkill, registerSubagentCompaction, renderGenericPrompt } from "./event-handlers.js";

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    events: { emit: vi.fn(), on: vi.fn() },
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function emit(pi: any, name: string, event: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
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

  it("leaves the stale-agent watchdog disabled by default", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);

    await emit(pi, "subagents:created", { id: "worker", description: "Worker" }, {});

    expect(orchestrator.staleAgentTimer).toBeNull();
    expect(orchestrator.spawnedAgentIds.has("worker")).toBe(true);
  });

  it("enforces a user-configured stale-agent time limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.performance.internals.subagentStale = 1000;
    registerEventHandlers(orchestrator);

    await emit(pi, "subagents:created", { id: "worker", description: "Worker" }, {});
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
    const stale = await (pi.handlers.get("before_agent_start")?.[0] as any)({ prompt: nudge }, ctx);
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
