import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAcpState } from "./acp.js";
import { clearPauses, forgetLastGood, isPaused, listPauses, pause, setCatalog, unpause } from "./routing.js";
import { classifyContinuation, isMainTurnStalled, preloadSkillsForSpawn, registerEventHandlers, registerLoadSkill, registerSubagentPromptcap, renderGenericPrompt, startWorkers } from "./event-handlers.js";
import { listLayeredSkills } from "./skills-manifest.js";
import { createUsageTracker } from "./usage-tracker.js";
import initExtension from "./index.js";
import { listAgentDefinitions } from "./agents/registry.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");

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
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function emit(pi: any, name: string, event: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
}

/** Runs the registered Agent tool against a manager that records spawns instead of running them. */
async function spawnThroughTool(pi: any, orchestrator: Orchestrator, params: Record<string, unknown>, ctx: any = {}): Promise<{ result: any; spawned: any[] }> {
  const spawned: any[] = [];
  orchestrator.workers = { spawn: (spec: any) => { spawned.push(spec); return { id: `w-${spawned.length}`, status: "running" }; } } as any;
  const tool = pi.registerTool.mock.calls.map((call: any[]) => call[0]).find((entry: any) => entry.name === "Agent");
  const result = await tool.execute("call-1", params, undefined, undefined, ctx);
  return { result, spawned };
}

/** A root session with event handlers registered and workers backed by scripted sessions. */
function workerHarness() {
  const pi = makePi();
  const orchestrator = new Orchestrator(pi);
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  const sessions: Array<{ hooks: any; finish(text: string): void; disposed: boolean }> = [];
  orchestrator.workerSessionFactory = async (_spec, hooks) => {
    let resolve: () => void = () => {};
    let text = "";
    const entry = { hooks, disposed: false, finish(next: string) { text = next; resolve(); } };
    sessions.push(entry);
    return {
      run: () => new Promise<void>((done) => { resolve = done; }),
      steer() {},
      interruptTool: () => false,
      abort() {},
      dispose() { entry.disposed = true; },
      setModel: async () => true,
      lastAssistantText: () => text,
      lastError: () => undefined,
      contextPercent: () => undefined,
      transcript: () => [],
    };
  };
  registerEventHandlers(orchestrator);
  const ctx: any = { isIdle: () => true, hasPendingMessages: () => false, ui: { getEditorText: () => "", notify: vi.fn() } };
  orchestrator.lastCtx = ctx;
  startWorkers(orchestrator, ctx);
  return { pi, orchestrator, sessions, ctx };
}

function workerSpec(overrides: Record<string, unknown> = {}): any {
  return { type: "explore", description: "Worker", prompt: "p", model: "test/model", thinking: "high", notify: "wake", ...overrides };
}

const flushWorkers = () => new Promise((resolve) => setTimeout(resolve, 0));

/** First handler result for an event; several handlers may listen, only one answers. */
async function emitForResult(pi: any, name: string, event: any, ctx: any): Promise<any> {
  for (const handler of pi.handlers.get(name) ?? []) {
    const result = await handler(event, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** The main prompt as a session renders it, with context injection off. */
function genericPrompt(toolNames: string[]): string {
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
  return renderGenericPrompt(orchestrator, { model: { provider: "test", id: "model" }, ui: { notify: vi.fn() } }, toolNames);
}

/** Leave the process-global routing state as a fresh process has it. */
function resetRouting(): void {
  setCatalog([]);
  clearPauses();
  forgetLastGood();
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
    expect(prompt).toContain("[omitted: <size>B]");
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

  // The phases described every request as work to be proposed and validated,
  // so a question that needed no tool collected a research pass and an
  // approval round on its way to an answer that was known at the start.
  it("routes a question that depends on nothing in front of it straight to an answer", () => {
    const prompt = genericPrompt(["read", "ask_user"]);
    expect(prompt).toContain("A question is not a request");
    expect(prompt).toContain("answer it from what you know and stop");
    expect(prompt).toContain("No tools, no phases");
  });

  // Whether to look is decided per sentence, not per request: the cost of a
  // guess lands on the name, version or path inside it.
  it("attaches probes to the facts that need them, with a budget", () => {
    const prompt = genericPrompt(["read", "ask_user"]);
    expect(prompt).toContain("Evidence attaches to sentences, not to requests");
    expect(prompt).toContain("one probe per fact you would otherwise be guessing");
    expect(prompt).toContain("none at all to confirm what you already know");
  });

  // Whether to ask is a separate axis from whether to look, and it was the one
  // with no upper bound: nothing named the cost of an approval round that the
  // request had already settled.
  it("owes a proposal to the size of the decision, not to the request", () => {
    const prompt = genericPrompt(["read", "ask_user"]);
    expect(prompt).toContain("A proposal is owed when");
    expect(prompt).toContain("that report is the proposal");
    expect(prompt).toContain("never the count");
    expect(prompt).toContain("Blocking on a decision you could have taken");
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
    expect(prompt).toContain("Do not write prose while using tools");
    expect(prompt).toContain("one message, at the end");
  });

  it("honors a pool name the roster has since renamed, and blocks one nothing serves", async () => {
    setCatalog(["pp-flant-anthropic-sub/sub/claude-fable-5-1"]);
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.cwd = "/tmp/project";
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.config.agents.subagents.pools.reviewers = [
        { enabled: true, model: "claude/fable", thinking: "high" },
      ];
      orchestrator.registerAgents(true);
      registerEventHandlers(orchestrator);
      const ctx = { cwd: orchestrator.cwd, model: { provider: "test", id: "model" }, ui: { notify: vi.fn() }, sessionManager: {} };

      // An older build named pool members by provider and version; the slot
      // under that name is what the live roster is keyed by now.
      const stale = await spawnThroughTool(pi, orchestrator, { subagent_type: "reviewer_github-copilot-claude-fable-5.1_high", description: "d", prompt: "p" }, ctx);
      expect(stale.result.isError).toBeUndefined();
      expect(stale.spawned[0]).toMatchObject({ type: "reviewer_claude-fable_high", model: "pp-flant-anthropic-sub/sub/claude-fable-5-1", resultSchema: "findings" });

      const unknown = await spawnThroughTool(pi, orchestrator, { subagent_type: "reviewer_gemini-3-pro_high", description: "d", prompt: "p" }, ctx);
      expect(unknown.result.isError).toBe(true);
      expect(unknown.spawned).toEqual([]);
    } finally {
      resetRouting();
    }
  });

  // The subagent host runs a definition whose model it cannot find on the
  // parent's model, silently: a second opinion meant to come from another
  // vendor would just be this session again.
  it("blocks a registered pool agent whose model left the catalog, explaining the routing", async () => {
    setCatalog(["openai-codex/gpt-6-astra-pro", "pp-flant-anthropic-sub/sub/claude-fable-5-1"]);
    try {
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.cwd = "/tmp/project";
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.registerAgents(true);
      registerEventHandlers(orchestrator);
      const ctx = { cwd: orchestrator.cwd, model: { provider: "test", id: "model" }, ui: { notify: vi.fn() }, sessionManager: {} };

      const served = await spawnThroughTool(pi, orchestrator, { subagent_type: "advisor_claude-fable_high", description: "d", prompt: "p" }, ctx);
      expect(served.spawned).toHaveLength(1);

      // The Claude credential goes away; the definition still names the model
      // it was registered with.
      setCatalog(["openai-codex/gpt-6-astra-pro"]);
      const orphaned = await spawnThroughTool(pi, orchestrator, { subagent_type: "advisor_claude-fable_high", description: "d", prompt: "p" }, ctx);
      expect(orphaned.result.isError).toBe(true);
      const reason = orphaned.result.content[0].text;
      expect(reason).toContain("advisor_claude-fable_high has no model to run on right now (claude/fable)");
      expect(reason).toContain("✗ Claude subscription: no credentials");
      expect(reason).toContain("✗ ChatGPT subscription: no model for Claude Fable");
      expect(reason).toContain("/pp › Settings › Providers");
      expect(orphaned.spawned).toEqual([]);

      // The other-vendor member is untouched.
      const other = await spawnThroughTool(pi, orchestrator, { subagent_type: "advisor_gpt-astra-pro_high", description: "d", prompt: "p" }, ctx);
      expect(other.spawned).toHaveLength(1);
    } finally {
      resetRouting();
    }
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

  // The host re-instantiates every extension on /new, /resume and fork; each
  // instantiation must register the root session's handlers again.
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

  it("applies the configured main agent model and thinking to the root session", async () => {
    const pi = makePi();
    pi.setModel = vi.fn(async () => true);
    pi.setThinkingLevel = vi.fn();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.agents.main = { model: "test/main-model", thinking: "low" };
    const model = { provider: "test", id: "main-model" };
    const ctx: any = { modelRegistry: { find: vi.fn((p: string, id: string) => (p === "test" && id === "main-model" ? model : undefined)) } };
    setCatalog(["test/main-model"]);
    try {
      expect(await orchestrator.applyMainAgent(ctx)).toBe(true);
      expect(pi.setModel).toHaveBeenCalledWith(model);
      expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
      expect(orchestrator.routedMainSpec).toBe("test/main-model");

      orchestrator.config.agents.main = { model: "test/missing", thinking: "high" };
      expect(await orchestrator.applyMainAgent(ctx)).toBe(false);
      expect(pi.setModel).toHaveBeenCalledTimes(1);
    } finally {
      resetRouting();
    }
  });

  // A session that STARTS while its preferred provider is unusable resolves
  // main onto the next one, and nothing else ever moves it back: the pause's
  // own expiry only restores a session that pause moved.
  it("restores the main model once its preferred provider is usable again", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    setCatalog(specs);
    pause("claude-sub", 60_000, "test");
    try {
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      expect(orchestrator.config.agents.main.model).toBe("claude/opus");
      const registry = {
        find: vi.fn((provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined)),
      };

      const ctx: any = { modelRegistry: registry, ui: { notify: vi.fn() } };
      expect(await orchestrator.applyMainAgent(ctx)).toBe(true);
      expect(orchestrator.routedMainSpec).toBe("github-copilot/claude-opus-4.5");

      ctx.model = { provider: "github-copilot", id: "claude-opus-4.5" };
      await orchestrator.restoreMainRouting(ctx);
      expect(pi.setModel).toHaveBeenCalledTimes(1);

      unpause("claude-sub");
      await orchestrator.restoreMainRouting(ctx);
      expect(pi.setModel).toHaveBeenLastCalledWith({ provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" });
      expect(orchestrator.routedMainSpec).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    } finally {
      resetRouting();
    }
  });

  it("leaves a model the user picked alone, and holds off while the preferred provider is paused", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    setCatalog(specs);
    pause("claude-sub", 60_000, "test");
    try {
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      const ctx: any = {
        modelRegistry: { find: vi.fn((provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined)) },
        ui: { notify: vi.fn() },
      };
      await orchestrator.applyMainAgent(ctx);
      expect(orchestrator.routedMainSpec).toBe("github-copilot/claude-opus-4.5");
      pi.setModel.mockClear();

      // Still paused: the resolver keeps skipping the subscription.
      ctx.model = { provider: "github-copilot", id: "claude-opus-4.5" };
      await orchestrator.restoreMainRouting(ctx);
      expect(pi.setModel).not.toHaveBeenCalled();

      // Usable again, but the live model is the user's own /model pick.
      unpause("claude-sub");
      ctx.model = { provider: "github-copilot", id: "gpt-5.6-sol" };
      await orchestrator.restoreMainRouting(ctx);
      expect(pi.setModel).not.toHaveBeenCalled();
      expect(orchestrator.routedMainSpec).toBe("github-copilot/claude-opus-4.5");
    } finally {
      resetRouting();
    }
  });

  // A pause's expiry restores whatever model was live when the limit hit —
  // possibly one the user picked by hand. Recording that as pi-pi's own routing
  // choice would let the next turn overwrite it with the config main.
  it("does not claim a model the rate-limit switch-back restored", async () => {
    const specs = ["pp-flant-anthropic-sub/sub/claude-opus-4-8", "github-copilot/claude-opus-4.5"];
    setCatalog(specs);
    try {
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
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
    } finally {
      resetRouting();
    }
  });

  // The gateway's subscription ids carry their own slash (`sub/claude-…`); read
  // alone they look provider-qualified and the limit lands on nothing.
  it("pauses the subscription on a rate limit reported with a gateway sub/ id", async () => {
    const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    const COPILOT = "github-copilot/claude-opus-4.5";
    setCatalog([SUB, COPILOT]);
    try {
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      const registry = { find: vi.fn((provider: string, id: string) => ({ provider, id })) };
      const ctx: any = { model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" }, modelRegistry: registry, ui: { notify: vi.fn() }, isIdle: () => true, abort: vi.fn() };
      orchestrator.lastCtx = ctx;
      orchestrator.routedMainSpec = SUB;
      await emit(pi, "turn_end", {
        message: { stopReason: "error", errorMessage: "429 rate_limit_error", provider: "pp-flant-anthropic-sub", model: "sub/claude-opus-4-8", content: [] },
      }, ctx);
      expect(isPaused("claude-sub")).toBe(true);
      expect(pi.setModel).toHaveBeenCalledWith({ provider: "github-copilot", id: "claude-opus-4.5" });
      if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
    } finally {
      resetRouting();
    }
  });

  // Restoring before the failure is handled could put the session back on the
  // very model that just failed, and the request would stop there.
  it("handles a provider failure before re-routing to the configured model", async () => {
    const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    const COPILOT = "github-copilot/claude-opus-4.5";
    setCatalog([SUB, COPILOT]);
    try {
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      registerEventHandlers(orchestrator);
      const restore = vi.spyOn(orchestrator, "restoreMainRouting");
      const ctx: any = { model: { provider: "github-copilot", id: "claude-opus-4.5" }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { notify: vi.fn() }, isIdle: () => true, abort: vi.fn() };
      orchestrator.lastCtx = ctx;
      orchestrator.routedMainSpec = COPILOT;
      await emit(pi, "turn_end", {
        message: { stopReason: "error", errorMessage: "429 Too Many Requests", provider: "github-copilot", model: "claude-opus-4.5", content: [] },
      }, ctx);
      expect(restore).not.toHaveBeenCalled();
      expect(isPaused("copilot:claude/opus")).toBe(true);
    } finally {
      resetRouting();
    }
  });

  // A model the user picked stays theirs through a pause and its expiry: the
  // restore puts it back, and the next routing pass must leave it alone.
  it("does not claim a hand-picked model once a pause's expiry put it back", async () => {
    vi.useFakeTimers();
    const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    const COPILOT_GPT = "github-copilot/gpt-6-sol";
    const CODEX_GPT = "openai-codex/gpt-6-sol";
    setCatalog([SUB, COPILOT_GPT, CODEX_GPT]);
    try {
      const { handleMainRateLimit } = await import("./rate-limit-fallback.js");
      const pi = makePi();
      pi.setModel = vi.fn(async () => true);
      pi.setThinkingLevel = vi.fn();
      const orchestrator = new Orchestrator(pi);
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.routedMainSpec = SUB;
      const ctx: any = { model: { provider: "openai-codex", id: "gpt-6-sol" }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { notify: vi.fn() }, isIdle: () => true, abort: vi.fn() };
      orchestrator.lastCtx = ctx;
      await handleMainRateLimit(orchestrator, ctx, CODEX_GPT, "retry-after: 60");
      expect(pi.setModel).toHaveBeenLastCalledWith({ provider: "github-copilot", id: "gpt-6-sol" });
      ctx.model = { provider: "github-copilot", id: "gpt-6-sol" };
      await vi.advanceTimersByTimeAsync(61_000);
      expect(pi.setModel).toHaveBeenLastCalledWith({ provider: "openai-codex", id: "gpt-6-sol" });
      ctx.model = { provider: "openai-codex", id: "gpt-6-sol" };
      expect(orchestrator.routedMainSpec).toBe(SUB);
      pi.setModel.mockClear();
      await orchestrator.restoreMainRouting(ctx);
      expect(pi.setModel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      resetRouting();
    }
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
    orchestrator.workers = { active: () => [{ id: "worker" }] } as any;
    expect(isMainTurnStalled(orchestrator, 3000)).toBe(false);
    orchestrator.workers = null;
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
      const { pi, orchestrator, sessions } = workerHarness();
      orchestrator.cwd = dir;
      initTracer(join(dir, ".pp"), "trace-session");

      await emit(pi, "tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "a.ts" } }, {});
      const record = orchestrator.workers!.spawn(workerSpec({ parentToolCallId: "call-7" }));
      await flushWorkers();
      sessions[0]!.finish("done");
      await flushWorkers();
      finalizeTracer();

      const main = readFileSync(join(dir, ".pp", "logs", "traces", "trace-session", "main.jsonl"), "utf-8");
      expect(main).toContain('"kind":"tool_execution_start"');
      expect(main).toContain('"kind":"subagent_spawned"');
      // The spawning tool call is what ties a worker trace back to the turn that started it.
      expect(main).toContain('"parentToolCallId":"call-7"');
      const worker = readFileSync(join(dir, ".pp", "logs", "traces", "trace-session", `${record.id}.jsonl`), "utf-8");
      expect(worker).toContain('"kind":"subagent_settled"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a finished worker's usage and stops counting it as active", async () => {
    const { orchestrator, sessions } = workerHarness();
    const usage = createUsageTracker();
    (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] = usage;
    try {
      orchestrator.workers!.spawn(workerSpec());
      await flushWorkers();
      expect(orchestrator.hasActiveWorkers()).toBe(true);
      sessions[0]!.hooks.onUsage({ input: 10, output: 4 });
      sessions[0]!.finish("done");
      await flushWorkers();
    } finally {
      delete (globalThis as any)[Symbol.for("pi-pi:usage-tracker")];
    }

    expect(orchestrator.hasActiveWorkers()).toBe(false);
    expect(usage.getSubagentTotals()).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(usage.getSubagentList()[0]).toMatchObject({ agentType: "explore", modelId: "test/model" });
  });

  it("wakes an idle parent with a finished worker's result, and steers a busy one", async () => {
    const { pi, orchestrator, sessions, ctx } = workerHarness();
    orchestrator.workers!.spawn(workerSpec());
    await flushWorkers();
    sessions[0]!.hooks.submitResult({ status: "done", summary: "found it", body: "a.ts:1" });
    sessions[0]!.finish("x");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pi-pi-worker", content: expect.stringContaining("found it") }), { triggerTurn: true });

    orchestrator.mainTurnInFlight = true;
    ctx.isIdle = () => false;
    orchestrator.workers!.spawn(workerSpec());
    await flushWorkers();
    sessions[1]!.finish("second");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "pi-pi-worker" }), { deliverAs: "steer" });
  });

  it("holds the wake while a dialog is open", async () => {
    const { pi, orchestrator, sessions } = workerHarness();
    orchestrator.interactivePromptOpen = true;
    orchestrator.workers!.spawn(workerSpec());
    await flushWorkers();
    sessions[0]!.finish("x");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sendMessage).not.toHaveBeenCalled();
    orchestrator.interactivePromptOpen = false;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("kills the previous session's workers when the session is replaced, and reports nothing to it", async () => {
    const { pi, orchestrator, sessions, ctx } = workerHarness();
    const record = orchestrator.workers!.spawn(workerSpec());
    await flushWorkers();
    await emit(pi, "session_shutdown", {}, ctx);
    expect(record.status).toBe("killed");
    expect(sessions[0]!.disposed).toBe(true);
    expect(orchestrator.workers).toBeNull();
    // The host invalidates the old session's API right after shutdown; a send
    // from a timer armed by the kill would throw outside any handler.
    pi.sendMessage.mockImplementation(() => { throw new Error("stale"); });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("re-sends a steered result the root run dropped with its queue", async () => {
    const { pi, orchestrator, sessions } = workerHarness();
    orchestrator.mainTurnInFlight = true;
    orchestrator.workers!.spawn(workerSpec());
    await flushWorkers();
    sessions[0]!.finish("result");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.anything(), { deliverAs: "steer" });
    orchestrator.mainTurnInFlight = false;
    await emit(pi, "agent_settled", {}, {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "pi-pi-worker" }), { triggerTurn: true });
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

  it("resets process-global provider pauses during shutdown", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    pause("claude-sub", null, "test");
    pause("copilot:claude/opus", 60_000, "test");
    const expiry = vi.fn();
    orchestrator.pauseTimers.set("copilot:claude/opus", setTimeout(expiry, 60_000));
    orchestrator.subProbeSpec = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    orchestrator.pausedMainRoutes.set("claude-sub", { from: "pp-flant-anthropic-sub/sub/claude-opus-4-8", to: "github-copilot/claude-opus-4.5", owned: true, resume: false, generation: 0 });
    orchestrator.routedMainSpec = "github-copilot/claude-opus-4.5";
    registerEventHandlers(orchestrator);
    await emit(pi, "session_shutdown", {}, { sessionManager: {}, ui: {} });
    expect(listPauses()).toEqual([]);
    expect(isPaused("claude-sub")).toBe(false);
    expect(orchestrator.pauseTimers.size).toBe(0);
    expect(orchestrator.subProbeSpec).toBeNull();
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
    expect(orchestrator.routedMainSpec).toBeNull();
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

  // A refusal reaches the turn as stopReason "error" carrying a raw stop reason
  // no error-text predicate matches, so before this branch existed the session
  // stopped dead on one. It is probabilistic, so the first answer is to send the
  // same request again rather than to pay for a cold cache on another provider.
  it("resends a refused request once, then leaves the vendor", async () => {
    setCatalog([
      "pp-flant-openai/gpt-5.6-sol",
      "pp-flant-openai/gpt-5.6-sol-pro",
      "pp-flant-anthropic-sub/sub/claude-opus-5",
    ]);
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const notify = vi.fn();
    const ctx = { isIdle: () => true, model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-5" }, ui: { notify } };
    orchestrator.lastCtx = ctx as any;
    orchestrator.switchModel = vi.fn(async () => true);
    const refused = { message: { stopReason: "error", rawStopReason: "refusal", content: [] } };

    await emit(pi, "turn_end", refused, ctx);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("do not start over");

    await emit(pi, "turn_end", refused, ctx);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-openai/gpt-5.6-sol-pro", expect.any(String));
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);

    resetRouting();
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // Nothing else reports that a refusal cleared, so without this a session that
  // recovered would spend its next one on a provider switch it did not need.
  it("forgets a refusal once a turn answers", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } };
    orchestrator.lastCtx = ctx as any;

    await emit(pi, "turn_end", { message: { stopReason: "error", rawStopReason: "refusal", content: [] } }, ctx);
    expect(orchestrator.refusalCount).toBe(1);
    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [] } }, ctx);
    expect(orchestrator.refusalCount).toBe(0);
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // Stopping is right when there is nowhere to go, but stopping without saying
  // so is the failure this whole branch exists to prevent.
  it("stops and explains when a repeated refusal has nowhere to move", async () => {
    // Only Claude is served: GPT Sol Pro, the cross-vendor escape, resolves to nothing.
    setCatalog(["pp-flant-anthropic-sub/sub/claude-opus-5"]);
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const notify = vi.fn();
    const ctx = { isIdle: () => true, ui: { notify } };
    orchestrator.lastCtx = ctx as any;
    orchestrator.switchModel = vi.fn(async () => true);
    const refused = { message: { stopReason: "error", rawStopReason: "refusal", content: [] } };

    for (let i = 0; i < 4; i++) await emit(pi, "turn_end", refused, ctx);

    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const last = notify.mock.calls[notify.mock.calls.length - 1];
    expect(last[0]).toContain("Stopping");
    expect(last[1]).toBe("error");
    await emit(pi, "session_shutdown", {}, ctx);
    resetRouting();
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
    orchestrator.pendingModelSwitches = [switched];

    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);

    expect(switched).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingModelSwitches).toEqual([]);
    expect(orchestrator.modelSwitchInFlight).toBe(false);
    await emit(pi, "session_shutdown", {}, ctx);
  });

  // Both restore paths park through the same queue: the subscription probe's
  // restore is the only code that lifts the fallback latch, so a tier restore
  // landing on top of it used to pin the session to the fallback tier for good.
  it("carries out every switch parked during one request, in order", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    registerEventHandlers(orchestrator);
    const ctx = { model: { provider: "test", id: "main-model" }, isIdle: () => false, ui: { notify: vi.fn() } };
    orchestrator.lastCtx = ctx as any;
    const order: string[] = [];
    await orchestrator.runModelSwitchBetweenTurns(async () => { order.push("first"); });
    await orchestrator.runModelSwitchBetweenTurns(async () => { throw new Error("boom"); });
    await orchestrator.runModelSwitchBetweenTurns(async () => { order.push("third"); });
    expect(order).toEqual([]);

    ctx.isIdle = () => true;
    await emit(pi, "turn_end", { message: { stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] } }, ctx);

    // A failure in one parked switch must not strand the ones behind it.
    expect(order).toEqual(["first", "third"]);
    expect(orchestrator.pendingModelSwitches).toEqual([]);
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
      orchestrator.pendingModelSwitches = [switched];
      await emit(pi, "turn_end", { message: { stopReason, content: [], errorMessage: "boom" } }, ctx);
      expect(switched).not.toHaveBeenCalled();
      expect(orchestrator.pendingModelSwitches).toEqual([switched]);
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

    expect(folded[2].content[0].text).toBe("[omitted: 8000B]");
    // A 5K ceiling leaves less room than one of these results occupies, so the
    // fold reaches the newest call too. The user's own prose is never folded.
    expect(folded[80].content[0].text).toBe("[omitted: 8000B]");
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
    expect(folded[2].content[0].text).toBe("[omitted: 4000B]");
  });

  it("makes layered skills loadable in worker processes", async () => {
    const pi = makePi();
    registerLoadSkill(pi, "/tmp/project");
    const registration = pi.registerTool.mock.calls.find((call: any[]) => call[0].name === "load_skill")[0];
    expect(registration.description).toContain("code-rules");
    const result = await registration.execute("id", { name: "code-rules" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('<skill name="code-rules" source="bundled" dir=');
  });

  describe("skills preloaded into a spawn", () => {
    const setup = () => {
      const project = mkdtempSync(join(tmpdir(), "pp-spawn-skills-"));
      const write = (name: string, audience: string | undefined, body: string) => {
        mkdirSync(join(project, ".pi", "skills", name), { recursive: true });
        writeFileSync(join(project, ".pi", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} guidance\n${audience ? `audience: ${audience}\n` : ""}---\n\n${body}\n`);
      };
      write("shared-rules", "any", "Rule for everyone.");
      write("main-flow", undefined, "Spawn three reviewers.");
      const pi = makePi();
      const orchestrator = new Orchestrator(pi);
      orchestrator.cwd = project;
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      return { project, pi, orchestrator };
    };

    it("prepends a shareable skill to the spawned prompt and refuses a main-only one", async () => {
      const { project, pi, orchestrator } = setup();
      setCatalog(["openai-codex/gpt-6-astra-pro", "pp-flant-anthropic-sub/sub/claude-fable-5-1"]);
      try {
        orchestrator.registerAgents(true);
        registerEventHandlers(orchestrator);
        const ctx = { cwd: project, model: { provider: "test", id: "model" }, ui: { notify: vi.fn() }, sessionManager: {} };
        const { spawned } = await spawnThroughTool(pi, orchestrator, { subagent_type: "advisor_gpt-astra-pro_high", description: "d", prompt: "Do the slice.", skills: ["shared-rules"] }, ctx);
        expect(String(spawned[0].prompt)).toMatch(/^<skill name="shared-rules" source="project" dir="[^"]+">\nRule for everyone\.\n<\/skill>\n\nDo the slice\.$/);
        const refused = await spawnThroughTool(pi, orchestrator, { subagent_type: "advisor_gpt-astra-pro_high", description: "d", prompt: "p", skills: ["main-flow"] }, ctx);
        expect(refused.result.isError).toBe(true);
        expect(refused.spawned).toEqual([]);
      } finally {
        resetRouting();
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("blocks a spawn naming an unknown or main-only skill", () => {
      const { project, orchestrator } = setup();
      try {
        expect(preloadSkillsForSpawn(orchestrator, ["nope"])).toContain('Unknown skill "nope"');
        const mainOnly = preloadSkillsForSpawn(orchestrator, ["main-flow"]);
        expect(mainOnly).toContain("written for the main agent");
        expect(mainOnly).toContain("shared-rules");
        expect(preloadSkillsForSpawn(orchestrator, "shared-rules")).toContain("must be an array");
        expect(preloadSkillsForSpawn(orchestrator, undefined)).toEqual([]);
        expect(preloadSkillsForSpawn(orchestrator, [])).toEqual([]);
        expect(preloadSkillsForSpawn(orchestrator, ["shared-rules", "shared-rules"])).toHaveLength(1);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    // A project skill shadows the bundled one by name, audience included: a
    // local code-rules without the key turns the shared one main-only.
    it("follows the shadowing skill's audience", () => {
      const { project, orchestrator } = setup();
      try {
        mkdirSync(join(project, ".pi", "skills", "code-rules"), { recursive: true });
        writeFileSync(join(project, ".pi", "skills", "code-rules", "SKILL.md"), "---\nname: code-rules\ndescription: local rules\n---\n\nLocal.\n");
        expect(preloadSkillsForSpawn(orchestrator, ["code-rules"])).toContain("written for the main agent");
        const prompt = renderGenericPrompt(orchestrator, { cwd: project, model: { provider: "test", id: "model" } } as any, ["Agent", "load_skill"]);
        expect(prompt).not.toContain('skills: ["code-rules"]');
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("tells the main agent to pass code-rules only while it is shareable", () => {
      const { project, orchestrator } = setup();
      try {
        const prompt = renderGenericPrompt(orchestrator, { cwd: project, model: { provider: "test", id: "model" } } as any, ["Agent", "load_skill"]);
        expect(prompt).toContain('Pass skills: ["code-rules"] on every spawn that writes code.');
        orchestrator.config.skills.loadBundled = false;
        const without = renderGenericPrompt(orchestrator, { cwd: project, model: { provider: "test", id: "model" } } as any, ["Agent", "load_skill"]);
        expect(without).not.toContain('skills: ["code-rules"]');
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("respects disabled skill layers", () => {
      const { project, orchestrator } = setup();
      try {
        orchestrator.config.skills.loadProject = false;
        expect(preloadSkillsForSpawn(orchestrator, ["shared-rules"])).toContain('Unknown skill "shared-rules"');
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("marks shareable skills in the catalog", () => {
      const { project, orchestrator } = setup();
      try {
        const prompt = renderGenericPrompt(orchestrator, { cwd: project, model: { provider: "test", id: "model" } } as any, ["Agent", "load_skill"]);
        expect(prompt).toContain("- shared-rules: shared-rules guidance (project, subagents)");
        expect(prompt).toContain("- main-flow: main-flow guidance (project)");
        expect(prompt).toContain("Agent call's skills parameter");
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  });

  // The <skills> catalog already carries every description and the rule that
  // makes them triggers, and load_skill is granted to the main agent alone, so
  // a description repeated here is paid twice and read once.
  it("lists skill names without repeating the catalog's descriptions", () => {
    const pi = makePi();
    registerLoadSkill(pi, "/tmp/project");
    const registration = pi.registerTool.mock.calls.find((call: any[]) => call[0].name === "load_skill")[0];

    for (const skill of listLayeredSkills("/tmp/project")) {
      expect(registration.description).toContain(skill.name);
      expect(registration.description).not.toContain(skill.description);
    }
  });

  it("registers every worker role with recall into the main session", () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.registerAgents();
    const definitions = listAgentDefinitions();
    expect(definitions.length).toBeGreaterThanOrEqual(6);
    for (const definition of definitions) expect(definition.tools).toContain("vcc_recall");
  });
});
