import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { armSwitchBackProbe, handleMainRateLimit, isRateLimitError } from "./rate-limit-fallback.js";
import { clearAllTierDemotions, isSubscriptionFallbackActive, setSubscriptionFallbackActive, setTierEnabled, updateRegistryFromAvailableModels } from "./model-registry.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadFlantSettings: () => ({ autoRateLimitFallback: true, switchBackIntervalMinutes: 10 }),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
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
