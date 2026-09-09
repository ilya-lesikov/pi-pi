import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { armSwitchBackProbe, handleMainAuthFailure, handleMainRateLimit, handleSubagentAuthFailure, isAuthError, isPolicyBlockError, isRateLimitError } from "./rate-limit-fallback.js";
import { clearAllTierDemotions, isSubscriptionFallbackActive, setSubscriptionFallbackActive, setTierEnabled, updateRegistryFromAvailableModels } from "./model-registry.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadFlantSettings: () => ({ autoRateLimitFallback: true, switchBackIntervalMinutes: 10 }),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
  reviveSubscriptionCredential: vi.fn(async () => "failed"),
}));

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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const orchestrator = makeOrchestrator({ sendUserMessage: vi.fn() } as any);
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const orchestrator = makeOrchestrator({ sendUserMessage: vi.fn() } as any);
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const pi = { sendUserMessage: vi.fn() } as any;
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
    const orchestrator = makeOrchestrator({ sendUserMessage: vi.fn() } as any);
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
    const orchestrator = makeOrchestrator({ sendUserMessage: vi.fn() } as any);
    let idle = false;
    orchestrator.lastCtx = { isIdle: () => idle, ui: { notify: vi.fn() } };
    orchestrator.switchModel = vi.fn(async () => true);
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackModelId = "sub/claude-opus-4-8";
    orchestrator.subFallbackMainPriorSpec = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
    setSubscriptionFallbackActive(true);

    armSwitchBackProbe(orchestrator);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.pendingModelSwitch).not.toBeNull());

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
    expect(orchestrator.pendingModelSwitch).toBeNull();
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
    const orchestrator = makeOrchestrator({ sendUserMessage: vi.fn() } as any);
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
