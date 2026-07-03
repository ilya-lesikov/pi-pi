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

vi.mock("./flant-infra.js", () => ({
  loadFlantSettings: () => ({ switchBackIntervalMinutes: 30 }),
  probeSubscriptionCleared: vi.fn(),
  SUB_PROVIDER: "pp-flant-anthropic-sub",
  SUB_MODEL_PREFIX: "sub/",
}));

const setSubscriptionFallbackActiveMock = vi.fn();
vi.mock("./model-registry.js", () => ({
  setSubscriptionFallbackActive: (v: boolean) => setSubscriptionFallbackActiveMock(v),
  toNonSubSpec: (spec: string) =>
    spec.replace(/^pp-flant-anthropic-sub\/sub\//, "pp-flant-anthropic/").replace(/^sub\//, "pp-flant-anthropic/"),
}));

import { handleMainRateLimit, handleSubagentRateLimit } from "./rate-limit-fallback.js";

function makeOrchestrator() {
  return {
    active: { state: { phase: "debug" } },
    activeTaskToken: 1,
    subFallbackActive: false,
    subFallbackDialogPending: false,
    subFallbackPendingDecision: false,
    subFallbackModelId: null as string | null,
    subSwitchBackTimer: null as any,
    config: { agents: { orchestrators: { debug: { thinking: "high" }, implement: { thinking: "high" } } } },
    switchModel: vi.fn().mockResolvedValue(true),
    sendUserMessageWhenIdle: vi.fn(),
    cancelPendingRetry: vi.fn(),
    safeSendUserMessage: vi.fn(),
  } as any;
}

function makeCtx() {
  return { hasUI: true, abort: vi.fn(), ui: { notify: vi.fn() } };
}

beforeEach(() => {
  askUserMock.mockReset();
  setSubscriptionFallbackActiveMock.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("handleSubagentRateLimit (M1: does not switch the main model)", () => {
  it("activates the session override + nudges but does NOT switch the main model", async () => {
    vi.useFakeTimers();
    askUserMock.mockResolvedValue({ kind: "selection", selections: ["Switch to non-sub Claude"] });
    const orch = makeOrchestrator();

    await handleSubagentRateLimit(orch, makeCtx(), "pp-flant-anthropic-sub/sub/claude-opus-4-8");

    expect(setSubscriptionFallbackActiveMock).toHaveBeenCalledWith(true);
    expect(orch.subFallbackActive).toBe(true);
    // Main model must NOT change for a subagent-origin 429.
    expect(orch.switchModel).not.toHaveBeenCalled();
    // Continuation nudge is idle-gated (not a bare safeSendUserMessage).
    expect(orch.sendUserMessageWhenIdle).toHaveBeenCalledTimes(1);
    expect(orch.safeSendUserMessage).not.toHaveBeenCalled();
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
