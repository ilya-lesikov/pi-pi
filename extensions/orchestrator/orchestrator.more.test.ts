import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "orchestrator-more-agent-"));
});

import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { clearPauses, forgetLastGood, setCatalog } from "./routing.js";

const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
const DIRECT = "pp-claude-sub/claude-opus-4-8";

function makePi(overrides: Record<string, any> = {}): any {
  return { sendUserMessage: vi.fn(), sendMessage: vi.fn(), setModel: vi.fn(async () => true), setThinkingLevel: vi.fn(async () => {}), events: { emit: vi.fn(), on: vi.fn(() => () => {}) }, ...overrides };
}

function make(pi: any = makePi()): Orchestrator {
  const orchestrator = new Orchestrator(pi);
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  return orchestrator;
}

const registry = (...specs: string[]) => ({
  find: (provider: string, id: string) => (specs.includes(`${provider}/${id}`) ? { provider, id } : undefined),
});

function ctxOn(spec: string, extra: Record<string, any> = {}): any {
  const slash = spec.indexOf("/");
  return { model: { provider: spec.slice(0, slash), id: spec.slice(slash + 1) }, modelRegistry: registry(SUB, DIRECT), ui: { notify: vi.fn() }, ...extra };
}

beforeEach(() => {
  clearPauses();
  forgetLastGood();
  setCatalog([]);
});

afterEach(() => {
  vi.useRealTimers();
  setCatalog([]);
  forgetLastGood();
});

describe("Orchestrator — config", () => {
  it("accepts a partial config without arming routing", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = { agents: {} } as any;
    expect(orchestrator.config).toEqual({ agents: {} });
  });
});

describe("Orchestrator — switching models", () => {
  it("refuses a spec without a provider, an unknown model, and a host that cannot switch", async () => {
    const orchestrator = make();
    expect(await orchestrator.switchModel(ctxOn(SUB), "no-slash", "high")).toBe(false);
    expect(await orchestrator.switchModel(ctxOn(SUB), "/id", "high")).toBe(false);
    expect(await orchestrator.switchModel(ctxOn(SUB), "x/unknown", "high")).toBe(false);
    const noSetModel = make(makePi({ setModel: undefined }));
    expect(await noSetModel.switchModel(ctxOn(SUB), DIRECT, "high")).toBe(false);
  });

  it("falls back to the available list when the registry cannot find by id, and skips thinking when unsupported", async () => {
    const pi = makePi({ setThinkingLevel: undefined });
    const orchestrator = make(pi);
    const ctx = { modelRegistry: { getAvailable: () => [{ provider: "pp-claude-sub", id: "claude-opus-4-8" }] } };
    expect(await orchestrator.switchModel(ctx as any, DIRECT, "high")).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith({ provider: "pp-claude-sub", id: "claude-opus-4-8" });
  });

  it("applies the main agent, recording the route, and declines when it resolves to nothing or fails", async () => {
    const pi = makePi();
    const orchestrator = make(pi);
    expect(await orchestrator.applyMainAgent(ctxOn(SUB))).toBe(false);
    setCatalog([SUB]);
    expect(await orchestrator.applyMainAgent(ctxOn(SUB))).toBe(true);
    expect(orchestrator.routedMainSpec).toBe(SUB);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    pi.setModel.mockRejectedValueOnce(new Error("boom"));
    expect(await orchestrator.applyMainAgent(ctxOn(SUB))).toBe(false);
    expect(await orchestrator.applyMainAgent({ modelRegistry: registry() } as any)).toBe(false);
    orchestrator.config = { ...orchestrator.config, agents: { ...orchestrator.config.agents, main: undefined as any } };
    expect(await orchestrator.applyMainAgent(ctxOn(SUB))).toBe(false);
  });

  it("re-routes a session still on the routed model, forgetting pause moves onto it", async () => {
    const orchestrator = make();
    setCatalog([DIRECT]);
    orchestrator.routedMainSpec = SUB;
    orchestrator.pausedMainRoutes.set("p1", { from: "x", to: SUB, owned: true, resume: false, generation: 0 });
    orchestrator.pausedMainRoutes.set("p2", { from: "x", to: "other/model", owned: true, resume: false, generation: 0 });
    const ctx = ctxOn(SUB);
    await orchestrator.restoreMainRouting(ctx);
    expect(orchestrator.routedMainSpec).toBe(DIRECT);
    expect([...orchestrator.pausedMainRoutes.keys()]).toEqual(["p2"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Routing changed; switched to ${DIRECT}.`, "info");
  });

  it("leaves the user's own pick, an unchanged route and a failed switch alone", async () => {
    const pi = makePi();
    const orchestrator = make(pi);
    setCatalog([DIRECT]);
    await orchestrator.restoreMainRouting(ctxOn(SUB));
    orchestrator.routedMainSpec = SUB;
    await orchestrator.restoreMainRouting(ctxOn("user/pick"));
    await orchestrator.restoreMainRouting({} as any);
    expect(pi.setModel).not.toHaveBeenCalled();
    orchestrator.routedMainSpec = DIRECT;
    await orchestrator.restoreMainRouting(ctxOn(DIRECT));
    expect(pi.setModel).not.toHaveBeenCalled();
    orchestrator.routedMainSpec = SUB;
    pi.setModel.mockRejectedValueOnce(new Error("down"));
    await orchestrator.restoreMainRouting(ctxOn(SUB));
    expect(orchestrator.routedMainSpec).toBe(SUB);
  });

  it("describes the configured model before a live one, and the live one when the user picked it", () => {
    const orchestrator = make();
    setCatalog([SUB]);
    expect(orchestrator.mainModelInfo().label).toBe("Claude Opus");
    orchestrator.routedMainSpec = SUB;
    expect(orchestrator.mainModelInfo(ctxOn(SUB)).spec).toBe(SUB);
    expect(orchestrator.mainModelInfo(ctxOn("zai/glm-5.3")).label).toBe("glm-5.3");
    expect(orchestrator.mainAgentConfig()).toEqual({ model: "claude/opus", thinking: "high" });
  });
});

describe("Orchestrator — parked switches", () => {
  it("parks a switch while busy and runs it once the session is idle", async () => {
    vi.useFakeTimers();
    const orchestrator = make();
    let idle = false;
    orchestrator.lastCtx = { isIdle: () => idle };
    const ran: string[] = [];
    await orchestrator.runModelSwitchBetweenTurns(async () => { ran.push("a"); });
    await orchestrator.runModelSwitchBetweenTurns(async () => { ran.push("b"); });
    expect(orchestrator.pendingModelSwitches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual([]);
    idle = true;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(["a", "b"]);
    expect(orchestrator.modelSwitchPollTimer).toBeNull();
  });

  it("parks behind a switch already in flight, and a poll with nothing parked does nothing", async () => {
    vi.useFakeTimers();
    const orchestrator = make();
    orchestrator.lastCtx = null;
    orchestrator.modelSwitchInFlight = true;
    const action = vi.fn(async () => {});
    await orchestrator.runModelSwitchBetweenTurns(action);
    orchestrator.pendingModelSwitches.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(action).not.toHaveBeenCalled();
  });

  it("logs a failing switch and still releases continuations held behind it", async () => {
    const pi = makePi();
    const orchestrator = make(pi);
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.modelSwitchInFlight = true;
    orchestrator.queueContinuation("go on");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    orchestrator.modelSwitchInFlight = false;
    await orchestrator.runSwitchAction(async () => { throw new Error("nope"); });
    expect(orchestrator.modelSwitchInFlight).toBe(false);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("go on"), { deliverAs: "followUp" });
    if (orchestrator.idlePollTimer) clearTimeout(orchestrator.idlePollTimer);
  });
});

describe("Orchestrator — continuations", () => {
  it("falls back to a visible message when the hidden one is refused", () => {
    const pi = makePi({ sendMessage: vi.fn(() => { throw new Error("no"); }) });
    const orchestrator = make(pi);
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.queueContinuation("resume", true);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("resume", { deliverAs: "followUp" });
    expect(orchestrator.pendingContinuations.size).toBe(0);
  });

  it("drops a continuation from an older generation or with no session", () => {
    const pi = makePi();
    const orchestrator = make(pi);
    orchestrator.sendUserMessageWhenIdle("x", 0);
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.pendingContinuations.set("x", { invisible: true });
    orchestrator.sendUserMessageWhenIdle("x", 99);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(orchestrator.pendingContinuations.has("x")).toBe(true);
  });
});

describe("Orchestrator — status and workers", () => {
  it("records the context and asks it to re-render", () => {
    const orchestrator = make();
    const ctx = { ui: { requestRender: vi.fn() } };
    orchestrator.updateStatus(ctx);
    expect(orchestrator.lastCtx).toBe(ctx);
    expect(ctx.ui.requestRender).toHaveBeenCalled();
    orchestrator.updateStatus(undefined);
  });

  it("kills every worker on abort and tolerates having none", () => {
    const orchestrator = make();
    orchestrator.abortAllSubagents();
    const killAll = vi.fn();
    orchestrator.workers = { killAll, active: () => [] } as any;
    orchestrator.abortAllSubagents();
    expect(killAll).toHaveBeenCalled();
    expect(orchestrator.hasActiveWorkers()).toBe(false);
  });

  it("skips disabled pool entries when registering agents", async () => {
    const { listAgentDefinitions } = await import("./agents/registry.js");
    const reviewers = () => listAgentDefinitions().filter((d) => d.name.startsWith("reviewer"));
    const orchestrator = make();
    orchestrator.registerAgents(true);
    expect(reviewers().length).toBeGreaterThan(0);
    const pools = orchestrator.config.agents.subagents.pools;
    orchestrator.config = { ...orchestrator.config, agents: { ...orchestrator.config.agents, subagents: { ...orchestrator.config.agents.subagents, pools: { ...pools, reviewers: pools.reviewers.map((entry) => ({ ...entry, enabled: false })) } } } } as any;
    orchestrator.registerAgents(true);
    expect(reviewers()).toEqual([]);
  });
});
