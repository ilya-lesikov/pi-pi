import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { armSwitchBackProbe, handleMainAuthFailure, handleMainRateLimit, handleSubagentAuthFailure, handleSubagentRateLimit, isAuthError, isPolicyBlockError, isRateLimitError } from "./rate-limit-fallback.js";
import { clearAllTierDemotions, isSubscriptionFallbackActive, listTierDemotions, resolveModel, setSubscriptionFallbackActive, setTierEnabled, updateRegistryFromAvailableModels } from "./model-registry.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadFlantSettings: () => ({ autoRateLimitFallback: true, switchBackIntervalMinutes: 10 }),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
  reviveSubscriptionCredential: vi.fn(async () => "failed"),
}));

function makePi(): any {
  return { sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } };
}

function makeOrchestrator(pi: any): Orchestrator {
  const orchestrator = new Orchestrator(pi);
  orchestrator.cwd = "/tmp/project";
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.lastCtx = { isIdle: () => true };
  return orchestrator;
}

const subCtx = () => ({
  abort: vi.fn(),
  model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" },
  ui: { notify: vi.fn() },
});

describe("session-first rate-limit fallback", () => {
  beforeEach(() => {
    setSubscriptionFallbackActive(false);
    clearAllTierDemotions();
    setTierEnabled({ "copilot": false, "flant-sub": true, "flant-api": true });
    updateRegistryFromAvailableModels([]);
  });
  afterEach(() => {
    setSubscriptionFallbackActive(false);
    updateRegistryFromAvailableModels([]);
  });

  it("recognizes subscription limit errors", () => {
    expect(isRateLimitError("HTTP 429 too many requests")).toBe(true);
    expect(isRateLimitError("third-party apps draw from extra usage")).toBe(true);
    expect(isRateLimitError("invalid request")).toBe(false);
  });

  it("waits without switching when Claude has no fallback tier", async () => {
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainRateLimit(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(ctx.abort).toHaveBeenCalled();
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(orchestrator.subFallbackMainPriorSpec).toBeNull();
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no paid-gateway fallback"), "warning");
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  it("switches to Copilot and queues continuation when the tier is usable", async () => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainRateLimit(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "github-copilot/claude-opus-4.5", expect.any(String));
    expect(orchestrator.subFallbackMainPriorSpec).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(pi.sendUserMessage).toHaveBeenCalled();
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  it.each([false, "throw"] as const)("still arms the probe when model switching returns %s", async (failure) => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => {
      if (failure === "throw") throw new Error("unavailable");
      return false;
    });
    const ctx = subCtx();
    await handleMainRateLimit(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(orchestrator.subFallbackMainPriorSpec).toBeNull();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  // The failure this reproduces: a worker definition carries the model it was
  // built with, and pi-subagents lets that model outrank the spawning tool
  // call's argument. A definition left behind by the demotion therefore sends
  // every subsequent worker straight back to the tier that just refused them.
  it("rebuilds worker definitions onto the fallback tier and back again", async () => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.config.agents.subagents.simple.task.model = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    orchestrator.switchModel = vi.fn(async () => true);
    const taskModel = () => {
      const calls = pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:register-agents");
      return calls.at(-1)?.[1].agents.get("task").model;
    };

    orchestrator.registerAgents();
    expect(taskModel()).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    const emitted = pi.events.emit.mock.calls.length;
    orchestrator.registerAgents();
    expect(pi.events.emit.mock.calls.length).toBe(emitted);

    await handleSubagentRateLimit(orchestrator, subCtx(), "pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(taskModel()).toBe("github-copilot/claude-opus-4.5");

    setSubscriptionFallbackActive(false);
    orchestrator.registerAgents();
    expect(taskModel()).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  // A tier that is not the subscription is limited per model family, and the
  // session lands on one of them (Copilot) as soon as the subscription is
  // demoted — before this, a 429 there did nothing at all.
  it("demotes just the limited family of a non-subscription tier and restores it", async () => {
    vi.useFakeTimers();
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "github-copilot/gpt-6-astra",
      "pp-flant-openai/gpt-6-astra",
      "github-copilot/claude-opus-4.5",
    ]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = { abort: vi.fn(), model: { provider: "github-copilot", id: "gpt-6-astra" }, ui: { notify: vi.fn() } };

    await handleMainRateLimit(orchestrator, ctx, "gpt-6-astra", "github-copilot");
    expect(listTierDemotions()).toEqual(["copilot:gpt-astra"]);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-openai/gpt-6-astra", expect.any(String));
    // The live model may be one the user picked by hand, so the demotion does
    // not claim it: its own timer puts back the exact spec it moved off.
    expect(orchestrator.routedMainSpec).toBeNull();
    // The subscription's global latch stays untouched — this is not its limit.
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(resolveModel("github-copilot/claude-opus-4.5")).toBe("github-copilot/claude-opus-4.5");

    orchestrator.lastCtx = { isIdle: () => true, ui: { notify: vi.fn() }, model: { provider: "pp-flant-openai", id: "gpt-6-astra" } } as any;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listTierDemotions()).toEqual([]);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, "github-copilot/gpt-6-astra", expect.any(String)));
    vi.useRealTimers();
  });

  it("leaves the model alone at restore time when the session moved on", async () => {
    vi.useFakeTimers();
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels(["github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra"]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = { abort: vi.fn(), model: { provider: "github-copilot", id: "gpt-6-astra" }, ui: { notify: vi.fn() } };

    await handleMainRateLimit(orchestrator, ctx, "gpt-6-astra", "github-copilot");
    vi.mocked(orchestrator.switchModel).mockClear();
    // The user picked something else in the meantime.
    orchestrator.lastCtx = { isIdle: () => true, ui: { notify: vi.fn() }, model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" } } as any;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listTierDemotions()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("waits instead of switching when the limited tier has nothing below it", async () => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels(["github-copilot/claude-opus-4.5"]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = { abort: vi.fn(), model: { provider: "github-copilot", id: "claude-opus-4.5" }, ui: { notify: vi.fn() } };

    await handleMainRateLimit(orchestrator, ctx, "claude-opus-4.5", "github-copilot");
    expect(listTierDemotions()).toEqual(["copilot:opus"]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no lower provider tier"), "warning");
    for (const timer of orchestrator.tierRestoreTimers.values()) clearTimeout(timer);
  });

  it("leaves the main model alone when the limit hit a worker on another tier", async () => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels(["github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra"]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = { model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" }, ui: { notify: vi.fn() } };

    await handleSubagentRateLimit(orchestrator, ctx, "github-copilot/gpt-6-astra");
    expect(listTierDemotions()).toEqual(["copilot:gpt-astra"]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(orchestrator.subFallbackActive).toBe(false);
    for (const timer of orchestrator.tierRestoreTimers.values()) clearTimeout(timer);
  });

  // The prior spec is subscription-born, so it only resolves back to the
  // subscription once the fallback flag is cleared; resolving it while the flag
  // is still set walks it right back down onto the fallback tier.
  it("switches back to the subscription spec once the limit clears", async () => {
    vi.useFakeTimers();
    const { probeSubscriptionCleared } = await import("./flant-infra.js");
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.lastCtx = { isIdle: () => true, ui: { notify: vi.fn() } };
    orchestrator.switchModel = vi.fn(async () => true);
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackModelId = "sub/claude-opus-4-8";
    orchestrator.subFallbackMainPriorSpec = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    setSubscriptionFallbackActive(true);

    armSwitchBackProbe(orchestrator);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.subFallbackActive).toBe(false));

    expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, "pp-flant-anthropic-sub/sub/claude-opus-4-8", expect.any(String));
    expect(isSubscriptionFallbackActive()).toBe(false);
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("rate_limited" as any);
    vi.useRealTimers();
  });

  // A revoked subscription token is not a quota problem: the fix is to rotate
  // the credential in place, and only a rotation that cannot happen justifies
  // demoting the session to a lower tier.
  it("recognizes rejected credentials distinctly from rate limits", () => {
    expect(isAuthError('{"type":"authentication_error","message":"OAuth access token has been revoked."}')).toBe(true);
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("HTTP 429 too many requests")).toBe(false);
    expect(isRateLimitError('{"type":"authentication_error"}')).toBe(false);
  });

  // A refused payload routes nowhere: the next provider's filter objects to the
  // same content, and the credential and the quota are both fine.
  it("tells a refused payload apart from a rejected credential and a quota", () => {
    expect(isPolicyBlockError("This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.")).toBe(true);
    expect(isPolicyBlockError("Response was flagged by the content filter")).toBe(true);
    expect(isPolicyBlockError("401 Unauthorized")).toBe(false);
    expect(isPolicyBlockError("HTTP 429 too many requests")).toBe(false);
    expect(isAuthError("blocked under the Usage Policy")).toBe(false);
    expect(isRateLimitError("blocked under the Usage Policy")).toBe(false);
  });

  it("rotates a rejected credential and resumes without demoting the tier", async () => {
    const { reviveSubscriptionCredential } = await import("./flant-infra.js");
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("rotated");
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainAuthFailure(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).toBeNull();
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("failed");
  });

  // A worker that failed minutes ago cannot say which credential was rejected,
  // and by now it may already have been replaced. Rotating on that report would
  // revoke a working token; the recovery path re-checks instead and does
  // nothing when the credential currently works.
  it("resumes without rotating when the credential already works again", async () => {
    const { reviveSubscriptionCredential } = await import("./flant-infra.js");
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("ok");
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainAuthFailure(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("failed");
  });

  it("falls to the lower tier when a rejected credential cannot be renewed", async () => {
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainAuthFailure(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "github-copilot/claude-opus-4.5", expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login"), expect.any(String));
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  // A suppressed rotation leaves the SAME rejected credential in place, so an
  // automatic retry would fail identically and spin for as long as the
  // suppression lasts. Demoting would be wrong too: the credential may well be
  // fine, since another rotation just landed. Stop the turn and say so.
  it.each(["throttled", "inconclusive"] as const)("neither retries nor demotes on a %s recovery check", async (outcome) => {
    const { reviveSubscriptionCredential } = await import("./flant-infra.js");
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue(outcome);
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = subCtx();
    await handleMainAuthFailure(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not retrying"), "warning");
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("failed");
  });

  it("recovers a worker's rejected credential without touching the main model", async () => {
    const { reviveSubscriptionCredential } = await import("./flant-infra.js");
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("rotated");
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    await handleSubagentAuthFailure(orchestrator, subCtx(), "pp-flant-anthropic-sub/sub/claude-fable-5");
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("failed");
  });

  it("ignores a rejected credential on a model the subscription does not route", async () => {
    const { reviveSubscriptionCredential } = await import("./flant-infra.js");
    vi.mocked(reviveSubscriptionCredential).mockClear();
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainAuthFailure(orchestrator, subCtx(), "gpt-5.6-sol", "github-copilot");
    expect(reviveSubscriptionCredential).not.toHaveBeenCalled();
    expect(orchestrator.subFallbackActive).toBe(false);
  });

  // Switching the model compacts the session, and the host's compaction aborts
  // the run it is called from — so a probe that fires mid-request would kill
  // the very request it restored the subscription for.
  it("parks the switch back until the live request reaches a turn boundary", async () => {
    vi.useFakeTimers();
    const { probeSubscriptionCleared } = await import("./flant-infra.js");
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const orchestrator = makeOrchestrator(makePi());
    let idle = false;
    orchestrator.lastCtx = { isIdle: () => idle, ui: { notify: vi.fn() } };
    orchestrator.switchModel = vi.fn(async () => true);
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackModelId = "sub/claude-opus-4-8";
    orchestrator.subFallbackMainPriorSpec = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    setSubscriptionFallbackActive(true);

    armSwitchBackProbe(orchestrator);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.pendingModelSwitches.length).toBe(1));

    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(isSubscriptionFallbackActive()).toBe(true);

    // Still parked while the request runs, however long that takes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();

    // A probe landing after the last turn boundary has no turn_end left to
    // drain it, so the backstop poll has to carry out the whole restore.
    idle = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(orchestrator.subFallbackActive).toBe(false));
    expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, "pp-flant-anthropic-sub/sub/claude-opus-4-8", expect.any(String));
    expect(orchestrator.pendingModelSwitches).toEqual([]);
    expect(isSubscriptionFallbackActive()).toBe(false);

    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
    if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("rate_limited" as any);
    vi.useRealTimers();
  });

  it("keeps the fallback in effect when switching back fails", async () => {
    vi.useFakeTimers();
    const { probeSubscriptionCleared } = await import("./flant-infra.js");
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    setTierEnabled({ "copilot": true });
    updateRegistryFromAvailableModels([
      "pp-flant-anthropic-sub/sub/claude-opus-4-8",
      "github-copilot/claude-opus-4.5",
    ]);
    const orchestrator = makeOrchestrator(makePi());
    orchestrator.lastCtx = { isIdle: () => true, ui: { notify: vi.fn() } };
    orchestrator.switchModel = vi.fn(async () => false);
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackModelId = "sub/claude-opus-4-8";
    orchestrator.subFallbackMainPriorSpec = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    setSubscriptionFallbackActive(true);

    armSwitchBackProbe(orchestrator);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalled());

    expect(orchestrator.subFallbackActive).toBe(true);
    expect(isSubscriptionFallbackActive()).toBe(true);
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
    vi.mocked(probeSubscriptionCleared).mockResolvedValue("rate_limited" as any);
    vi.useRealTimers();
  });
});
