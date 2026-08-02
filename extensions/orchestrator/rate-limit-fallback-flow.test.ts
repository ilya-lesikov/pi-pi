import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock collaborators so the flow test exercises only the fallback orchestration
// (dialog gating, main-vs-subagent switch gating, override activation).
vi.mock("./log.js", () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const askUserMock = vi.fn();
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  askUser: (...args: any[]) => askUserMock(...args),
  isCancel: (v: any) => !!v && v.__cancel === true,
}));

const flantSettings: { switchBackIntervalMinutes: number; autoRateLimitFallback: boolean } = {
  switchBackIntervalMinutes: 30,
  autoRateLimitFallback: false,
};
vi.mock("./flant-infra.js", () => ({
  loadFlantSettings: () => ({ ...flantSettings }),
  probeSubscriptionCleared: vi.fn(),
  SUB_PROVIDER: "pp-flant-anthropic-sub",
  SUB_MODEL_PREFIX: "sub/",
}));

const setSubscriptionFallbackActiveMock = vi.fn();
const demoteTierForFamilyMock = vi.fn();
// Minimal family classifier for the mock: derive from the model id substring.
function fakeFamily(spec: string): string {
  if (/claude-opus/.test(spec)) return "opus";
  if (/claude-sonnet/.test(spec)) return "sonnet";
  if (/claude-haiku/.test(spec)) return "haiku";
  if (/gpt/.test(spec)) return "gpt-sol";
  return "unknown";
}
vi.mock("./model-registry.js", () => ({
  setSubscriptionFallbackActive: (v: boolean) => setSubscriptionFallbackActiveMock(v),
  toNonSubSpec: (spec: string) =>
    spec.replace(/^pp-flant-anthropic-sub\/sub\//, "pp-flant-anthropic/").replace(/^sub\//, "pp-flant-anthropic/"),
  getModelInfo: (spec: string) => ({ family: fakeFamily(spec ?? "") }),
  // Simulate the resolver DROPPING a sub-routed spec to flant-api after the
  // monthly-cap demotion so handleMonthlyCap sees a real tier change.
  resolveModel: (spec: string) =>
    spec.replace(/^pp-flant-anthropic-sub\/sub\//, "pp-flant-anthropic/").replace(/^sub\//, "pp-flant-anthropic/"),
  demoteTierForFamily: (...a: any[]) => demoteTierForFamilyMock(...a),
}));

import { handleMainRateLimit, handleSubagentRateLimit, handleMonthlyCap } from "./rate-limit-fallback.js";

function makeOrchestrator() {
  return {
    active: { state: { phase: "implement" } },
    activeTaskToken: 1,
    subFallbackActive: false,
    subFallbackDialogPending: false,
    subFallbackPendingDecision: false,
    subFallbackModelId: null as string | null,
    subSwitchBackTimer: null as any,
    config: { agents: { orchestrators: { implement: { thinking: "high" } } } },
    switchModel: vi.fn().mockResolvedValue(true),
    sendUserMessageWhenIdle: vi.fn(),
    cancelPendingRetry: vi.fn(),
    safeSendUserMessage: vi.fn(),
  } as any;
}

function makeCtx(model?: { provider: string; id: string }) {
  return { hasUI: true, abort: vi.fn(), ui: { notify: vi.fn() }, model };
}

beforeEach(() => {
  askUserMock.mockReset();
  setSubscriptionFallbackActiveMock.mockReset();
  flantSettings.switchBackIntervalMinutes = 30;
  flantSettings.autoRateLimitFallback = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("handleSubagentRateLimit (M2: same-family main switch)", () => {
  it("switches the main model when main is on the SAME subscription-routed family", async () => {
    vi.useFakeTimers();
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    const orch = makeOrchestrator();
    // Main is on the sub-routed opus family that got limited.
    const ctx = makeCtx({ provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" });

    await handleSubagentRateLimit(orch, ctx, "pp-flant-anthropic-sub/sub/claude-opus-4-8");

    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    expect(orch.subFallbackActive).toBe(true);
    // Same family -> main IS switched off the limited subscription.
    expect(orch.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-anthropic/claude-opus-4-8", "high");
    expect(orch.sendUserMessageWhenIdle).toHaveBeenCalledTimes(1);
    expect(orch.safeSendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves the main model alone when main is a DIFFERENT family (subagent gpt limit, claude main)", async () => {
    vi.useFakeTimers();
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    const orch = makeOrchestrator();
    // Main is a Claude opus; the limited subagent is a sub-routed... opus too,
    // but main is NOT sub-routed here (paid), so it must not switch.
    const ctx = makeCtx({ provider: "pp-flant-anthropic", id: "claude-opus-4-8" });

    await handleSubagentRateLimit(orch, ctx, "pp-flant-anthropic-sub/sub/claude-opus-4-8");

    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    // Main is not subscription-routed -> not switched.
    expect(orch.switchModel).not.toHaveBeenCalled();
  });

  it("does nothing for a non-subscription subagent model", async () => {
    const orch = makeOrchestrator();
    await handleSubagentRateLimit(orch, makeCtx(), "pp-flant-anthropic/claude-opus-4-8");
    expect(askUserMock).not.toHaveBeenCalled();
    expect(orch.subFallbackActive).toBe(false);
  });

  it("clears the pending-decision flag after the dialog resolves", async () => {
    vi.useFakeTimers();
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    const orch = makeOrchestrator();
    orch.subFallbackPendingDecision = true; // set synchronously by the detection site
    await handleSubagentRateLimit(orch, makeCtx(), "pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(orch.subFallbackPendingDecision).toBe(false);
  });
});

describe("handleMainRateLimit (main-origin switches the main model)", () => {
  it("switches the main model to the non-sub equivalent on confirm", async () => {
    vi.useFakeTimers();
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    const orch = makeOrchestrator();
    const ctx = makeCtx();

    await handleMainRateLimit(orch, ctx, "pp-flant-anthropic-sub/sub/claude-opus-4-8", "pp-flant-anthropic-sub");

    // Futile retry stopped.
    expect(ctx.abort).toHaveBeenCalled();
    expect(orch.cancelPendingRetry).toHaveBeenCalled();
    // Session override on + main model switched to non-sub.
    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    expect(orch.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-anthropic/claude-opus-4-8", "high");
    expect(orch.sendUserMessageWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("declining does not switch or activate the override", async () => {
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Stay on subscription"] });
    const orch = makeOrchestrator();
    await handleMainRateLimit(orch, makeCtx(), "pp-flant-anthropic-sub/sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(orch.switchModel).not.toHaveBeenCalled();
    expect(setSubscriptionFallbackActiveMock).not.toHaveBeenCalledWith(true);
    expect(orch.subFallbackActive).toBe(false);
  });

  it("is sticky: no dialog when already on fallback", async () => {
    const orch = makeOrchestrator();
    orch.subFallbackActive = true;
    await handleMainRateLimit(orch, makeCtx(), "pp-flant-anthropic-sub/sub/claude-opus-4-8", "pp-flant-anthropic-sub");
    expect(askUserMock).not.toHaveBeenCalled();
  });
});

describe("automatic fallback (no dialogue) when autoRateLimitFallback is ON", () => {
  it("main-origin: switches without asking and notifies", async () => {
    vi.useFakeTimers();
    flantSettings.autoRateLimitFallback = true;
    const orch = makeOrchestrator();
    const ctx = makeCtx();

    await handleMainRateLimit(orch, ctx, "pp-flant-anthropic-sub/sub/claude-opus-4-8", "pp-flant-anthropic-sub");

    // No permission dialogue was shown.
    expect(askUserMock).not.toHaveBeenCalled();
    // Switch still happened: override on + main model switched + notification.
    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    expect(orch.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-anthropic/claude-opus-4-8", "high");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(orch.subFallbackActive).toBe(true);
  });

  it("subagent-origin auto: no dialogue; switches main only when same sub-routed family", async () => {
    vi.useFakeTimers();
    flantSettings.autoRateLimitFallback = true;
    const orch = makeOrchestrator();
    // Main on a different (paid, non-sub) model -> not switched.
    const ctx = makeCtx({ provider: "pp-flant-anthropic", id: "claude-opus-4-8" });

    await handleSubagentRateLimit(orch, ctx, "pp-flant-anthropic-sub/sub/claude-opus-4-8");

    expect(askUserMock).not.toHaveBeenCalled();
    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    expect(orch.switchModel).not.toHaveBeenCalled();
  });
});

describe("handleMonthlyCap (C2: bare-id classification + live main switch)", () => {
  beforeEach(() => demoteTierForFamilyMock.mockReset());

  it("classifies a BARE model id + provider, demotes the tier, and switches the live main model", () => {
    const orch = makeOrchestrator();
    const ctx = makeCtx({ provider: "pp-flant-anthropic-sub", id: "sub/claude-opus-4-8" });
    // turn_end reports model as a BARE id + separate provider (the C2 bug).
    handleMonthlyCap(orch, ctx, "sub/claude-opus-4-8", "pp-flant-anthropic-sub");

    // Tier was classified (flant-sub) and demoted for the opus family — NOT the
    // old "unclassifiable" dead-end.
    expect(demoteTierForFamilyMock).toHaveBeenCalledWith("flant-sub", "opus");
    // Live main model switched to the resolver's next-tier spec.
    expect(orch.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-anthropic/claude-opus-4-8", "high");
    expect(orch.sendUserMessageWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("does not loop when already on the floor tier (resolver can't move it)", () => {
    const orch = makeOrchestrator();
    const ctx = makeCtx({ provider: "pp-flant-anthropic", id: "claude-opus-4-8" });
    // Already flant-api (floor): resolveModel returns it unchanged, so no lower
    // tier -> terminal message, no switch, no nudge (no notify/nudge loop).
    handleMonthlyCap(orch, ctx, "claude-opus-4-8", "pp-flant-anthropic");

    expect(demoteTierForFamilyMock).toHaveBeenCalledWith("flant-api", "opus");
    expect(orch.switchModel).not.toHaveBeenCalled();
    expect(orch.sendUserMessageWhenIdle).not.toHaveBeenCalled();
  });
});
