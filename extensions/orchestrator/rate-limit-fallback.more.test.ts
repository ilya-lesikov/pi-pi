import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSubscriptionRouted: vi.fn(),
  setSubscriptionFallbackActive: vi.fn(),
  toNonSubSpec: vi.fn((id: string) => `nonsub:${id}`),
  loadFlantSettings: vi.fn(() => ({ switchBackIntervalMinutes: 30 })),
  probeSubscriptionCleared: vi.fn(),
  askUser: vi.fn(),
  isCancel: vi.fn(() => false),
  getModelInfo: vi.fn((spec: string) => ({ family: /haiku/.test(spec) ? "haiku" : /opus/.test(spec) ? "opus" : "unknown" })),
}));

vi.mock("./usage-tracker.js", () => ({
  isSubscriptionRouted: mocks.isSubscriptionRouted,
}));
vi.mock("./model-registry.js", () => ({
  setSubscriptionFallbackActive: mocks.setSubscriptionFallbackActive,
  toNonSubSpec: mocks.toNonSubSpec,
  getModelInfo: mocks.getModelInfo,
  resolveModel: (s: string) => s,
  demoteTierForFamily: vi.fn(),
}));
vi.mock("./flant-infra.js", () => ({
  loadFlantSettings: mocks.loadFlantSettings,
  probeSubscriptionCleared: mocks.probeSubscriptionCleared,
}));
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  askUser: mocks.askUser,
  isCancel: mocks.isCancel,
}));
vi.mock("./log.js", () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import {
  isRateLimitError,
  isSdkRetryableError,
  handleMainRateLimit,
  handleSubagentRateLimit,
  armSwitchBackProbe,
} from "./rate-limit-fallback.js";

function makeOrchestrator(overrides: Record<string, unknown> = {}): any {
  return {
    subFallbackActive: false,
    subFallbackModelId: null,
    subFallbackDialogPending: false,
    subFallbackPendingDecision: false,
    activeTaskToken: 1,
    active: { state: { phase: "implement" } },
    subSwitchBackTimer: null,
    lastCtx: null,
    config: { agents: { orchestrators: { implement: { thinking: "high" } } } },
    cancelPendingRetry: vi.fn(),
    switchModel: vi.fn(async () => true),
    sendUserMessageWhenIdle: vi.fn(),
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    hasUI: true,
    abort: vi.fn(),
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.isSubscriptionRouted.mockReturnValue(true);
  mocks.isCancel.mockReturnValue(false);
  mocks.loadFlantSettings.mockReturnValue({ switchBackIntervalMinutes: 30 } as any);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("isRateLimitError extra shapes", () => {
  it("matches dotted/spaced rate-limit variants", () => {
    expect(isRateLimitError("rate-limit hit")).toBe(true);
    expect(isRateLimitError("RATELIMIT")).toBe(true);
    expect(isRateLimitError("HTTP 429 returned")).toBe(true);
  });
  it("does not match numbers that merely contain 429", () => {
    expect(isRateLimitError("error code 4290")).toBe(false);
    expect(isRateLimitError("connection reset")).toBe(false);
    expect(isRateLimitError(42 as any)).toBe(false);
  });
});

describe("isSdkRetryableError extra shapes", () => {
  it("matches a broad set of transient network/server errors", () => {
    for (const m of [
      "provider returned error",
      "502 bad gateway",
      "504",
      "service unavailable",
      "internal error",
      "connection refused",
      "websocket closed",
      "other side closed",
      "upstream connect error",
      "reset before headers",
      "socket hang up",
      "http2 request did not get a response",
      "terminated",
      "retry delay exceeded",
    ]) {
      expect(isSdkRetryableError(m)).toBe(true);
    }
  });
  it("rejects plain application errors and non-strings", () => {
    expect(isSdkRetryableError("permission denied")).toBe(false);
    expect(isSdkRetryableError(null as any)).toBe(false);
    expect(isSdkRetryableError(123 as any)).toBe(false);
  });
});

describe("handleMainRateLimit", () => {
  it("returns early without aborting when not subscription-routed", async () => {
    mocks.isSubscriptionRouted.mockReturnValue(false);
    const orch = makeOrchestrator();
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "claude", "provider");
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(orch.cancelPendingRetry).not.toHaveBeenCalled();
  });

  it("aborts and cancels retries, then stops when already on non-sub", async () => {
    const orch = makeOrchestrator({ subFallbackActive: true });
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(ctx.abort).toHaveBeenCalled();
    expect(orch.cancelPendingRetry).toHaveBeenCalled();
    expect(mocks.askUser).not.toHaveBeenCalled();
  });

  it("skips the dialog when no UI is available", async () => {
    const orch = makeOrchestrator();
    const ctx = makeCtx({ hasUI: false });
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(mocks.askUser).not.toHaveBeenCalled();
    expect(orch.switchModel).not.toHaveBeenCalled();
  });

  it("activates fallback and switches the main model on confirm", async () => {
    mocks.askUser.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    vi.useFakeTimers();
    const orch = makeOrchestrator();
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude-opus", "sub");
    expect(orch.subFallbackActive).toBe(true);
    expect(mocks.setSubscriptionFallbackActive).toHaveBeenCalledWith(true);
    expect(mocks.toNonSubSpec).toHaveBeenCalledWith("sub/claude-opus");
    expect(orch.switchModel).toHaveBeenCalled();
    expect(orch.sendUserMessageWhenIdle).toHaveBeenCalled();
    expect(orch.subSwitchBackTimer).not.toBeNull();
  });

  it("stays on subscription and notifies when the user declines", async () => {
    mocks.askUser.mockResolvedValue({ kind: "selection", selections: ["Stay on subscription"] });
    const orch = makeOrchestrator();
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(orch.subFallbackActive).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(orch.switchModel).not.toHaveBeenCalled();
  });

  it("does not open a second dialog while one is pending", async () => {
    const orch = makeOrchestrator({ subFallbackDialogPending: true });
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(mocks.askUser).not.toHaveBeenCalled();
  });

  it("a concurrent dispatch while a dialogue is open does NOT clear subFallbackPendingDecision (round-3 MINOR-1)", async () => {
    // Manual mode: dialogue #1 is open; a second sub-429 dispatch re-sets the
    // flag. The concurrent dispatch must NOT clear it — the open dialogue's
    // finally owns the clear. Clearing here would let the autonomous auto-retry
    // respawn on the still-sub-routed model and burn its once-only budget.
    const orch = makeOrchestrator({ subFallbackDialogPending: true, subFallbackPendingDecision: true });
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(mocks.askUser).not.toHaveBeenCalled();
    expect(orch.subFallbackPendingDecision).toBe(true);
  });

  it("aborts activation when the task token changes mid-dialog", async () => {
    const orch = makeOrchestrator();
    mocks.askUser.mockImplementation(async () => {
      orch.activeTaskToken = 999;
      return { kind: "selection", selections: ["Switch to non-sub Claude"] };
    });
    const ctx = makeCtx();
    await handleMainRateLimit(orch, ctx, "sub/claude", "sub");
    expect(orch.subFallbackActive).toBe(false);
    expect(orch.switchModel).not.toHaveBeenCalled();
  });
});

describe("handleSubagentRateLimit", () => {
  it("returns early when not subscription-routed", async () => {
    mocks.isSubscriptionRouted.mockReturnValue(false);
    const orch = makeOrchestrator();
    await handleSubagentRateLimit(orch, makeCtx(), "claude");
    expect(mocks.askUser).not.toHaveBeenCalled();
  });

  it("returns early when already on non-sub", async () => {
    const orch = makeOrchestrator({ subFallbackActive: true });
    await handleSubagentRateLimit(orch, makeCtx(), "sub/claude");
    expect(mocks.askUser).not.toHaveBeenCalled();
  });

  it("does not switch the main model for a subagent 429 when main is a DIFFERENT family", async () => {
    mocks.askUser.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    vi.useFakeTimers();
    const orch = makeOrchestrator();
    // Main is a sub-routed OPUS; the limited subagent is HAIKU -> different
    // family -> main is left alone.
    const ctx = makeCtx({ model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-opus" } });
    await handleSubagentRateLimit(orch, ctx, "sub/claude-haiku");
    expect(mocks.setSubscriptionFallbackActive).toHaveBeenCalledWith(true);
    expect(orch.switchModel).not.toHaveBeenCalled();
    expect(orch.subFallbackActive).toBe(true);
  });

  it("switches the main model for a subagent 429 when main is the SAME sub-routed family", async () => {
    mocks.askUser.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    vi.useFakeTimers();
    const orch = makeOrchestrator();
    const ctx = makeCtx({ model: { provider: "pp-flant-anthropic-sub", id: "sub/claude-haiku" } });
    await handleSubagentRateLimit(orch, ctx, "sub/claude-haiku");
    expect(orch.switchModel).toHaveBeenCalled();
    expect(orch.subFallbackActive).toBe(true);
  });
});

describe("armSwitchBackProbe", () => {
  it("schedules a timer using the configured interval and clears any prior timer", () => {
    vi.useFakeTimers();
    const prior = setTimeout(() => {}, 100000) as any;
    const orch = makeOrchestrator({ subSwitchBackTimer: prior });
    armSwitchBackProbe(orch);
    expect(orch.subSwitchBackTimer).not.toBeNull();
    expect(orch.subSwitchBackTimer).not.toBe(prior);
  });

  it("floors the interval to at least one minute", () => {
    vi.useFakeTimers();
    mocks.loadFlantSettings.mockReturnValue({ switchBackIntervalMinutes: 0 } as any);
    const orch = makeOrchestrator();
    armSwitchBackProbe(orch);
    expect(orch.subSwitchBackTimer).not.toBeNull();
  });

  it("reads the interval scoped to the orchestrator's cwd (project override binds)", () => {
    vi.useFakeTimers();
    mocks.loadFlantSettings.mockClear();
    const orch = makeOrchestrator({ cwd: "/proj" });
    armSwitchBackProbe(orch);
    expect(mocks.loadFlantSettings).toHaveBeenCalledWith("/proj");
  });

  it("runs the probe when the timer fires and stays on non-sub while still limited", async () => {
    vi.useFakeTimers();
    mocks.probeSubscriptionCleared.mockResolvedValue("rate_limited");
    const orch = makeOrchestrator({ subFallbackActive: true, subFallbackModelId: "sub/claude" });
    armSwitchBackProbe(orch);
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.probeSubscriptionCleared).toHaveBeenCalledWith("sub/claude");
  });
});
