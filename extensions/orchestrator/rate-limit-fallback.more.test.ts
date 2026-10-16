import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { loadRoutingSettings, probeSubscriptionCleared, reviveSubscriptionCredential } from "./flant-infra.js";
import {
  armSwitchBackProbe,
  clearAllPauses,
  demoteUnusableSubscription,
  handleMainAuthFailure,
  handleMainRateLimit,
  handleMainRefusal,
  handleSubagentAuthFailure,
  handleSubagentRateLimit,
} from "./rate-limit-fallback.js";
import { clearPauses, forgetLastGood, getPause, isPaused, listPauses, pause, setCatalog, unpause } from "./routing.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadRoutingSettings: vi.fn(),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
  reviveSubscriptionCredential: vi.fn(async () => "failed"),
}));

const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
const COPILOT_OPUS = "github-copilot/claude-opus-4.5";
const COPILOT_ASTRA = "github-copilot/gpt-6-astra";
const LLM_ASTRA = "pp-flant-openai/gpt-6-astra";
const SOL_PRO = "pp-flant-openai/gpt-6-sol-pro";

const defaults = () => {
  const config = getDefaultConfig();
  return { providers: config.providers, models: config.models };
};

const created: Orchestrator[] = [];

function makeOrchestrator(): Orchestrator {
  const orchestrator = new Orchestrator({ sendUserMessage: vi.fn(), sendMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } } as any);
  orchestrator.cwd = "/tmp/project";
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.lastCtx = { isIdle: () => true };
  orchestrator.switchModel = vi.fn(async () => true);
  created.push(orchestrator);
  return orchestrator;
}

function ctxOn(spec: string): any {
  const slash = spec.indexOf("/");
  return { abort: vi.fn(), isIdle: () => true, model: { provider: spec.slice(0, slash), id: spec.slice(slash + 1) }, ui: { notify: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadRoutingSettings).mockImplementation(() => defaults() as any);
  vi.mocked(probeSubscriptionCleared).mockResolvedValue("rate_limited" as any);
  vi.mocked(reviveSubscriptionCredential).mockResolvedValue("failed" as any);
  clearPauses();
  forgetLastGood();
  setCatalog([]);
});

afterEach(() => {
  for (const orchestrator of created.splice(0)) {
    clearAllPauses(orchestrator);
    if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
    if (orchestrator.idlePollTimer) clearTimeout(orchestrator.idlePollTimer);
  }
  clearPauses();
  forgetLastGood();
  setCatalog([]);
  vi.useRealTimers();
});

describe("rate-limit fallback — edges", () => {
  it("falls back to the default settings when they cannot be read", async () => {
    vi.mocked(loadRoutingSettings).mockImplementation(() => { throw new Error("unreadable"); });
    setCatalog([COPILOT_ASTRA, LLM_ASTRA]);
    const orchestrator = makeOrchestrator();
    const before = Date.now();
    await handleMainRateLimit(orchestrator, ctxOn(COPILOT_ASTRA), COPILOT_ASTRA);
    const until = getPause("copilot:gpt/astra")!.until!;
    expect(until - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(until - before).toBeLessThan(10 * 60_000 + 1000);
  });

  it("ignores a model no provider routes, a worker without a model, and an already paused key", async () => {
    const orchestrator = makeOrchestrator();
    await handleMainRateLimit(orchestrator, ctxOn("zai/glm-5.3"), "zai/glm-5.3");
    await handleSubagentRateLimit(orchestrator, ctxOn(SUB), undefined);
    await handleSubagentRateLimit(orchestrator, ctxOn(SUB), "zai/glm-5.3");
    expect(listPauses()).toEqual([]);
    pause("claude-sub", null, "earlier");
    const ctx = ctxOn(SUB);
    await handleMainRateLimit(orchestrator, ctx, SUB);
    expect(getPause("claude-sub")?.reason).toBe("earlier");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not move a session that left the paused model by the time the switch runs", async () => {
    setCatalog([COPILOT_ASTRA, LLM_ASTRA]);
    const orchestrator = makeOrchestrator();
    const ctx = ctxOn(COPILOT_ASTRA);
    orchestrator.lastCtx = { isIdle: () => false };
    await handleMainRateLimit(orchestrator, ctx, COPILOT_ASTRA);
    expect(orchestrator.pendingModelSwitches).toHaveLength(1);
    ctx.model = { provider: "zai", id: "glm-5.3" };
    await orchestrator.runSwitchAction(orchestrator.pendingModelSwitches.shift()!);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
  });

  it("replaces the expiry timer when a key is paused again, and ignores a stale one", async () => {
    vi.useFakeTimers();
    setCatalog([COPILOT_ASTRA, LLM_ASTRA]);
    const orchestrator = makeOrchestrator();
    await handleSubagentRateLimit(orchestrator, ctxOn(LLM_ASTRA), COPILOT_ASTRA, "retry-after: 60");
    const first = orchestrator.pauseTimers.get("copilot:gpt/astra");
    unpause("copilot:gpt/astra");
    await handleSubagentRateLimit(orchestrator, ctxOn(LLM_ASTRA), COPILOT_ASTRA, "retry-after: 120");
    expect(orchestrator.pauseTimers.get("copilot:gpt/astra")).not.toBe(first);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isPaused("copilot:gpt/astra")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isPaused("copilot:gpt/astra")).toBe(false);
  });

  it("keeps a session where it is when the model it would go back to is still paused", async () => {
    vi.useFakeTimers();
    setCatalog([COPILOT_ASTRA, LLM_ASTRA]);
    const orchestrator = makeOrchestrator();
    orchestrator.routedMainSpec = COPILOT_ASTRA;
    orchestrator.config.agents.main.model = "gpt/astra";
    await handleMainRateLimit(orchestrator, ctxOn(COPILOT_ASTRA), COPILOT_ASTRA, "retry-after: 60");
    expect(orchestrator.routedMainSpec).toBe(LLM_ASTRA);
    orchestrator.lastCtx = ctxOn(LLM_ASTRA);
    vi.mocked(orchestrator.switchModel).mockClear();
    setCatalog([LLM_ASTRA]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
  });
});

describe("refusals", () => {
  it("resends the first refusal, then leaves the vendor", async () => {
    setCatalog([SUB, SOL_PRO]);
    const orchestrator = makeOrchestrator();
    const ctx = ctxOn(SUB);
    await handleMainRefusal(orchestrator, ctx);
    expect(orchestrator.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("worth making again") }), expect.anything());
    await handleMainRefusal(orchestrator, ctx);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, SOL_PRO, "high");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`switched to ${SOL_PRO}`), "warning");
  });

  it.each([false, "throw"] as const)("halts when switching off the vendor returns %s", async (failure) => {
    setCatalog([SUB, SOL_PRO]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => {
      if (failure === "throw") throw new Error("down");
      return false;
    });
    orchestrator.refusalCount = 1;
    const ctx = ctxOn(SUB);
    await handleMainRefusal(orchestrator, ctx);
    expect(orchestrator.continuationHalted).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`The model kept refusing this conversation and switching to ${SOL_PRO} failed. Stopping.`, "error");
  });

  it("halts when there is nowhere to go, and stays quiet once halted", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.refusalCount = 1;
    const ctx = ctxOn(SUB);
    await handleMainRefusal(orchestrator, ctx);
    expect(orchestrator.continuationHalted).toBe(true);
    ctx.ui.notify.mockClear();
    await handleMainRefusal(orchestrator, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(orchestrator.refusalCount).toBe(3);
  });
});

describe("subscription credentials", () => {
  it("leaves models the subscription does not route, and an account already paused", async () => {
    const orchestrator = makeOrchestrator();
    await handleSubagentAuthFailure(orchestrator, ctxOn(SUB), undefined);
    await handleSubagentAuthFailure(orchestrator, ctxOn(SUB), COPILOT_OPUS);
    await demoteUnusableSubscription(orchestrator, ctxOn(COPILOT_OPUS), COPILOT_OPUS);
    pause("claude-sub", null, "earlier");
    await handleMainAuthFailure(orchestrator, ctxOn(SUB), SUB);
    expect(reviveSubscriptionCredential).not.toHaveBeenCalled();
  });

  it.each([["throttled", "moments after a renewal"], ["inconclusive", "could not reach the provider"]] as const)("does not retry on a %s check", async (outcome, wording) => {
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue(outcome as any);
    const orchestrator = makeOrchestrator();
    const ctx = ctxOn(SUB);
    await handleMainAuthFailure(orchestrator, ctx, SUB);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(wording), "warning");
    expect(orchestrator.pendingContinuations.size).toBe(0);
    expect(isPaused("claude-sub")).toBe(false);
  });
});

describe("subscription probe", () => {
  it("replaces a running probe timer and does nothing once the pause is gone", async () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();
    armSwitchBackProbe(orchestrator, SUB);
    const first = orchestrator.subSwitchBackTimer;
    armSwitchBackProbe(orchestrator, SUB);
    expect(orchestrator.subSwitchBackTimer).not.toBe(first);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probeSubscriptionCleared).not.toHaveBeenCalled();
  });

  it("drops a probe result when the pause was lifted while it ran", async () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();
    pause("claude-sub", null, "limit");
    vi.mocked(probeSubscriptionCleared).mockImplementation(async () => {
      unpause("claude-sub");
      return "ok" as any;
    });
    const notify = vi.fn();
    orchestrator.lastCtx = { isIdle: () => true, ui: { notify } };
    armSwitchBackProbe(orchestrator, SUB);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probeSubscriptionCleared).toHaveBeenCalledWith(SUB);
    expect(notify).not.toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).toBeNull();
  });
});
