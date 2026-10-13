import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { loadRoutingSettings, probeSubscriptionCleared, reviveSubscriptionCredential } from "./flant-infra.js";
import {
  clearAllPauses,
  demoteUnusableSubscription,
  handleMainAuthFailure,
  handleMainRateLimit,
  handleSubagentAuthFailure,
  handleSubagentRateLimit,
  handleSubscriptionRouteOutage,
  isAuthError,
  isModelRefusal,
  isPolicyBlockError,
  isRateLimitError,
  retryHintMs,
} from "./rate-limit-fallback.js";
import { clearPauses, forgetLastGood, getPause, isPaused, listPauses, refusalFallbackSpec, resolveSpec, setCatalog } from "./routing.js";

vi.mock("./flant-infra.js", async (original) => ({
  ...(await original<any>()),
  loadRoutingSettings: vi.fn(),
  probeSubscriptionCleared: vi.fn(async () => "rate_limited"),
  reviveSubscriptionCredential: vi.fn(async () => "failed"),
}));

const SUB = "pp-flant-anthropic-sub/sub/claude-opus-4-8";
const DIRECT = "pp-claude-sub/claude-opus-4-8";
const COPILOT_OPUS = "github-copilot/claude-opus-4.5";

function defaultRoutingSettings(): any {
  const defaults = getDefaultConfig();
  return { providers: defaults.providers, models: defaults.models };
}

function makePi(): any {
  return { sendUserMessage: vi.fn(), sendMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } };
}

const created: Orchestrator[] = [];

function makeOrchestrator(pi: any = makePi()): Orchestrator {
  const orchestrator = new Orchestrator(pi);
  orchestrator.cwd = "/tmp/project";
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.lastCtx = { isIdle: () => true };
  created.push(orchestrator);
  return orchestrator;
}

function ctxOn(spec: string): any {
  const slash = spec.indexOf("/");
  return { abort: vi.fn(), model: { provider: spec.slice(0, slash), id: spec.slice(slash + 1) }, ui: { notify: vi.fn() } };
}

function idleCtxOn(spec: string): any {
  return { ...ctxOn(spec), isIdle: () => true };
}

const pauseKeys = () => listPauses().map((p) => p.key);

describe("pause-based rate-limit fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadRoutingSettings).mockImplementation(() => defaultRoutingSettings());
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
      orchestrator.stopStaleAgentWatchdog();
    }
    clearPauses();
    forgetLastGood();
    setCatalog([]);
    vi.useRealTimers();
  });

  it("recognizes subscription limit errors", () => {
    expect(isRateLimitError("HTTP 429 too many requests")).toBe(true);
    expect(isRateLimitError("third-party apps draw from extra usage")).toBe(true);
    expect(isRateLimitError("invalid request")).toBe(false);
  });

  // pi's openai-codex provider swallows the 429 and throws this sentence
  // instead, so neither the status nor the word "rate" is left to match.
  it("recognizes the ChatGPT subscription's own quota wording", () => {
    expect(isRateLimitError("You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.")).toBe(true);
    expect(isRateLimitError("usage_not_included")).toBe(true);
  });

  // The wording arrived verbatim from the provider; the raw stop reason is the
  // reliable half, since a gateway is free to reword the explanation.
  it("recognizes an outright refusal by stop reason or by wording", () => {
    const tos = "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
    expect(isModelRefusal("refusal", undefined)).toBe(true);
    expect(isModelRefusal(undefined, tos)).toBe(true);
    expect(isModelRefusal("end_turn", "HTTP 429 too many requests")).toBe(false);
    expect(isModelRefusal(undefined, "blocked under Anthropic's Usage Policy")).toBe(false);
  });

  it("picks the latest Sol Pro to route a refusal onto, degrades to the base SKU, and never stays on the vendor", () => {
    setCatalog([
      "pp-flant-openai/gpt-5.5-sol-pro",
      "pp-flant-openai/gpt-5.6-sol",
      "pp-flant-openai/gpt-5.6-sol-pro",
    ]);
    expect(refusalFallbackSpec(SUB)).toBe("pp-flant-openai/gpt-5.6-sol-pro");
    // Already on GPT: the refusal escape has to leave the vendor, so there is none.
    expect(refusalFallbackSpec("pp-flant-openai/gpt-5.6-sol")).toBeNull();
    setCatalog(["pp-flant-openai/gpt-5.6-sol"]);
    expect(refusalFallbackSpec(SUB)).toBe("pp-flant-openai/gpt-5.6-sol");
    setCatalog([SUB]);
    expect(refusalFallbackSpec(SUB)).toBeNull();
  });

  it("reads the provider's wait hint from Retry-After or the ChatGPT sentence", () => {
    expect(retryHintMs("You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.")).toBe(43 * 60_000);
    expect(retryHintMs("try again in 5 min")).toBe(5 * 60_000);
    expect(retryHintMs("HTTP 429 Too Many Requests; retry-after: 120")).toBe(120_000);
    expect(retryHintMs("Retry-After=30s")).toBe(30_000);
    expect(retryHintMs("HTTP 429 too many requests")).toBeNull();
    expect(retryHintMs(undefined)).toBeNull();
  });

  it("pauses for exactly as long as the provider asked", async () => {
    vi.useFakeTimers();
    setCatalog(["github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra"]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn("github-copilot/gpt-6-astra");
    const before = Date.now();

    await handleMainRateLimit(orchestrator, ctx, "gpt-6-astra", "github-copilot", "429 Too Many Requests, retry-after: 120");
    expect(getPause("copilot:gpt/astra")?.until).toBe(before + 120_000);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(isPaused("copilot:gpt/astra")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isPaused("copilot:gpt/astra")).toBe(false);
  });

  it("waits without switching when nothing else serves Claude", async () => {
    setCatalog([SUB]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainRateLimit(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(ctx.abort).toHaveBeenCalled();
    // The account's pause has no timer: only the probe lifts it.
    expect(getPause("claude-sub")?.until).toBeNull();
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
    expect(orchestrator.subProbeSpec).toBe(SUB);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Waiting until"), "warning");
  });

  it("switches to Copilot and queues continuation when it serves the slot", async () => {
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainRateLimit(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual(["claude-sub"]);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, COPILOT_OPUS, expect.any(String));
    expect(orchestrator.pausedMainRoutes.get("claude-sub")).toEqual({ from: SUB, to: COPILOT_OPUS });
    expect(orchestrator.routedMainSpec).toBe(COPILOT_OPUS);
    expect(pi.sendUserMessage).toHaveBeenCalled();
  });

  it.each([false, "throw"] as const)("still arms the probe when model switching returns %s", async (failure) => {
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => {
      if (failure === "throw") throw new Error("unavailable");
      return false;
    });
    const ctx = ctxOn(SUB);
    await handleMainRateLimit(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(isPaused("claude-sub")).toBe(true);
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
    expect(orchestrator.routedMainSpec).toBe(SUB);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
  });

  it("tells the user and pauses nothing when automatic fallback is off", async () => {
    const settings = defaultRoutingSettings();
    settings.providers.fallback.auto = false;
    vi.mocked(loadRoutingSettings).mockReturnValue(settings);
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainRateLimit(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Automatic fallback is off"), "warning");
  });

  // The failure this reproduces: a worker definition carries the model it was
  // built with, and pi-subagents lets that model outrank the spawning tool
  // call's argument. A definition left behind by the pause therefore sends
  // every subsequent worker straight back to the provider that just refused them.
  it("rebuilds worker definitions onto the next provider and back again", async () => {
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const taskModel = () => {
      const calls = pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:register-agents");
      return calls.at(-1)?.[1].agents.get("task").model;
    };

    orchestrator.registerAgents();
    expect(taskModel()).toBe(SUB);
    const emitted = pi.events.emit.mock.calls.length;
    orchestrator.registerAgents();
    expect(pi.events.emit.mock.calls.length).toBe(emitted);

    await handleSubagentRateLimit(orchestrator, ctxOn("pp-flant-openai/gpt-6-luna"), SUB);
    expect(taskModel()).toBe(COPILOT_OPUS);

    clearAllPauses(orchestrator);
    orchestrator.registerAgents();
    expect(taskModel()).toBe(SUB);
  });

  // Copilot limits per model line, so only that slot steps aside; the session
  // pi-pi routed follows its configured model to the next provider and comes
  // back once the window elapses.
  it("pauses one Copilot slot, moves main to the next provider and restores it on expiry", async () => {
    vi.useFakeTimers();
    const settings = defaultRoutingSettings();
    settings.providers.order = ["copilot", "llm-api", "claude-sub", "codex"];
    const LLM_OPUS = "pp-flant-openai/claude-opus-4-8";
    setCatalog([COPILOT_OPUS, LLM_OPUS, "github-copilot/gpt-6-astra"]);
    const orchestrator = makeOrchestrator();
    const config = normalizeConfigDurations(getDefaultConfig());
    config.providers.order = settings.providers.order;
    orchestrator.config = config;
    expect(resolveSpec("claude/opus")).toBe(COPILOT_OPUS);
    orchestrator.routedMainSpec = COPILOT_OPUS;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(COPILOT_OPUS);

    await handleMainRateLimit(orchestrator, ctx, "claude-opus-4.5", "github-copilot");
    expect(pauseKeys()).toEqual(["copilot:claude/opus"]);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, LLM_OPUS, expect.any(String));
    expect(orchestrator.routedMainSpec).toBe(LLM_OPUS);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("(paid)"), "warning");
    // Only that slot: Copilot still serves GPT Astra.
    expect(resolveSpec("gpt/astra")).toBe("github-copilot/gpt-6-astra");

    orchestrator.lastCtx = idleCtxOn(LLM_OPUS);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pauseKeys()).toEqual([]);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, COPILOT_OPUS, expect.any(String)));
    expect(orchestrator.routedMainSpec).toBe(COPILOT_OPUS);
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
  });

  // The live model may be one the user picked by hand: it moves within its own
  // slot, and the pause's expiry puts back the exact spec it moved off.
  it("moves a hand-picked model within its slot and puts it back on expiry", async () => {
    vi.useFakeTimers();
    setCatalog(["github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra", COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn("github-copilot/gpt-6-astra");

    await handleMainRateLimit(orchestrator, ctx, "gpt-6-astra", "github-copilot");
    expect(pauseKeys()).toEqual(["copilot:gpt/astra"]);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-openai/gpt-6-astra", expect.any(String));
    expect(orchestrator.routedMainSpec).toBeNull();
    expect(resolveSpec("claude/opus")).toBe(COPILOT_OPUS);

    orchestrator.lastCtx = idleCtxOn("pp-flant-openai/gpt-6-astra");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pauseKeys()).toEqual([]);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, "github-copilot/gpt-6-astra", expect.any(String)));
  });

  // End to end rather than by flag: the quota message has to survive the
  // handler's own rate-limit gate, and its "Try again in" sets the pause.
  it("pauses the ChatGPT subscription on its quota message for the hinted time and falls to the paid gateway", async () => {
    vi.useFakeTimers();
    setCatalog(["openai-codex/gpt-5.7-sol", "pp-flant-openai/gpt-5.6-sol"]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn("openai-codex/gpt-5.7-sol");
    const message = "You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.";

    expect(isRateLimitError(message)).toBe(true);
    const before = Date.now();
    await handleMainRateLimit(orchestrator, ctx, "gpt-5.7-sol", "openai-codex", message);

    // The ChatGPT quota is the account's, so the whole provider steps aside.
    expect(pauseKeys()).toEqual(["codex"]);
    expect(getPause("codex")?.until).toBe(before + 43 * 60_000);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, "pp-flant-openai/gpt-5.6-sol", expect.any(String));
  });

  it("leaves the model alone at restore time when the session moved on", async () => {
    vi.useFakeTimers();
    setCatalog(["github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra"]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn("github-copilot/gpt-6-astra");

    await handleMainRateLimit(orchestrator, ctx, "gpt-6-astra", "github-copilot");
    vi.mocked(orchestrator.switchModel).mockClear();
    // The user picked something else in the meantime.
    orchestrator.lastCtx = idleCtxOn(SUB);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
  });

  // A pin or an override names one model; there is no other provider to move
  // it to, so the session waits out the pause on it.
  it.each(["pin", "override"] as const)("waits instead of switching a %s main that has nowhere to go", async (kind) => {
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    const config = normalizeConfigDurations(getDefaultConfig());
    if (kind === "pin") config.agents.main.model = COPILOT_OPUS;
    else config.models.claude.override = { provider: "github-copilot", model: "claude-opus-4.5" };
    orchestrator.config = config;
    orchestrator.routedMainSpec = COPILOT_OPUS;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(COPILOT_OPUS);

    await handleMainRateLimit(orchestrator, ctx, "claude-opus-4.5", "github-copilot");
    expect(pauseKeys()).toEqual(["copilot:claude/opus"]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(orchestrator.pausedMainRoutes.size).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Waiting until"), "warning");
  });

  it("leaves the main model alone when the limit hit a worker on another provider", async () => {
    setCatalog([SUB, "github-copilot/gpt-6-astra", "pp-flant-openai/gpt-6-astra"]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);

    await handleSubagentRateLimit(orchestrator, ctx, "github-copilot/gpt-6-astra");
    expect(pauseKeys()).toEqual(["copilot:gpt/astra"]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(isPaused("claude-sub")).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("on a worker"), "warning");
  });

  // The gateway failing says nothing about the account: only that route steps
  // aside, and the direct route carries the same subscription on.
  it("moves the session to the direct subscription route when the gateway route fails", async () => {
    setCatalog([SUB, DIRECT, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);

    expect(await handleSubscriptionRouteOutage(orchestrator, ctx, SUB, "main")).toBe(true);
    expect(pauseKeys()).toEqual(["claude-sub@llm-api"]);
    expect(getPause("claude-sub@llm-api")?.until).not.toBeNull();
    expect(isPaused("claude-sub")).toBe(false);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, DIRECT, expect.any(String));
    expect(orchestrator.routedMainSpec).toBe(DIRECT);
    expect(orchestrator.pausedMainRoutes.get("claude-sub@llm-api")).toEqual({ from: SUB, to: DIRECT });
    expect(pi.sendUserMessage).toHaveBeenCalled();
  });

  it("ignores a route outage off the gateway, or when the direct route is not configured", async () => {
    setCatalog([SUB, DIRECT]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    expect(await handleSubscriptionRouteOutage(orchestrator, ctxOn(DIRECT), DIRECT, "main")).toBe(false);

    const settings = defaultRoutingSettings();
    settings.providers["claude-sub"].route = ["llm-api"];
    vi.mocked(loadRoutingSettings).mockReturnValue(settings);
    expect(await handleSubscriptionRouteOutage(orchestrator, ctxOn(SUB), SUB, "main")).toBe(false);
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
  });

  // Once the probe gets through, the configured main model re-resolves onto
  // the subscription it was moved off.
  it("switches back to the subscription once the probe clears the limit", async () => {
    vi.useFakeTimers();
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainRateLimit(orchestrator, ctxOn(SUB), SUB, "pp-flant-anthropic-sub");
    expect(orchestrator.routedMainSpec).toBe(COPILOT_OPUS);
    vi.mocked(orchestrator.switchModel).mockClear();

    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    orchestrator.lastCtx = idleCtxOn(COPILOT_OPUS);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(isPaused("claude-sub")).toBe(false));

    expect(probeSubscriptionCleared).toHaveBeenCalledWith(SUB);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, SUB, expect.any(String));
    expect(orchestrator.routedMainSpec).toBe(SUB);
    expect(orchestrator.subProbeSpec).toBeNull();
  });

  it("re-arms the probe while the subscription is still limited", async () => {
    vi.useFakeTimers();
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainRateLimit(orchestrator, ctxOn(SUB), SUB, "pp-flant-anthropic-sub");
    vi.mocked(probeSubscriptionCleared).mockClear();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probeSubscriptionCleared).toHaveBeenCalledTimes(1);
    expect(isPaused("claude-sub")).toBe(true);
    expect(orchestrator.subSwitchBackTimer).not.toBeNull();
  });

  // A revoked subscription token is not a quota problem: the fix is to rotate
  // the credential in place, and only a rotation that cannot happen justifies
  // pausing the subscription.
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

  it("rotates a rejected credential and resumes without pausing the subscription", async () => {
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("rotated" as any);
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainAuthFailure(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalled();
    expect(orchestrator.subSwitchBackTimer).toBeNull();
  });

  // A worker that failed minutes ago cannot say which credential was rejected,
  // and by now it may already have been replaced. Rotating on that report would
  // revoke a working token; the recovery path re-checks instead and does
  // nothing when the credential currently works.
  it("resumes without rotating when the credential already works again", async () => {
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("ok" as any);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainAuthFailure(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("pauses the subscription and moves on when a rejected credential cannot be renewed", async () => {
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainAuthFailure(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual(["claude-sub"]);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, COPILOT_OPUS, expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login"), expect.any(String));
  });

  // The startup check has already tried the rotation, and there is no request
  // in flight to resume.
  it("moves off an unusable subscription at startup without queueing a continuation", async () => {
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await demoteUnusableSubscription(orchestrator, ctx, SUB);
    expect(isPaused("claude-sub")).toBe(true);
    expect(orchestrator.switchModel).toHaveBeenCalledWith(ctx, COPILOT_OPUS, expect.any(String));
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(reviveSubscriptionCredential).not.toHaveBeenCalled();
  });

  // A suppressed rotation leaves the SAME rejected credential in place, so an
  // automatic retry would fail identically and spin for as long as the
  // suppression lasts. Pausing would be wrong too: the credential may well be
  // fine, since another rotation just landed. Stop the turn and say so.
  it.each(["throttled", "inconclusive"] as const)("neither retries nor pauses on a %s recovery check", async (outcome) => {
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue(outcome as any);
    setCatalog([SUB, COPILOT_OPUS]);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    const ctx = ctxOn(SUB);
    await handleMainAuthFailure(orchestrator, ctx, SUB, "pp-flant-anthropic-sub");
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not retrying"), "warning");
  });

  it("recovers a worker's rejected credential without touching the main model", async () => {
    vi.mocked(reviveSubscriptionCredential).mockResolvedValue("rotated" as any);
    const pi = makePi();
    const orchestrator = makeOrchestrator(pi);
    orchestrator.switchModel = vi.fn(async () => true);
    await handleSubagentAuthFailure(orchestrator, ctxOn(SUB), "pp-flant-anthropic-sub/sub/claude-fable-5");
    expect(pauseKeys()).toEqual([]);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("ignores a rejected credential on a model the subscription does not route", async () => {
    vi.mocked(reviveSubscriptionCredential).mockClear();
    const orchestrator = makeOrchestrator();
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainAuthFailure(orchestrator, ctxOn("github-copilot/gpt-5.6-sol"), "gpt-5.6-sol", "github-copilot");
    expect(reviveSubscriptionCredential).not.toHaveBeenCalled();
    expect(pauseKeys()).toEqual([]);
  });

  // Switching the model compacts the session, and the host's compaction aborts
  // the run it is called from — so a probe that fires mid-request would kill
  // the very request it restored the subscription for.
  it("parks the switch back until the live request reaches a turn boundary", async () => {
    vi.useFakeTimers();
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainRateLimit(orchestrator, ctxOn(SUB), SUB, "pp-flant-anthropic-sub");
    vi.mocked(orchestrator.switchModel).mockClear();

    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    let idle = false;
    orchestrator.lastCtx = { ...ctxOn(COPILOT_OPUS), isIdle: () => idle };
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.pendingModelSwitches.length).toBe(1));

    // The pause itself is already lifted for the next spawn; only the session waits.
    expect(isPaused("claude-sub")).toBe(false);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();

    // Still parked while the request runs, however long that takes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(orchestrator.switchModel).not.toHaveBeenCalled();

    // A probe landing after the last turn boundary has no turn_end left to
    // drain it, so the backstop poll has to carry out the whole restore.
    idle = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalledWith(orchestrator.lastCtx, SUB, expect.any(String)));
    expect(orchestrator.pendingModelSwitches).toEqual([]);
    expect(orchestrator.routedMainSpec).toBe(SUB);
  });

  // The pause is about the provider, not the session: once the limit clears the
  // provider is routable again even if this session could not be moved back.
  it("lifts the pause even when switching back fails, leaving the session where it is", async () => {
    vi.useFakeTimers();
    setCatalog([SUB, COPILOT_OPUS]);
    const orchestrator = makeOrchestrator();
    orchestrator.routedMainSpec = SUB;
    orchestrator.switchModel = vi.fn(async () => true);
    await handleMainRateLimit(orchestrator, ctxOn(SUB), SUB, "pp-flant-anthropic-sub");
    orchestrator.switchModel = vi.fn(async () => false);

    vi.mocked(probeSubscriptionCleared).mockResolvedValue("ok" as any);
    orchestrator.lastCtx = idleCtxOn(COPILOT_OPUS);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(orchestrator.switchModel).toHaveBeenCalled());

    expect(isPaused("claude-sub")).toBe(false);
    expect(orchestrator.routedMainSpec).toBe(COPILOT_OPUS);
    expect(orchestrator.subSwitchBackTimer).toBeNull();
  });
});
