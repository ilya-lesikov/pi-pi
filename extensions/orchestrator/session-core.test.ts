import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAcpState } from "./acp.js";
import { isSubscriptionFallbackActive, setSubscriptionFallbackActive, setTierEnabled, updateRegistryFromAvailableModels } from "./model-registry.js";
import { classifyContinuation, isMainTurnStalled, registerEventHandlers, registerLoadSkill, registerSubagentPromptcap, renderGenericPrompt } from "./event-handlers.js";
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
    }, ["read", "vcc_recall", "recall_tool_output", "load_skill"]);
    expect(prompt).toContain("Own the request end to end");
    expect(prompt).toContain("After two failed attempts driven by the same hypothesis");
    expect(prompt).toContain("vcc_recall: retrieve full detail");
    // The [omitted: …] notice means nothing without the sentence that explains it.
    expect(prompt).toContain("recall_tool_output");
    expect(prompt).toContain("[omitted: <size>B; <call_id>]");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("When reporting finished work");
    expect(prompt).not.toContain("ACTIVE PHASE");
    expect(prompt).not.toContain("There are no task modes");
    expect(prompt).not.toContain("USER_REQUEST.md");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("Implement only the approved plan");
  });

  it("front-loads clarification and gates implementation behind one approval", () => {
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
    }, ["read", "ask_user"]);
    expect(prompt).toContain("<request_phases>");
    // Questions in the request are answered before any implementation starts,
    // and the answer is a stop: the user reacts to it before the work begins.
    expect(prompt).toContain("answer every question the request contains");
    expect(prompt).toContain("not a step on the way to the work");
    // The observed failure: the answer was given and the same turn carried on
    // into the work, so the user never got to react to it.
    expect(prompt).toContain("The turn in which you answer it ENDS on that answer");
    expect(prompt).toContain("do not answer and announce that you are starting");
    expect(prompt).toContain("never act on your own answer to theirs");
    // A courtesy check-in ends the turn for nothing, so phase 3 forbids it
    // rather than relying on the continuation handler to nudge past it.
    expect(prompt).toContain("Never end a turn with a question you would proceed without an answer to");
    // The proposal blocks, and it blocks via ask_user — a prose-only stop is
    // nudged back into work by the continuation handler, so it cannot gate.
    expect(prompt).toContain("WAIT for the answer");
    // ...but the call alone cannot gate either: with nothing written above it,
    // the de-emphasized question field is left carrying the whole proposal and
    // the user sees a bare demand for approval. Both, always.
    expect(prompt).toContain("Write both out as a message");
    expect(prompt).toContain("a proposal in prose alone just ends the turn");
    expect(prompt).toContain("an ask_user with nothing written above it");
    expect(prompt).toContain("Never move the substance into the question field");
    // A question can also arrive as the freeform answer to your own ask_user;
    // the observed failure was answering it with another ask_user, four times
    // running, instead of writing the answer out and stopping.
    expect(prompt).toContain("including as the freeform answer to your own ask_user");
    expect(prompt).toContain("is not a vote on your options");
    expect(prompt).toContain("never put the answer in the next question field");
    // Phase 3 must not need the user again.
    expect(prompt).toContain("without further check-ins");
    // The old blanket instruction contradicted the gate and must be gone.
    expect(prompt).not.toContain("wait for plan approval unless asked");
    // One turn, not one question: batching into a single turn must not be read
    // as forbidding the sequential `questions` array, which is how the design
    // skill's one-at-a-time rule is honored without extra round trips.
    expect(prompt).toContain("questions array");
    // An answer that reshapes the approach needs a second call, since the
    // proposal cannot be written inside an already-issued question.
    expect(prompt).toContain("changes the shape of the solution");
    // Self-approval is the specific failure to name: an agent that asks in
    // prose, gets nudged, and answers its own question has not asked at all.
    expect(prompt).toContain("Never answer your own question");
  });

  it("forbids interim prose so only the final message is written", () => {
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
    }, ["read"]);
    expect(prompt).toContain("Do not write prose while working");
    expect(prompt).toContain("one message, at the end");
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

  // A session that STARTS while the preferred tier is unusable resolves main
  // onto the lower one, and nothing else ever moves it back: the rate-limit
  // switch-back is the only restore path and it never ran for this session.
  it("restores the main model once its preferred tier is usable again", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    updateRegistryFromAvailableModels(specs);
    setTierEnabled({ "copilot": true, "flant-sub": false, "flant-api": true });
    const pi = makePi();
    pi.setModel = vi.fn(async () => true);
    pi.setThinkingLevel = vi.fn();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.agents.main = { model: "pp-flant-anthropic-sub/sub/claude-opus-4-8", thinking: "high" };
    const registry = {
      find: vi.fn((provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined)),
    };

    const ctx: any = { modelRegistry: registry, ui: { notify: vi.fn() } };
    expect(await orchestrator.applyMainAgent(ctx)).toBe(true);
    expect(orchestrator.routedMainSpec).toBe("github-copilot/claude-opus-4.5");

    ctx.model = { provider: "github-copilot", id: "claude-opus-4.5" };
    await orchestrator.restoreMainRouting(ctx);
    expect(pi.setModel).toHaveBeenCalledTimes(1);

    setTierEnabled({ "flant-sub": true });
    await orchestrator.restoreMainRouting(ctx);
    expect(pi.setModel).toHaveBeenLastCalledWith({ provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" });

    setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    updateRegistryFromAvailableModels([]);
  });

  it("leaves a model the user picked alone, and holds off while a fallback is live", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    updateRegistryFromAvailableModels(specs);
    setTierEnabled({ "copilot": true, "flant-sub": false, "flant-api": true });
    const pi = makePi();
    pi.setModel = vi.fn(async () => true);
    pi.setThinkingLevel = vi.fn();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.agents.main = { model: "pp-flant-anthropic-sub/sub/claude-opus-4-8", thinking: "high" };
    const ctx: any = {
      modelRegistry: { find: vi.fn((provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined)) },
      ui: { notify: vi.fn() },
    };
    await orchestrator.applyMainAgent(ctx);
    pi.setModel.mockClear();
    setTierEnabled({ "flant-sub": true });

    ctx.model = { provider: "github-copilot", id: "gpt-5.6-sol" };
    await orchestrator.restoreMainRouting(ctx);
    expect(pi.setModel).not.toHaveBeenCalled();

    ctx.model = { provider: "github-copilot", id: "claude-opus-4.5" };
    orchestrator.subFallbackActive = true;
    await orchestrator.restoreMainRouting(ctx);
    expect(pi.setModel).not.toHaveBeenCalled();

    setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    updateRegistryFromAvailableModels([]);
  });

  // The rate-limit switch-back restores whatever model was live when the limit
  // hit — possibly one the user picked by hand. Recording that as pi-pi's own
  // routing choice would let the next turn overwrite it with the config main.
  it("does not claim a model the rate-limit switch-back restored", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    updateRegistryFromAvailableModels(specs);
    setTierEnabled({ "copilot": true, "flant-sub": true, "flant-api": true });
    const pi = makePi();
    pi.setModel = vi.fn(async () => true);
    pi.setThinkingLevel = vi.fn();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.agents.main = { model: "pp-flant-anthropic-sub/sub/claude-opus-4-8", thinking: "high" };
    const ctx: any = {
      modelRegistry: { find: vi.fn((provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined)) },
      ui: { notify: vi.fn() },
    };

    // The switch-back path: switchModel with the spec that was live before.
    await orchestrator.switchModel(ctx, "github-copilot/claude-opus-4.5", "high");
    expect(orchestrator.routedMainSpec).toBeNull();

    ctx.model = { provider: "github-copilot", id: "claude-opus-4.5" };
    pi.setModel.mockClear();
    await orchestrator.restoreMainRouting(ctx);
    expect(pi.setModel).not.toHaveBeenCalled();

    setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    updateRegistryFromAvailableModels([]);
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
    const idle = { hadTools: false, toolCallCount: 0, hadFileMutation: false, hadEdit: false };
    const trivial = { hadTools: true, toolCallCount: 2, hadFileMutation: false, hadEdit: false };
    const manyTools = { hadTools: true, toolCallCount: 4, hadFileMutation: false, hadEdit: false };
    const mutated = { hadTools: true, toolCallCount: 1, hadFileMutation: true, hadEdit: true };
    expect(classifyContinuation({ stopReason: "length", content: [{ type: "text", text: "cut" }] }, idle)).toBe("objective");
    expect(classifyContinuation({ stopReason: "stop", content: [] }, idle)).toBe("objective");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "answer" }] }, idle)).toBe("none");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "it is 5pm" }] }, trivial)).toBe("none");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "done" }] }, manyTools)).toBe("adjudicate");
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "done" }] }, mutated)).toBe("adjudicate");
    expect(classifyContinuation({ stopReason: "error", content: [] }, mutated)).toBe("none");
  });

  it("routes a turn that handed control back with a question to the check-in adjudicator", () => {
    const mutated = { hadTools: true, toolCallCount: 8, hadFileMutation: true, hadEdit: true };
    // A closing question after real work is as often a check-in the user
    // already approved past as a decision they own, so it is adjudicated
    // rather than nudged or accepted on sight.
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "Found two options. Want me to close that gap?" }] }, mutated)).toBe("check-in");
    // Trailing whitespace and closing blank lines must not defeat the check.
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "Which one?  \n\n" }] }, mutated)).toBe("check-in");
    // A question mid-report followed by a conclusion is NOT a handoff.
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "Why did it fail? The cache was stale. Fixed and committed." }] }, mutated)).toBe("adjudicate");
    // Multi-part content: the last text part decides.
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "Did the work." }, { type: "text", text: "Proceed with the rename?" }] }, mutated)).toBe("check-in");
    // Research and delegation are what clarification is made of, so a question
    // that follows them is a genuine hand-back, however many calls it took.
    expect(classifyContinuation({ stopReason: "stop", content: [{ type: "text", text: "Which one?" }] }, { hadTools: true, toolCallCount: 12, hadFileMutation: true, hadEdit: false })).toBe("none");
  });

  it("leaves a finished-looking turn alone when its own model says nothing is left", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const queued: string[] = [];
    orchestrator.queueContinuation = (text: string) => { queued.push(text); };
    orchestrator.requestHadTools = true;
    orchestrator.requestToolCallCount = 6;
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "NO" }] }));
    await emit(pi, "turn_end", {
      message: { stopReason: "stop", content: [{ type: "text", text: "Here is the approach. Let me know." }] },
    }, { model: { provider: "test", id: "m" }, modelRegistry: { complete }, ui: { notify: vi.fn() } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(queued).toEqual([]);
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

  // The host reports idle throughout a parked model switch, so a continuation
  // queued by the rate-limit fallback would otherwise run on the model the
  // switch is about to leave behind.
  it("holds a queued continuation until an in-flight model switch settles", () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.lastCtx = { isIdle: () => true } as any;
      orchestrator.modelSwitchInFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      orchestrator.modelSwitchInFlight = false;
      vi.advanceTimersByTime(1000);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Polling gives up after two minutes, so a switch that outlasts it has to hand
  // the continuation back instead of dropping it.
  it("redelivers a continuation stranded by a long model switch", async () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      const ctx = { isIdle: () => true } as any;
      orchestrator.lastCtx = ctx;
      orchestrator.modelSwitchInFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      vi.advanceTimersByTime(200_000);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      orchestrator.modelSwitchInFlight = false;
      orchestrator.redeliverPendingContinuations();
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
      orchestrator.modelSwitchInFlight = true;

      orchestrator.queueContinuation("[PI-PI] continue");
      vi.advanceTimersByTime(3000);
      orchestrator.modelSwitchInFlight = false;
      orchestrator.redeliverPendingContinuations();
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
    orchestrator.redeliverPendingContinuations();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingContinuations.size).toBe(0);
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

  it("resumes an unfinished turn through a hidden message and resets on genuine user input", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "YES" }] }));
    const ctx = {
      cwd: orchestrator.cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: { complete },
      isIdle: () => true,
      getContextUsage: () => null,
      getSystemPrompt: () => "system",
      ui: { notify: vi.fn() },
    };
    await emit(pi, "before_agent_start", { prompt: "Implement the change" }, ctx);
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "tool_execution_start", { toolName: "edit" }, ctx);
    await emit(pi, "tool_execution_end", { toolName: "edit" }, ctx);
    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);
    expect(complete).not.toHaveBeenCalled();
    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "turn_end", { message: { stopReason: "stop", content: [{ type: "text", text: "I changed it." }] } }, ctx);

    // The nudge reaches the model but never the transcript.
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [nudge, options] = pi.sendMessage.mock.calls[0];
    expect(nudge).toMatchObject({ customType: "pp-continuation", display: false });
    expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(orchestrator.continuationCount).toBe(1);

    await emit(pi, "before_agent_start", { prompt: "New user request" }, ctx);
    expect(orchestrator.continuationCount).toBe(0);
    expect(orchestrator.continuationHalted).toBe(false);

    // A visible continuation still carries its generation, so a stale redelivery
    // is recognized as superseded.
    orchestrator.queueContinuation("[PI-PI] older");
    const stale = await emitForResult(pi, "before_agent_start", { prompt: "[PI-PI] older\n[continuation:0]" }, ctx);
    expect(stale.systemPrompt).toContain("obsolete automatic continuation");
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("nudges past a check-in its own model calls optional and leaves a blocking one standing", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const complete = vi.fn(async (_model: any, _context: any) => ({ content: [{ type: "text", text: "OPTIONAL" }] }));
    const ctx = {
      model: { provider: "test", id: "model" },
      modelRegistry: { complete },
      isIdle: () => true,
      getContextUsage: () => null,
      getSystemPrompt: () => "system",
      ui: { notify: vi.fn() },
    };
    const checkIn = async () => {
      await emit(pi, "turn_start", {}, ctx);
      orchestrator.requestHadTools = true;
      orchestrator.requestToolCallCount = 6;
      orchestrator.requestHadEdit = true;
      await emit(pi, "turn_end", { message: { stopReason: "stop", content: [{ type: "text", text: "Landed the first fix. Anything in that ordering you want changed?" }] } }, ctx);
    };

    await checkIn();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1].messages.at(-1).content[0].text).toContain("BLOCKING or OPTIONAL");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("you did not need answered");

    // A decision the user owns keeps the turn ended, however much work is left.
    complete.mockResolvedValue({ content: [{ type: "text", text: "BLOCKING" }] });
    await checkIn();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // A resumed turn that stops in prose again is checked again, so the cap is the
  // only thing standing between a wrong verdict and an endless loop.
  it("stops resuming after repeated unfinished verdicts", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const notify = vi.fn();
    const ctx = {
      model: { provider: "test", id: "model" },
      modelRegistry: { complete: vi.fn(async () => ({ content: [{ type: "text", text: "YES" }] })) },
      isIdle: () => true,
      getContextUsage: () => null,
      getSystemPrompt: () => "system",
      ui: { notify },
    };
    const proseStop = async () => {
      await emit(pi, "turn_start", {}, ctx);
      orchestrator.requestHadTools = true;
      orchestrator.requestToolCallCount = 6;
      await emit(pi, "turn_end", { message: { stopReason: "stop", content: [{ type: "text", text: "Made progress." }] } }, ctx);
    };

    for (let i = 0; i < 4; i += 1) await proseStop();

    expect(pi.sendMessage).toHaveBeenCalledTimes(3);
    expect(orchestrator.continuationHalted).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Automatic continuation paused"), "warning");

    // A genuine user message lifts the pause.
    await emit(pi, "before_agent_start", { prompt: "do something else" }, { ...ctx, cwd: "/tmp/project" });
    expect(orchestrator.continuationHalted).toBe(false);
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

  // The observed failure: a provider refusal ends the turn with stopReason
  // "error", which every other recovery path ignores, so the session simply
  // stopped mid-task with nothing said and nothing queued.
  it("nudges past a provider policy block instead of stalling", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const notify = vi.fn();
    const ctx = { isIdle: () => true, ui: { notify } };
    orchestrator.lastCtx = ctx as any;
    const blocked = {
      message: {
        stopReason: "error",
        content: [],
        errorMessage: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
      },
    };

    await emit(pi, "turn_start", {}, ctx);
    await emit(pi, "turn_end", blocked, ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("usage policy"), "warning");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const nudge = pi.sendMessage.mock.calls[0][0].content;
    expect(nudge).toContain("do not reproduce");
    expect(nudge).toContain("say so and stop");
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // A refusal that keeps coming back has no route around it, and nudging into it
  // forever is worse than stopping — but stopping silently is the bug this
  // whole branch exists to fix, so the last word has to be an explanation.
  it("stops nudging past repeated policy blocks and says why", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const notify = vi.fn();
    const ctx = { isIdle: () => true, ui: { notify } };
    orchestrator.lastCtx = ctx as any;
    const blocked = { message: { stopReason: "error", content: [], errorMessage: "blocked under Anthropic's Usage Policy" } };

    for (let i = 0; i < 8; i++) await emit(pi, "turn_end", blocked, ctx);

    expect(pi.sendMessage.mock.calls.length).toBeLessThanOrEqual(5);
    const last = notify.mock.calls[notify.mock.calls.length - 1];
    expect(last[0]).toContain("Stopping");
    expect(last[1]).toBe("error");
    // Nothing may claim to be continuing on a turn that queued nothing.
    expect(notify.mock.calls.filter((call: any[]) => call[0].includes("Continuing")).length)
      .toBe(pi.sendMessage.mock.calls.length);
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // The observed failure: the switch-back probe fired mid-request and switched
  // the model under a live tool loop, which resends the whole conversation on a
  // cold prompt cache from inside the chain.
  it("carries out a parked model switch at the next turn boundary", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { model: { provider: "test", id: "main-model" }, isIdle: () => true, ui: { notify: vi.fn() } };
    orchestrator.lastCtx = ctx as any;
    const switched = vi.fn(async () => {});
    orchestrator.pendingModelSwitch = switched;

    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);

    expect(switched).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingModelSwitch).toBeNull();
    expect(orchestrator.modelSwitchInFlight).toBe(false);
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // A truncated or empty turn has recovery of its own, which the drain does not
  // stand in for; an error turn may reroute the session entirely.
  it("keeps a switch parked on a turn that did not run to completion", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { model: { provider: "test", id: "main-model" }, isIdle: () => true, ui: { notify: vi.fn() } };
    orchestrator.lastCtx = ctx as any;
    const switched = vi.fn(async () => {});

    for (const stopReason of ["length", "error", "aborted"]) {
      orchestrator.pendingModelSwitch = switched;
      await emit(pi, "turn_end", { message: { stopReason, content: [], errorMessage: "boom" } }, ctx);
      expect(switched).not.toHaveBeenCalled();
      expect(orchestrator.pendingModelSwitch).toBe(switched);
    }

    await emit(pi, "session_shutdown", {}, ctx);
  });

  // Folding runs on the copy the host hands the context event, so the reply the
  // handler returns is what reaches the provider and the store keeps every byte.
  it("folds an oversized prompt on its way to the model, leaving the session whole", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.promptcap.maxPromptTokens = 5_000;
    registerEventHandlers(orchestrator);
    const ctx = { model: { provider: "test", id: "main-model" }, getSystemPrompt: () => "system", ui: { notify: vi.fn() } };

    const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `/f${i}` } }] });
      messages.push({ role: "toolResult", toolCallId: `t${i}`, toolName: "read", content: [{ type: "text", text: "o".repeat(8000) }], isError: false });
    }

    const handler = pi.handlers.get("context")!.find((fn: any) => fn.length >= 2)!;
    let folded: any;
    for (const fn of pi.handlers.get("context")!) {
      const out = await fn({ messages }, ctx);
      if (out?.messages) folded = out.messages;
    }
    expect(handler).toBeTruthy();

    expect(folded[2].content[0].text).toMatch(/^\[omitted: 8000B; t0\]$/);
    // A 5K ceiling leaves less room than one of these results occupies, so the
    // fold reaches the newest call too. The user's own prose is never folded.
    expect(folded[80].content[0].text).toMatch(/^\[omitted: 8000B; t39\]$/);
    expect(folded[0].content[0].text).toBe("go");
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("applies a per-model prompt ceiling in worker sessions", async () => {
    const pi = makePi();
    const config = normalizeConfigDurations(getDefaultConfig());
    config.promptcap.perModel["worker-model"] = { maxPromptTokens: 2_000 };
    registerSubagentPromptcap(pi, config);
    const ctx = { model: { provider: "test", id: "worker-model" }, getSystemPrompt: () => "system" };

    const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `w${i}`, name: "read", arguments: { path: `/f${i}` } }] });
      messages.push({ role: "toolResult", toolCallId: `w${i}`, toolName: "read", content: [{ type: "text", text: "o".repeat(4000) }], isError: false });
    }

    let folded: any;
    for (const fn of pi.handlers.get("context")!) {
      const out = await fn({ messages }, ctx);
      if (out?.messages) folded = out.messages;
    }
    expect(folded[2].content[0].text).toMatch(/^\[omitted: 4000B; w0\]$/);
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
