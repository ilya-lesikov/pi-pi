import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { registerEventHandlers } from "./event-handlers.js";
import { clearAllTierDemotions, setSubscriptionFallbackActive, setTierEnabled, updateRegistryFromAvailableModels } from "./model-registry.js";
import { retrySubagentOnNewRouting } from "./subagent-retry.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadFlantSettings: () => ({ autoRateLimitFallback: true, switchBackIntervalMinutes: 10 }),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
  refreshSubProvider: vi.fn(async () => {}),
}));

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const SUB_SPEC = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
const COPILOT_SPEC = "github-copilot/claude-opus-4.5";

function makePi(): any {
  const busHandlers = new Map<string, Array<(data: any) => any>>();
  return {
    busHandlers,
    events: {
      emit: vi.fn(),
      on: vi.fn((channel: string, handler: (data: any) => any) => {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
        return () => {};
      }),
    },
    on: vi.fn(),
    getAllTools: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    type: "task",
    description: "port the handler",
    status: "error",
    session: { setModel: vi.fn(async () => {}) },
    ...overrides,
  };
}

function installManager(record: any, running: any[] = []) {
  const resume = vi.fn(async () => record);
  (globalThis as any)[MANAGER_KEY] = {
    getRecord: (id: string) => (id === record.id ? record : undefined),
    listAgents: () => running,
    setMaxConcurrent: vi.fn(),
    resume,
  };
  return resume;
}

function makeOrchestrator(pi: any): Orchestrator {
  const orchestrator = new Orchestrator(pi);
  orchestrator.cwd = "/tmp/project";
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.config.agents.subagents.simple.task.model = SUB_SPEC;
  orchestrator.lastCtx = {
    isIdle: () => true,
    ui: { notify: vi.fn() },
    model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
  } as any;
  return orchestrator;
}

describe("retrying a rate-limited worker on the new routing", () => {
  beforeEach(() => {
    setSubscriptionFallbackActive(false);
    clearAllTierDemotions();
    setTierEnabled({ "copilot": true, "flant-sub": true, "flant-api": true });
    updateRegistryFromAvailableModels([SUB_SPEC, COPILOT_SPEC]);
  });
  afterEach(() => {
    setSubscriptionFallbackActive(false);
    updateRegistryFromAvailableModels([]);
    delete (globalThis as any)[MANAGER_KEY];
  });

  // The transcript is the point: a worker that died after thirteen tool calls
  // keeps its session, so resuming it costs one request where a fresh spawn
  // with the same prompt would buy all of that work again.
  it("re-points the retained session and resumes it in place", async () => {
    const orchestrator = makeOrchestrator(makePi());
    const record = makeRecord();
    const resume = installManager(record);
    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();

    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(true);
    expect(record.session.setModel).toHaveBeenCalledWith({ provider: "github-copilot", id: "claude-opus-4.5" });
    // Every lifecycle payload reports this, so a second failure has to name the
    // provider the worker actually ran on, not the one it was moved off.
    expect((record as any).resolvedModelId).toBe(COPILOT_SPEC);
    expect(resume).toHaveBeenCalledWith("agent-1", expect.stringContaining("continue from where you stopped"), undefined, { emitLifecycle: true });
    // The failure settled the agent; the run starting again must be tracked, or
    // the turn proceeds as though nothing were in flight.
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(true);

    // Once only: a second failure means the move did not help.
    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    orchestrator.stopStaleAgentWatchdog();
  });

  it("leaves the agent alone when routing did not move, or it was stopped rather than refused", async () => {
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.registerAgents();
    const unmoved = makeRecord();
    const resume = installManager(unmoved);
    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(false);

    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();
    const stopped = makeRecord({ id: "agent-2", status: "stopped" });
    installManager(stopped);
    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-2", modelId: SUB_SPEC })).toBe(false);

    const sessionless = makeRecord({ id: "agent-3", session: undefined });
    installManager(sessionless);
    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-3", modelId: SUB_SPEC })).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    orchestrator.stopStaleAgentWatchdog();
  });

  // The failure freed this agent's slot, and the manager drains a queued worker
  // into it before the fallback has even finished — so a resume that skips the
  // queue has to count the workers that are actually running.
  it("does not resume past the worker concurrency limit", async () => {
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.config.agents.maxConcurrentSubagents = 2;
    const record = makeRecord();
    const resume = installManager(record, [
      { id: "other-1", status: "running" },
      { id: "other-2", status: "running" },
      { id: "other-3", status: "completed" },
    ]);
    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();

    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    orchestrator.stopStaleAgentWatchdog();
  });

  // Shutdown disposes the manager's records; a retry that was between the model
  // switch and the resume gets no lifecycle event, so nothing else would take
  // this agent back out of the in-flight bookkeeping.
  it("stops tracking the agent when there is no longer a record to resume", async () => {
    const orchestrator = makeOrchestrator(makePi());
    const record = makeRecord();
    installManager(record);
    (globalThis as any)[MANAGER_KEY].resume = vi.fn(async () => undefined);
    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();

    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(false);
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(false);
    expect(orchestrator.agentSpawnTimes.has("agent-1")).toBe(false);
    orchestrator.stopStaleAgentWatchdog();
  });

  // A resume never touches the manager's own background counter, so the ceiling
  // has to come down while one runs or a fresh spawn is admitted past the limit.
  it("lowers the manager's ceiling while a retry occupies a slot", async () => {
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.config.agents.maxConcurrentSubagents = 3;
    const record = makeRecord();
    installManager(record);
    const manager = (globalThis as any)[MANAGER_KEY];
    const seen: number[] = [];
    manager.setMaxConcurrent = vi.fn((n: number) => { seen.push(n); });
    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();

    await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC });
    expect(seen).toEqual([2, 3]);
    orchestrator.stopStaleAgentWatchdog();
  });

  it("stops tracking the agent when the resume itself fails", async () => {
    const orchestrator = makeOrchestrator(makePi());
    const record = makeRecord();
    installManager(record);
    (globalThis as any)[MANAGER_KEY].resume = vi.fn(async () => { throw new Error("no tool_result for tool_use"); });
    setSubscriptionFallbackActive(true);
    orchestrator.registerAgents();

    expect(await retrySubagentOnNewRouting(orchestrator, { id: "agent-1", modelId: SUB_SPEC })).toBe(false);
    expect(orchestrator.spawnedAgentIds.has("agent-1")).toBe(false);
    expect(orchestrator.retryingSubagentIds.size).toBe(0);
    orchestrator.stopStaleAgentWatchdog();
  });

  // The whole chain: the failure must flip the routing BEFORE the retry reads
  // it, or the worker is resumed onto the provider that just refused it.
  it("resumes on the tier the fallback moved to, not the one that refused it", async () => {
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const record = makeRecord();
    const resume = installManager(record);
    registerEventHandlers(orchestrator);
    orchestrator.registerAgents();

    for (const handler of pi.busHandlers.get("subagents:failed") ?? []) {
      await handler({ id: "agent-1", type: "task", modelId: SUB_SPEC, error: "HTTP 429 rate limit exceeded" });
    }
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    expect(record.session.setModel).toHaveBeenCalledWith({ provider: "github-copilot", id: "claude-opus-4.5" });
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
    orchestrator.stopStaleAgentWatchdog();
  });
});
