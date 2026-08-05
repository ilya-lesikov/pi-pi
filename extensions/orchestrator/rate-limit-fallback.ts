import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";
import { isSubscriptionRouted } from "./usage-tracker.js";
import { setSubscriptionFallbackActive, toNonSubSpec, demoteTierForFamily, getModelInfo, resolveModel, type ProviderTierName } from "./model-registry.js";
import { loadFlantSettings, probeSubscriptionCleared } from "./flant-infra.js";
import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";

// Recognise a rate-limit / 429 error from a turn's or subagent's error message.
export function isRateLimitError(message?: string): boolean {
  if (typeof message !== "string") return false;
  return /\b429\b|rate.?limit|too many requests|exceed your account/i.test(message);
}

// Recognise the subscription-routing-specific 400 "extra usage" error, e.g.
// "Third-party apps now draw from extra usage, not plan limits". This is a
// DISTINCT failure class from 429 (not retryable, not a plan rate-limit) but is
// funneled into the SAME sub→non-sub fallback. Kept separate from
// isRateLimitError so the 429 regex stays clean. Anchored on the specific
// phrasing to avoid over-matching other 400s; the CALLER additionally requires
// isSubscriptionRouted.
export function isExtraUsageError(message?: string): boolean {
  if (typeof message !== "string" || !message) return false;
  return /extra usage|draw from[\s\S]{0,40}plan limits/i.test(message);
}

// Recognise the OpenRouter/LiteLLM MONTHLY-CAP 403, e.g.
// "litellm.APIError ... Key limit exceeded (monthly limit)". This is an
// account-level cap, NOT a transient rate-limit: retrying is futile, so it must
// trigger a provider-tier FALLBACK rather than the backoff retry. Anchored on
// the specific phrasing to avoid over-matching generic 403s.
export function isMonthlyCapError(message?: string): boolean {
  if (typeof message !== "string" || !message) return false;
  return /key limit exceeded[\s\S]{0,40}monthly limit|monthly limit[\s\S]{0,40}exceeded/i.test(message);
}

export function isMalformedToolHistoryError(message?: string): boolean {
  if (typeof message !== "string" || !message) return false;
  return /unexpected tool_use_id found in tool_result|tool_result blocks?[\s\S]{0,120}corresponding tool_use/i.test(message);
}

// Mirror of the SDK's AgentSession._isRetryableError classifier
// (agent-session.js: overloaded/rate-limit/5xx/network/stream-ended/timeout/...).
// When true, the SDK auto-retries the SAME turn itself (abortable backoff bound
// to ESC, visible countdown). pi-pi must NOT ALSO schedule its own post-error
// retry for these: a second, independent retry races the SDK's continue() and
// reproduces "Agent is already processing", and re-nudges a futile sub-429. This
// list is kept in sync with the SDK regex; if they drift, pi-pi at worst falls
// back to its own idle-gated retry (still safe, just not unified).
export function isSdkRetryableError(message?: string): boolean {
  if (typeof message !== "string" || !message) return false;
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
    message,
  );
}

const SWITCH_DIALOG_CONTEXT =
  "Switching between the personal subscription and regular flant Claude changes the provider/endpoint, " +
  "so the prompt cache is LOST and the full conversation context is re-sent on the next call. " +
  "Regular (non-subscription) flant Claude is billed PER TOKEN (paid).";

// Handle a subscription-routed 429 on the MAIN turn. Stops futile retries on the
// still-limited sub model, then (once, session-sticky) asks the user whether to
// fall back to non-sub Claude. On confirm: activates the session-scoped override,
// switches the active model, arms the switch-back probe, and nudges to continue.
export async function handleMainRateLimit(
  orchestrator: Orchestrator,
  ctx: any,
  modelId: string | undefined,
  provider: string | undefined,
): Promise<void> {
  const log = getLogger();
  if (!isSubscriptionRouted(modelId, provider)) return;

  // Stop the futile same-model retry (SDK backoff + pi-pi's own timer): retrying
  // the sub model against an account-level limit cannot succeed.
  ctx?.abort?.();
  orchestrator.cancelPendingRetry();

  if (orchestrator.subFallbackActive) return; // sticky — already on non-sub
  await offerFallback(orchestrator, ctx, modelId ?? orchestrator.subFallbackModelId ?? "", "main");
}

// Handle a subscription-routed 429 reported via subagents:failed. Uses ONE
// global dialogue (never per-subagent) — the same offerFallback path as the
// main turn, guarded so only one dialogue is open at a time.
export async function handleSubagentRateLimit(
  orchestrator: Orchestrator,
  ctx: any,
  modelId: string | undefined,
): Promise<void> {
  if (!isSubscriptionRouted(modelId)) return;
  if (orchestrator.subFallbackActive) return; // sticky
  await offerFallback(orchestrator, ctx, modelId ?? "", "subagent");
}

async function offerFallback(
  orchestrator: Orchestrator,
  ctx: any,
  subModelId: string,
  origin: "main" | "subagent",
): Promise<void> {
  const log = getLogger();
  // subFallbackPendingDecision is set SYNCHRONOUSLY at the dispatch site (the
  // subagents:failed / main turn_end handler) to suppress autonomous
  // planner/reviewer auto-retry until this dispatch RESOLVES the decision. Most
  // exit paths (the auto branch and the !hasUI early return below) resolve it
  // here, since the dialogue's finally would never run for them.
  //
  // EXCEPTION: when a dialogue is ALREADY open (a concurrent second sub-429
  // dispatch), we must NOT clear the flag — the open dialogue's finally still
  // owns the clear and runs after this concurrent dispatch. Clearing it here
  // (synchronously, before this handler's trailing completion checks) would
  // briefly drop the suppression and let the autonomous failed-variant
  // auto-retry respawn on the STILL-sub-routed model, re-hitting the limit and
  // burning its once-only retry budget. Just return.
  if (orchestrator.subFallbackDialogPending) return;
  // Automatic mode (default): skip the permission dialogue and switch straight
  // to the next tier, surfacing a non-blocking notification instead. Checked
  // BEFORE the hasUI guard so a headless autonomous run still auto-switches.
  if (loadFlantSettings(orchestrator.cwd).autoRateLimitFallback) {
    try {
      await activateFallback(orchestrator, ctx, subModelId, origin);
    } finally {
      orchestrator.subFallbackPendingDecision = false;
    }
    return;
  }
  if (!ctx?.hasUI) {
    // No UI to ask (and auto mode off) — leave sub routing in place; the error
    // is surfaced elsewhere.
    orchestrator.subFallbackPendingDecision = false;
    log.debug({ s: "ratelimit" }, "no UI available to offer subscription fallback");
    return;
  }

  orchestrator.subFallbackDialogPending = true;
  const taskToken = orchestrator.activeTaskToken;
  try {
    const result = await askUser(ctx, {
      question: "Personal Claude subscription is rate-limited. Switch to regular (paid) flant Claude?",
      context: SWITCH_DIALOG_CONTEXT,
      options: [
        { title: "Switch to non-sub Claude", description: "Continue on regular flant Claude (paid per token) until you switch back." },
        { title: "Stay on subscription", description: "Do not switch. Work stays paused until the limit clears." },
      ],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active) return;
    const chose = result && !isCancel(result) && result.kind === "selection" ? result.selections[0] : undefined;
    if (chose !== "Switch to non-sub Claude") {
      ctx.ui?.notify?.("Staying on subscription. Auto-continuation paused until you resume or the limit clears.", "info");
      return;
    }
    await activateFallback(orchestrator, ctx, subModelId, origin);
  } finally {
    orchestrator.subFallbackDialogPending = false;
    orchestrator.subFallbackPendingDecision = false;
  }
}

async function activateFallback(
  orchestrator: Orchestrator,
  ctx: any,
  subModelId: string,
  origin: "main" | "subagent",
): Promise<void> {
  const log = getLogger();
  orchestrator.subFallbackActive = true;
  orchestrator.subFallbackModelId = subModelId || orchestrator.subFallbackModelId;
  // Activate the session-scoped override so EVERY future model resolution
  // (phase switches, new subagents, planner/reviewer specs) rewrites sub→non-sub.
  // This is what actually re-routes future subagent spawns, regardless of origin.
  setSubscriptionFallbackActive(true);

  // Switch the CURRENT main model to the non-sub equivalent when the failing
  // model belongs to the main session. That's ALWAYS true for a main-origin
  // limit; for a SUBAGENT-origin limit it's true only when the main model is on
  // the SAME subscription-routed family that got limited (per the plan: a
  // sub-Claude subagent limit switches a sub-Claude main; a subagent gpt limit
  // leaves a Claude main alone). The session override above re-routes future
  // subagent spawns regardless.
  const mainSpec = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const mainIsSubRouted = isSubscriptionRouted(mainSpec, ctx?.model?.provider);
  const sameFamily =
    !!subModelId && getModelInfo(subModelId).family === getModelInfo(mainSpec).family;
  const switchMain = subModelId && (origin === "main" || (mainIsSubRouted && sameFamily));
  // Record whether/what we actually change on the MAIN model, so the delayed
  // switch-back reverts the main model ONLY when this fallback moved it (and
  // restores exactly its prior spec). A subagent-origin limit that leaves the
  // main model alone must leave subFallbackMainPriorSpec null.
  orchestrator.subFallbackMainPriorSpec = null;
  if (switchMain) {
    const nonSub = toNonSubSpec(origin === "main" ? subModelId : mainSpec);
    const ok = await orchestrator.switchModel(ctx, nonSub, currentThinking(orchestrator));
    if (ok) {
      // Only claim a restore obligation when the switch SUCCEEDED (a failed
      // switch must not create false restore state).
      orchestrator.subFallbackMainPriorSpec = mainSpec || subModelId;
    } else {
      log.warn({ s: "ratelimit", nonSub }, "failed to switch main model to non-sub");
    }
  }

  ctx.ui?.notify?.("Switched to regular flant Claude (paid per token). Will periodically check if the subscription limit has cleared.", "info");

  armSwitchBackProbe(orchestrator);

  // Nudge to continue — retries were cancelled, so the turn is stopped. Idle-gated
  // (same guard as the post-error nudge) so it never races the SDK into an
  // "Agent is already processing" error.
  const phase = orchestrator.active?.state.phase ?? "current";
  orchestrator.sendUserMessageWhenIdle(
    `[PI-PI] Switched to regular (non-subscription) flant Claude after a rate limit. Continue working on the current phase (${phase}).`,
    orchestrator.activeTaskToken,
  );
}

// Determine which provider tier a model spec currently routes through, for
// per-family demotion on a non-transient cap.
function tierOfModelSpec(spec: string | undefined, provider: string | undefined): ProviderTierName | null {
  const s = spec ?? "";
  if (provider === "github-copilot" || s.startsWith("github-copilot/")) return "copilot";
  if (isSubscriptionRouted(s, provider)) return "flant-sub";
  if (s.startsWith("pp-flant-anthropic/") || s.startsWith("pp-flant-openai/")) return "flant-api";
  return null;
}

// Build a canonical provider-prefixed spec from a turn_end error's SEPARATE
// `model` (bare id, e.g. `claude-opus-4-8`) and `provider` (e.g.
// `pp-flant-anthropic`) fields, so model-registry classifiers (which require a
// provider prefix) can resolve the family. Already-prefixed specs pass through.
function canonicalSpec(modelId: string | undefined, provider: string | undefined): string {
  const id = modelId ?? "";
  if (!id) return "";
  if (id.includes("/")) return id;
  if (provider) return `${provider}/${id}`;
  return id.startsWith("claude-") ? `pp-flant-anthropic/${id}` : `pp-flant-openai/${id}`;
}

// Handle a non-transient MONTHLY-CAP 403 (OpenRouter/LiteLLM "Key limit exceeded
// (monthly limit)"). Retrying is futile; demote the failing model's CURRENT
// tier for its family so the resolver drops future resolutions to the next
// enabled tier, then nudge to continue. Notifies (no dialogue) since this is
// never a transient blip.
export function handleMonthlyCap(
  orchestrator: Orchestrator,
  ctx: any,
  modelId: string | undefined,
  provider: string | undefined,
): void {
  const log = getLogger();
  ctx?.abort?.();
  orchestrator.cancelPendingRetry();
  const canonical = canonicalSpec(modelId, provider);
  const tier = tierOfModelSpec(canonical, provider);
  const family = getModelInfo(canonical).family;
  if (!tier || family === "unknown") {
    log.warn({ s: "ratelimit", modelId, provider, canonical }, "monthly cap on an unclassifiable model; cannot demote tier");
    ctx?.ui?.notify?.("A monthly usage cap was hit but the model's provider tier could not be identified; auto-continuation paused.", "warning");
    return;
  }
  demoteTierForFamily(tier, family);
  log.debug({ s: "ratelimit", tier, family }, "monthly cap: demoted tier for family");

  // Switch the LIVE main model to whatever the resolver now yields for this
  // model after the demotion. If the resolver can't move it off the capped tier
  // (already the floor tier, or no lower tier serves the family), there is no
  // usable fallback: surface a clear terminal message and do NOT nudge (nudging
  // would just re-hit the cap in an endless notify/nudge loop).
  const nextSpec = resolveModel(canonical);
  const stillCapped = tierOfModelSpec(nextSpec, undefined) === tier;
  if (stillCapped) {
    log.warn({ s: "ratelimit", tier, family, nextSpec }, "monthly cap: no lower provider tier available");
    ctx?.ui?.notify?.(`Monthly usage cap hit on the ${tier} tier for ${family}, and no lower provider tier is available. Enable another tier (Settings > Copilot/Flant) to continue.`, "error");
    return;
  }
  void orchestrator.switchModel(ctx, nextSpec, currentThinking(orchestrator)).then((ok) => {
    if (!ok) log.warn({ s: "ratelimit", nextSpec }, "failed to switch main model after monthly cap");
  });
  ctx?.ui?.notify?.(`Monthly usage cap hit on the ${tier} tier for ${family}; switched to the next provider tier.`, "info");
  const phase = orchestrator.active?.state.phase ?? "current";
  orchestrator.sendUserMessageWhenIdle(
    `[PI-PI] Hit a monthly usage cap on the ${tier} provider tier; switched to the next tier. Continue working on the current phase (${phase}).`,
    orchestrator.activeTaskToken,
  );
}

function currentThinking(orchestrator: Orchestrator): string {
  const phase = orchestrator.active?.state.phase;
  const orchestrators = orchestrator.config?.agents?.orchestrators as Record<string, { thinking?: string }> | undefined;
  const key = phase === "brainstorm" || phase === "review" || phase === "quick" ? phase : "implement";
  return orchestrators?.[key]?.thinking ?? "high";
}

// Arm the fixed-interval switch-back probe. On each interval an out-of-band probe
// checks whether the sub limit cleared; a 429/failure silently re-arms, a success
// opens the switch-back dialogue. Only one timer runs at a time.
export function armSwitchBackProbe(orchestrator: Orchestrator): void {
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  const minutes = Math.max(1, loadFlantSettings(orchestrator.cwd).switchBackIntervalMinutes || 10);
  const taskToken = orchestrator.activeTaskToken;
  orchestrator.subSwitchBackTimer = setTimeout(() => {
    orchestrator.subSwitchBackTimer = null;
    void runSwitchBackProbe(orchestrator, taskToken);
  }, minutes * 60 * 1000);
}

async function runSwitchBackProbe(orchestrator: Orchestrator, taskToken: number): Promise<void> {
  const log = getLogger();
  // A tick that lands while no task is active (between tasks, or during a phase
  // transition that bumps activeTaskToken) must RE-ARM rather than return: the
  // fallback is still active and the subscription still needs watching, so
  // bailing here used to kill the probe for the rest of the session and strand
  // the session on paid non-sub Claude forever. Only a cleared fallback (whose
  // teardown cancels the timer) legitimately stops the loop.
  if (!orchestrator.subFallbackActive) return;
  if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active) {
    armSwitchBackProbe(orchestrator);
    return;
  }
  const modelId = orchestrator.subFallbackModelId;
  if (!modelId) {
    armSwitchBackProbe(orchestrator);
    return;
  }
  const outcome = await probeSubscriptionCleared(modelId);
  if (!orchestrator.subFallbackActive) return;
  if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active) {
    armSwitchBackProbe(orchestrator);
    return;
  }
  if (outcome !== "ok") {
    // Still limited (or transient error) — stay on non-sub, silently re-arm.
    log.debug({ s: "ratelimit", outcome }, "switch-back probe: not cleared, re-arming");
    armSwitchBackProbe(orchestrator);
    return;
  }
  await offerSwitchBack(orchestrator, modelId);
}

async function offerSwitchBack(orchestrator: Orchestrator, subModelId: string): Promise<void> {
  const log = getLogger();
  const ctx = orchestrator.lastCtx;
  // Automatic mode (default): switch back with NO dialogue in either direction,
  // surfacing a non-blocking notification. Mirrors offerFallback's auto path.
  // A missing UI does NOT block auto switch-back (headless autonomous runs still
  // switch back); notifications are best-effort.
  if (loadFlantSettings(orchestrator.cwd).autoRateLimitFallback) {
    await switchBackToSub(orchestrator, ctx, subModelId);
    return;
  }
  if (orchestrator.subFallbackDialogPending || !ctx?.hasUI) {
    armSwitchBackProbe(orchestrator);
    return;
  }
  orchestrator.subFallbackDialogPending = true;
  const taskToken = orchestrator.activeTaskToken;
  try {
    const result = await askUser(ctx, {
      question: "Your Claude subscription limit appears to have cleared. Switch back to the subscription?",
      context: SWITCH_DIALOG_CONTEXT,
      options: [
        { title: "Switch back to subscription", description: "Resume on the personal Claude subscription (flat-rate)." },
        { title: "Stay on non-sub Claude", description: "Keep using regular flant Claude; check again later." },
      ],
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active) return;
    const chose = result && !isCancel(result) && result.kind === "selection" ? result.selections[0] : undefined;
    if (chose !== "Switch back to subscription") {
      // Stay on non-sub; re-arm so we check again after the interval.
      armSwitchBackProbe(orchestrator);
      return;
    }
    await switchBackToSub(orchestrator, ctx, subModelId);
  } finally {
    orchestrator.subFallbackDialogPending = false;
  }
}

async function switchBackToSub(orchestrator: Orchestrator, ctx: any, subModelId: string): Promise<void> {
  const log = getLogger();
  // Clear the override FIRST so switchModel resolves the sub spec unrewritten.
  // This ALWAYS happens (regardless of origin) so future main/subagent spawns
  // resolve back to the subscription.
  orchestrator.subFallbackActive = false;
  setSubscriptionFallbackActive(false);
  if (orchestrator.subSwitchBackTimer) {
    clearTimeout(orchestrator.subSwitchBackTimer);
    orchestrator.subSwitchBackTimer = null;
  }
  // Revert the LIVE MAIN model ONLY when this fallback actually switched it. A
  // subagent-origin fallback that left the main model alone (prior spec null)
  // must NOT mutate the main model here — the old code unconditionally switched
  // the main model to the subagent's sub model.
  const priorSpec = orchestrator.subFallbackMainPriorSpec;
  if (priorSpec) {
    // Restore the main model's OWN prior (sub-routed) spec, captured at fallback
    // time — which may differ from the subagent's failing `subModelId`.
    const ok = await orchestrator.switchModel(ctx, priorSpec, currentThinking(orchestrator));
    if (!ok) log.warn({ s: "ratelimit", priorSpec }, "failed to switch back main model to sub");
  }
  orchestrator.subFallbackMainPriorSpec = null;
  orchestrator.subFallbackModelId = null;
  ctx.ui?.notify?.("Switched back to the personal Claude subscription.", "info");
  const phase = orchestrator.active?.state.phase ?? "current";
  orchestrator.sendUserMessageWhenIdle(
    `[PI-PI] Switched back to the personal Claude subscription. Continue working on the current phase (${phase}).`,
    orchestrator.activeTaskToken,
  );
}
