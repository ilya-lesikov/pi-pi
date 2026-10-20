import type { Orchestrator } from "./orchestrator.js";
import { isClaudeSubInUse, loadRoutingSettings, probeSubscriptionCleared, reviveSubscriptionCredential } from "./flant-infra.js";
import { LLM_API_PROVIDER, clearPauses, describePauseKey, pinnedRoleSpecs, getPause, isPaused, nextPauseMs, pause, pauseKeyForSpec, refusalFallbackSpec, resolveSpec, routeOfConcrete, routePauseKey, splitSpec, unpause, slotRefOfSpec, type Pause } from "./routing.js";
import { isSubscriptionRouted } from "./usage-tracker.js";
import { getLogger } from "./log.js";
import { notice } from "./notices.js";

// `usage limit` and `usage_not_included` are the ChatGPT subscription's own
// wording: pi's openai-codex provider replaces the HTTP status with a friendly
// sentence, so neither the 429 nor the word "rate" survives to be matched.
export function isRateLimitError(message?: string): boolean {
  return typeof message === "string"
    && /\b429\b|rate.?limit|too many requests|exceed your account|extra usage|usage[ _-]?limit|usage_not_included|draw from[\s\S]{0,40}plan limits/i.test(message);
}

/**
 * A credential the provider refused, as opposed to a quota it exhausted. The
 * subscription's OAuth token can be REVOKED server-side (another client
 * rotating the same credential) long before the persisted expiry says so, and
 * that arrives only as this error text.
 */
export function isAuthError(message?: string): boolean {
  return typeof message === "string"
    && /\b401\b|\b403\b|authentication_error|permission_error|has been revoked|invalid[ _-]?(api[ _-]?key|token)|unauthorized/i.test(message);
}

/**
 * The provider refused the content of the request rather than the credential or
 * the quota. Nothing about routing fixes it: the same payload is refused by the
 * next model too, and the offending text is still in the conversation, so a
 * blind retry is refused again.
 */
export function isPolicyBlockError(message?: string): boolean {
  return typeof message === "string"
    && /usage polic|violative|content[ _-]?(policy|filter)|responsible_?ai|flagged by|was blocked under/i.test(message);
}

/**
 * The model declined to answer at all — Anthropic's reasoning-extraction
 * safeguard, which arrives as a successful response carrying a refusal stop
 * reason rather than as an error status.
 *
 * Unlike a usage-policy block this is worth retrying: it judges the whole
 * conversation rather than the last message, and it fires probabilistically, so
 * the same payload sent again often goes through. When it does not, only
 * leaving the vendor clears it.
 */
export function isModelRefusal(rawStopReason?: string, message?: string): boolean {
  if (rawStopReason === "refusal") return true;
  return typeof message === "string"
    && /reverse engineering or duplicating model outputs|reasoning_extraction/i.test(message);
}

function thinking(orchestrator: Orchestrator): string {
  return orchestrator.config.agents.main.thinking;
}

function liveSpec(ctx: any): string {
  return ctx?.model?.provider && ctx?.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
}

function fallbackSettings(orchestrator: Orchestrator): { auto: boolean; retryAfterMinutes: number } {
  try {
    return loadRoutingSettings(orchestrator.cwd).providers.fallback;
  } catch {
    return { auto: true, retryAfterMinutes: 10 };
  }
}

/**
 * How long the provider said to wait, when it said: a Retry-After the adapter
 * folded into its message, or the ChatGPT subscription's own "Try again in ~N
 * min" sentence.
 */
export function retryHintMs(message?: string): number | null {
  if (typeof message !== "string") return null;
  const minutes = /try again in ~?\s*(\d+)\s*min/i.exec(message);
  if (minutes) return Math.max(1, Number(minutes[1])) * 60_000;
  const seconds = /retry[- ]after[:= ]\s*(\d+)\s*s?\b/i.exec(message);
  if (seconds) return Math.max(1, Number(seconds[1])) * 1000;
  return null;
}

function formatUntil(entry: Pause): string {
  if (entry.until === null) return "it recovers";
  const d = new Date(entry.until);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type FallbackCause = "rate-limit" | "auth" | "outage";

/**
 * Take `key` out of routing and move the session off it.
 *
 * The session's configured main model is re-resolved, which now skips the
 * paused provider; a model the user picked by hand is moved to whatever its own
 * slot resolves to. A pinned model or an override has nowhere else to go and
 * waits: the pause carries the time it is retried. The Claude subscription's
 * account pause is lifted by a live probe; every other pause expires on its own,
 * and a limit that has not cleared by then pauses again for twice as long.
 */
async function pauseAndReroute(
  orchestrator: Orchestrator,
  ctx: any,
  key: string,
  spec: string,
  origin: "main" | "subagent",
  cause: FallbackCause,
  hintMs: number | null,
  resumeRequest = true,
): Promise<void> {
  if (isPaused(key)) return;
  const fallback = fallbackSettings(orchestrator);
  const what = describePauseKey(key);
  const trigger = cause === "auth"
    ? `${what}: the credential was rejected and could not be renewed`
    : cause === "outage"
      ? `${what} is failing`
      : `Rate limit on ${what}`;
  if (!fallback.auto) {
    notice(ctx, `${trigger}. Automatic fallback is off (Settings › Providers).`, "warning");
    return;
  }
  const probed = key === "claude-sub";
  const entry = pause(key, probed ? null : nextPauseMs(key, fallback.retryAfterMinutes, hintMs), trigger);
  if (probed) armSwitchBackProbe(orchestrator, spec);
  else armPauseExpiry(orchestrator, entry);
  orchestrator.registerAgents();
  const recovery = cause === "auth" && key.startsWith("claude-sub") ? " Run /login → Anthropic to restore it." : "";

  const live = liveSpec(ctx);
  const mainAffected = origin === "main" || (!!live && isPausedFor(live));
  if (!mainAffected) {
    notice(ctx, `${trigger} on a worker; paused until ${formatUntil(entry)}.${recovery}`, "warning");
    return;
  }
  // Decided when the switch runs, not now: a worker's failure lands mid-request,
  // and by the time the session is between turns another switch may have
  // moved it, or the user may have picked a model of their own.
  await orchestrator.runModelSwitchBetweenTurns(async () => {
    // The handler's own context when it carries the session's model; a parked
    // switch runs later, against whatever context is current then.
    const switchCtx = ctx?.model ? ctx : orchestrator.lastCtx ?? ctx;
    const current = liveSpec(switchCtx) || spec;
    if (!isPausedFor(current)) return;
    // A session pi-pi routed follows its configured model; one the user picked
    // by hand stays theirs, moved only within the same slot.
    const owned = orchestrator.routedMainSpec === current;
    const ref = owned ? orchestrator.config.agents.main.model : slotRefOfSpec(current);
    const next = ref ? resolveSpec(ref) : null;
    if (!next || next === current) {
      notice(switchCtx, `${trigger}; nothing else serves ${current}. Waiting until ${formatUntil(entry)}; the request resumes then.${recovery}`, "warning");
      orchestrator.mainStatus?.pause(`Rate-limited • waiting until ${formatUntil(entry)}`, entry.until ?? undefined);
      if (resumeRequest) orchestrator.pausedMainRoutes.set(key, { from: current, to: current, owned, resume: true, generation: orchestrator.continuationGeneration });
      return;
    }
    try {
      if (!await orchestrator.switchModel(switchCtx, next, thinking(orchestrator))) {
        notice(switchCtx, `${trigger}, but ${next} is unavailable; waiting until ${formatUntil(entry)}.${recovery}`, "error");
        return;
      }
    } catch {
      notice(switchCtx, `${trigger}, but switching to ${next} failed; waiting until ${formatUntil(entry)}.${recovery}`, "error");
      return;
    }
    if (owned) orchestrator.routedMainSpec = next;
    orchestrator.pausedMainRoutes.set(key, { from: current, to: next, owned, resume: false, generation: orchestrator.continuationGeneration });
    const paid = splitSpec(next)?.provider === LLM_API_PROVIDER ? " (paid)" : "";
    notice(switchCtx, `${trigger}; switched to ${next}${paid} until ${formatUntil(entry)}.${recovery}`, "warning");
    if (resumeRequest) orchestrator.queueContinuation("[PI-PI] Provider routing changed after a provider failure. Continue the current request.");
  });
}

/** The pause still covering `spec`, so a waiting request can follow it. */
function routeHolding(spec: string): string | null {
  const key = pauseKeyForSpec(spec);
  if (key && isPaused(key)) return key;
  const route = routeOfConcrete(splitSpec(spec)?.provider ?? "");
  return route && isPaused(routePauseKey(route)) ? routePauseKey(route) : null;
}

/** Whether `spec` is unusable under the current pauses. */
function isPausedFor(spec: string): boolean {
  return routeHolding(spec) !== null;
}

/**
 * When a timed pause runs out, routing is rebuilt so the next spawn sees the
 * provider again, and a main session this pause moved goes back — but only if
 * it is still where the pause put it: anything else is the user's own pick, or
 * another move, and not this timer's to undo.
 */
function armPauseExpiry(orchestrator: Orchestrator, entry: Pause): void {
  const existing = orchestrator.pauseTimers.get(entry.key);
  if (existing) clearTimeout(existing);
  if (entry.until === null) return;
  const timer = setTimeout(async () => {
    orchestrator.pauseTimers.delete(entry.key);
    // By now the pause has lapsed on its own; only a newer one, armed after a
    // fresh limit, means this timer is stale.
    const current = getPause(entry.key);
    if (current && current !== entry) return;
    unpause(entry.key);
    orchestrator.registerAgents();
    await restoreMovedMain(orchestrator, entry.key, "Rate limit window elapsed");
  }, Math.max(1000, entry.until - Date.now()));
  timer.unref?.();
  orchestrator.pauseTimers.set(entry.key, timer);
}

/**
 * Undo the move a pause made, once the pause is lifted — decided when the
 * switch runs: the session must still be where the pause put it (anything else
 * is the user's own pick, or another move), and the model it goes back to must
 * be usable now, not merely when the expiry fired. A session pi-pi routed goes
 * back to whatever its configured model resolves to; one the user picked goes
 * back to that pick, and stays theirs.
 */
async function restoreMovedMain(orchestrator: Orchestrator, key: string, why: string): Promise<boolean> {
  const moved = orchestrator.pausedMainRoutes.get(key);
  if (!moved) return true;
  orchestrator.pausedMainRoutes.delete(key);
  let restored = false;
  await orchestrator.runModelSwitchBetweenTurns(async () => {
    const ctx = orchestrator.lastCtx as any;
    if (liveSpec(ctx) !== moved.to) {
      restored = true;
      return;
    }
    if (moved.resume) {
      // Only the request that stopped, and only once nothing else holds it:
      // the user may have moved on, or another limit may still cover the model.
      if (moved.generation !== orchestrator.continuationGeneration) {
        restored = true;
        return;
      }
      const holder = routeHolding(moved.to);
      if (holder) {
        // The current request's record wins over one a past request left there.
        const existing = orchestrator.pausedMainRoutes.get(holder);
        if (!existing || existing.generation !== orchestrator.continuationGeneration) orchestrator.pausedMainRoutes.set(holder, moved);
        restored = true;
        return;
      }
      restored = true;
      notice(ctx, `${why}; resuming.`, "info");
      orchestrator.queueContinuation("[PI-PI] The provider limit cleared. Continue the current request.");
      return;
    }
    const target = moved.owned ? resolveSpec(orchestrator.config.agents.main.model) : moved.from;
    if (!target || target === moved.to || isPausedFor(target)) {
      restored = true;
      return;
    }
    try {
      if (await orchestrator.switchModel(ctx, target, thinking(orchestrator))) {
        if (moved.owned) orchestrator.routedMainSpec = target;
        notice(ctx, `${why}; switched back to ${target}.`, "info");
      }
      restored = true;
    } catch {}
  });
  return restored;
}

const RESEND_REFUSED = "[PI-PI] The model returned a refusal instead of an answer and produced nothing. It judges the whole conversation, not your last step, and it fires unpredictably on the same content, so the request is worth making again as it was. Carry on exactly where you stopped: do not start over, do not repeat work already finished, and do not quote or reconstruct anything to explain the refusal.";

const CONTINUE_AFTER_REROUTE = "[PI-PI] The refusal repeated, so this session moved to a different vendor's model, which is not subject to it. Everything above is your own work — continue from where you stopped without starting over.";

/**
 * A refusal ends the turn with nothing in it, so something has to drive the
 * session on or the request is simply lost.
 *
 * The first one is resent unchanged: it is probabilistic and usually does not
 * repeat. A second means the conversation itself carries whatever the
 * classifier objects to, and no amount of resending clears that — the session
 * leaves the vendor, and stays away, because the offending content stays in the
 * prompt for as long as the session lives. That is why no switch-back is armed
 * here, unlike the rate-limit moves above.
 */
export async function handleMainRefusal(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const attempt = ++orchestrator.refusalCount;
  getLogger().warn({ s: "refusal", attempt }, "the model refused the request outright");
  if (orchestrator.continuationHalted) return;
  if (attempt === 1) {
    notice(ctx, "The model refused that request outright. Sending it again — this refusal is probabilistic.", "warning");
    orchestrator.queueContinuation(RESEND_REFUSED, true);
    return;
  }

  const mainSpec = liveSpec(ctx);
  const next = refusalFallbackSpec(mainSpec);
  if (!next || next === mainSpec) {
    orchestrator.continuationHalted = true;
    notice(ctx, "The model keeps refusing this conversation and there is nowhere left to move it. Stopping; start a new session, or remove the history it objects to — most often captured model reasoning in a tool result.", "error");
    return;
  }
  let switched = false;
  try {
    switched = await orchestrator.switchModel(ctx, next, thinking(orchestrator));
  } catch {}
  if (!switched) {
    orchestrator.continuationHalted = true;
    notice(ctx, `The model kept refusing this conversation and switching to ${next} failed. Stopping.`, "error");
    return;
  }
  notice(ctx, `Refused again; switched to ${next} for the rest of this session. The content it objected to stays in the conversation, so switching back would be refused too.`, "warning");
  orchestrator.queueContinuation(CONTINUE_AFTER_REROUTE, true);
}

/**
 * Where a rate limit on `spec` lands: the Claude subscription and ChatGPT
 * accounts as a whole, every other provider per model line.
 */
export async function handleMainRateLimit(orchestrator: Orchestrator, ctx: any, spec: string, message?: string): Promise<void> {
  try { ctx.abort?.(); } catch {}
  const key = pauseKeyForSpec(spec);
  if (!key) return;
  await pauseAndReroute(orchestrator, ctx, key, spec, "main", "rate-limit", retryHintMs(message));
}

export async function handleSubagentRateLimit(orchestrator: Orchestrator, ctx: any, modelId?: string, message?: string): Promise<void> {
  if (!modelId) return;
  const key = pauseKeyForSpec(modelId);
  if (!key) return;
  await pauseAndReroute(orchestrator, ctx, key, modelId, "subagent", "rate-limit", retryHintMs(message));
}

/**
 * The subscription's gateway route failing on its own — a 5xx or a refused
 * gateway key — says nothing about the account, so only that route steps aside
 * and the direct one carries on.
 */
export async function handleSubscriptionRouteOutage(orchestrator: Orchestrator, ctx: any, spec: string, origin: "main" | "subagent"): Promise<boolean> {
  const route = routeOfConcrete(splitSpec(spec)?.provider ?? "");
  if (route !== "llm-api") return false;
  const routes = loadRoutingSettings(orchestrator.cwd).providers["claude-sub"].route;
  if (!routes.includes("direct")) return false;
  await pauseAndReroute(orchestrator, ctx, routePauseKey(route), spec, origin, "outage", null, origin === "main");
  return true;
}

// A rejected subscription credential is recoverable in place: rotate it, rebind
// the provider, and resume. Only when no fresh credential can be minted does
// this become a routing problem, handled exactly like a rate limit.
//
// The rotation decision is re-derived from a live probe rather than taken from
// the reported error: by the time a turn ends or a worker settles, the rejected
// credential may already have been replaced, and rotating on a stale report is
// how two instances revoke each other's token.
async function recoverOrDemote(orchestrator: Orchestrator, ctx: any, spec: string, origin: "main" | "subagent"): Promise<void> {
  if (isPaused("claude-sub")) return;
  const outcome = await reviveSubscriptionCredential(spec, orchestrator.pi);
  if (outcome === "failed") {
    await pauseAndReroute(orchestrator, ctx, "claude-sub", spec, origin, "auth", null);
    return;
  }
  // Only an outcome that establishes something justifies resuming, because a
  // resumed turn that fails the same way comes straight back here. "Throttled"
  // means the rejected credential is still the persisted one and a rotation is
  // barred for now; "inconclusive" means the check itself could not reach the
  // gateway. Either way an automatic retry would just spin.
  if (outcome === "throttled" || outcome === "inconclusive") {
    const why = outcome === "throttled"
      ? "was rejected moments after a renewal"
      : "was rejected, and the check that would renew it could not reach the provider";
    notice(ctx, `The subscription credential ${why}; not retrying automatically. Send a message to try again.`, "warning");
    return;
  }
  if (outcome === "rotated") {
    notice(ctx, "The subscription credential was rejected and has been renewed; continuing.", "info");
  }
  if (origin === "main") {
    orchestrator.queueContinuation("[PI-PI] The subscription credential was renewed after a rejected request. Continue the current request.");
  }
}

export async function handleMainAuthFailure(orchestrator: Orchestrator, ctx: any, spec: string): Promise<void> {
  if (!isSubscriptionRouted(spec)) return;
  try { ctx.abort?.(); } catch {}
  await recoverOrDemote(orchestrator, ctx, spec, "main");
}

export async function handleSubagentAuthFailure(orchestrator: Orchestrator, ctx: any, modelId?: string): Promise<void> {
  if (!modelId || !isSubscriptionRouted(modelId)) return;
  await recoverOrDemote(orchestrator, ctx, modelId, "subagent");
}

/**
 * Route off the subscription because its credential is unusable and could not
 * be renewed. For the startup check, which has already attempted the rotation
 * itself and must not send the turn-recovery continuation.
 */
export async function demoteUnusableSubscription(orchestrator: Orchestrator, ctx: any, modelId: string): Promise<void> {
  if (!isSubscriptionRouted(modelId)) return;
  await pauseAndReroute(orchestrator, ctx, "claude-sub", modelId, "main", "auth", null, false);
}

/**
 * The subscription's quota is the account's, so its pause has no expiry a
 * timer could guess: a cheap probe asks the provider directly, at the retry
 * interval, and the pause lifts on the first one that gets through.
 */
export function armSwitchBackProbe(orchestrator: Orchestrator, probeSpec: string): void {
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  orchestrator.subProbeSpec = probeSpec;
  const delay = Math.max(1, fallbackSettings(orchestrator).retryAfterMinutes) * 60_000;
  orchestrator.subSwitchBackTimer = setTimeout(async () => {
    orchestrator.subSwitchBackTimer = null;
    const spec = orchestrator.subProbeSpec;
    if (!isPaused("claude-sub") || !spec) return;
    // Nothing routes onto the subscription any more — an override took the
    // Claude family elsewhere — so its credential is left alone.
    // Its pause is lifted rather than left without a probe to end it: should
    // routing come back to the subscription, it is tried afresh.
    if (!isClaudeSubInUse(loadRoutingSettings(orchestrator.cwd), pinnedRoleSpecs(orchestrator.config))) {
      orchestrator.subProbeSpec = null;
      unpause("claude-sub");
      orchestrator.pausedMainRoutes.delete("claude-sub");
      orchestrator.registerAgents();
      return;
    }
    const outcome = await probeSubscriptionCleared(spec);
    // Shutdown or a manual clear may have lifted the pause while the probe was in flight.
    if (!isPaused("claude-sub")) return;
    if (outcome !== "ok") {
      armSwitchBackProbe(orchestrator, spec);
      return;
    }
    unpause("claude-sub");
    orchestrator.subProbeSpec = null;
    orchestrator.registerAgents();
    if (!await restoreMovedMain(orchestrator, "claude-sub", "Subscription limit cleared")) {
      getLogger().warn({ s: "routing" }, "the subscription cleared but switching the session back failed");
    }
    notice(orchestrator.lastCtx, "Claude subscription limit cleared; routing through it again.", "info");
  }, delay);
  orchestrator.subSwitchBackTimer.unref?.();
}

/** Lift every pause and stop their timers. */
export function clearAllPauses(orchestrator: Orchestrator): string[] {
  for (const timer of orchestrator.pauseTimers.values()) clearTimeout(timer);
  orchestrator.pauseTimers.clear();
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  orchestrator.subSwitchBackTimer = null;
  orchestrator.subProbeSpec = null;
  orchestrator.pausedMainRoutes.clear();
  return clearPauses();
}
