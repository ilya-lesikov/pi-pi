import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { handleMainRateLimit, isRateLimitError } from "./rate-limit-fallback.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadFlantSettings: () => ({ autoRateLimitFallback: true, switchBackIntervalMinutes: 10 }),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
}));

describe("session-first rate-limit fallback", () => {
  it("recognizes subscription limit errors", () => {
    expect(isRateLimitError("HTTP 429 too many requests")).toBe(true);
    expect(isRateLimitError("third-party apps draw from extra usage")).toBe(true);
    expect(isRateLimitError("invalid request")).toBe(false);
  });

  it("switches a subscription-routed main model and queues continuation", async () => {
    const pi = { sendUserMessage: vi.fn() } as any;
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = {
      abort: vi.fn(),
      model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" },
      ui: { notify: vi.fn() },
    };
    await handleMainRateLimit(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(ctx.abort).toHaveBeenCalled();
    expect(orchestrator.subFallbackActive).toBe(true);
    expect(orchestrator.switchModel).toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalled();
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  });

  it.each([false, "throw"] as const)("does not commit fallback when model switching returns %s", async (failure) => {
    const pi = { sendUserMessage: vi.fn() } as any;
    const orchestrator = new Orchestrator(pi);
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.switchModel = vi.fn(async () => {
      if (failure === "throw") throw new Error("unavailable");
      return false;
    });
    const ctx = {
      abort: vi.fn(),
      model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" },
      ui: { notify: vi.fn() },
    };
    await handleMainRateLimit(orchestrator, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orchestrator.subFallbackActive).toBe(false);
    expect(orchestrator.subFallbackModelId).toBeNull();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
