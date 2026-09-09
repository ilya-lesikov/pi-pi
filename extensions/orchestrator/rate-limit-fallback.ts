import type { Orchestrator } from "./orchestrator.js";
import { loadFlantSettings, probeSubscriptionCleared, reviveSubscriptionCredential } from "./flant-infra.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive } from "./model-registry.js";
import { isSubscriptionRouted } from "./usage-tracker.js";

export function isRateLimitError(message?: string): boolean {
  return typeof message === "string" && /\b429\b|rate.?limit|too many requests|exceed your account|extra usage|draw from[\s\S]{0,40}plan limits/i.test(message);
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

function thinking(orchestrator: Orchestrator): string {
  return orchestrator.config.agents.main.thinking;
}

type FallbackCause = "rate-limit" | "auth";

// The paid gateway no longer serves Claude, so a sub rate limit cannot fall
// back to flant-api. The only fallback tier for Claude is Copilot (when the
// user enabled it). Without one, wait for the switch-back probe to detect the
// cleared limit rather than routing onto a dead provider.
async function activate(
  orchestrator: Orchestrator,
  ctx: any,
  modelId: string,
  origin: "main" | "subagent",
  cause: FallbackCause = "rate-limit",
  resumeRequest = true,
): Promise<void> {
  if (orchestrator.subFallbackActive) return;
  const settings = loadFlantSettings(orchestrator.cwd);
  const trigger = cause === "auth"
    ? "The personal subscription credential was rejected and could not be renewed"
    : "Subscription rate limit detected";
  if (!settings.autoRateLimitFallback) {
    ctx.ui?.notify?.(`${trigger}. Automatic fallback is disabled in .pp/config.json.`, "warning");
    return;
  }
  const mainSpec = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const sameFamily = getModelInfo(modelId).family === getModelInfo(mainSpec).family;
  const switchMain = origin === "main" || (isSubscriptionRouted(mainSpec, ctx.model?.provider) && sameFamily);

  orchestrator.subFallbackActive = true;
  orchestrator.subFallbackModelId = modelId;
  setSubscriptionFallbackActive(true);

  const originSpec = origin === "main" ? modelId : mainSpec;
  const next = resolveModel(originSpec);
  const hasFallbackTier = next !== originSpec && !isSubscriptionRouted(next);

  const recovery = cause === "auth"
    ? " Run /login \u2192 Anthropic to restore subscription routing."
    : "";

  if (!switchMain || !hasFallbackTier) {
    orchestrator.subFallbackMainPriorSpec = null;
    armSwitchBackProbe(orchestrator);
    if (switchMain) {
      ctx.ui?.notify?.(`${trigger}. Claude has no paid-gateway fallback anymore; waiting for it to clear (periodic probe armed). Enable the Copilot tier for an automatic fallback, or /model to a non-Claude model to keep working.${recovery}`, "warning");
    } else {
      ctx.ui?.notify?.(`${trigger} on a worker; subscription routing is paused until it clears.${recovery}`, "warning");
    }
    return;
  }

  try {
    if (!await orchestrator.switchModel(ctx, next, thinking(orchestrator))) {
      orchestrator.subFallbackMainPriorSpec = null;
      armSwitchBackProbe(orchestrator);
      ctx.ui?.notify?.(`${trigger}, but the fallback model is unavailable. Waiting for it to clear.${recovery}`, "error");
      return;
    }
  } catch {
    orchestrator.subFallbackMainPriorSpec = null;
    armSwitchBackProbe(orchestrator);
    ctx.ui?.notify?.(`${trigger}, but switching to the fallback model failed. Waiting for it to clear.${recovery}`, "error");
    return;
  }
  orchestrator.subFallbackMainPriorSpec = mainSpec || modelId;
  ctx.ui?.notify?.(`${trigger}; switched to ${next} and will switch back once the subscription works again.${recovery}`, "warning");
  armSwitchBackProbe(orchestrator);
  if (resumeRequest) orchestrator.queueContinuation("[PI-PI] Provider routing changed after a subscription failure. Continue the current request.");
}

export async function handleMainRateLimit(orchestrator: Orchestrator, ctx: any, modelId?: string, provider?: string): Promise<void> {
  const spec = modelId?.includes("/") ? modelId : provider && modelId ? `${provider}/${modelId}` : modelId ?? "";
  if (!isSubscriptionRouted(spec, provider)) return;
  try { ctx.abort?.(); } catch {}
  await activate(orchestrator, ctx, spec, "main");
}

export async function handleSubagentRateLimit(orchestrator: Orchestrator, ctx: any, modelId?: string): Promise<void> {
  if (!modelId || !isSubscriptionRouted(modelId)) return;
  await activate(orchestrator, ctx, modelId, "subagent");
}

// A rejected subscription credential is recoverable in place: rotate it, rebind
// the provider, and resume. Only when no fresh credential can be minted does
// this become a routing problem, handled exactly like a rate limit (fall to a
// lower tier and let the probe decide when the subscription works again).
//
// The rotation decision is re-derived from a live probe rather than taken from
// the reported error: by the time a turn ends or a worker settles, the rejected
// credential may already have been replaced, and rotating on a stale report is
// how two instances revoke each other's token.
async function recoverOrDemote(orchestrator: Orchestrator, ctx: any, spec: string, origin: "main" | "subagent"): Promise<void> {
  if (orchestrator.subFallbackActive) return;
  const outcome = await reviveSubscriptionCredential(spec, orchestrator.pi);
  if (outcome === "failed") {
    await activate(orchestrator, ctx, spec, origin, "auth");
    return;
  }
  // Only an outcome that establishes something justifies resuming, because a
  // resumed turn that fails the same way comes straight back here. "Throttled"
  // means the rejected credential is still the persisted one and a rotation is
  // barred for now; "inconclusive" means the check itself could not reach the
  // gateway. Either way an automatic retry would just spin. Stop the turn and
  // let the next request try again.
  if (outcome === "throttled" || outcome === "inconclusive") {
    const why = outcome === "throttled"
      ? "was rejected moments after a renewal"
      : "was rejected, and the check that would renew it could not reach the gateway";
    ctx?.ui?.notify?.(`The subscription credential ${why}; not retrying automatically. Send a message to try again.`, "warning");
    return;
  }
  if (outcome === "rotated") {
    ctx?.ui?.notify?.("The subscription credential was rejected and has been renewed; continuing.", "info");
  }
  if (origin === "main") {
    orchestrator.queueContinuation("[PI-PI] The subscription credential was renewed after a rejected request. Continue the current request.");
  }
}

export async function handleMainAuthFailure(orchestrator: Orchestrator, ctx: any, modelId?: string, provider?: string): Promise<void> {
  const spec = modelId?.includes("/") ? modelId : provider && modelId ? `${provider}/${modelId}` : modelId ?? "";
  if (!isSubscriptionRouted(spec, provider)) return;
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
  await activate(orchestrator, ctx, modelId, "main", "auth", false);
}

export function armSwitchBackProbe(orchestrator: Orchestrator): void {
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  // The probe re-arms itself from inside its own callback, so an unreadable
  // config here would strand the session on the fallback tier for good.
  let minutes = 10;
  try { minutes = loadFlantSettings(orchestrator.cwd).switchBackIntervalMinutes; } catch {}
  const delay = Math.max(1, minutes) * 60_000;
  orchestrator.subSwitchBackTimer = setTimeout(async () => {
    orchestrator.subSwitchBackTimer = null;
    if (!orchestrator.subFallbackActive || !orchestrator.subFallbackModelId) return;
    const outcome = await probeSubscriptionCleared(orchestrator.subFallbackModelId);
    // Shutdown may have cleared the fallback while the probe was in flight.
    if (!orchestrator.subFallbackActive) return;
    if (outcome !== "ok") {
      armSwitchBackProbe(orchestrator);
      return;
    }
    // The probe fires on wall-clock time, so it lands as readily inside a live
    // request as between two; the restore below switches the model, which
    // compacts, which aborts whatever run it interrupted.
    await orchestrator.runModelSwitchBetweenTurns(async () => {
      if (!orchestrator.subFallbackActive) return;
      const ctx = orchestrator.lastCtx;
      const prior = orchestrator.subFallbackMainPriorSpec;
      // The prior spec is subscription-born, so the fallback flag has to come off
      // before it is resolved: while the flag is set the flant-sub tier is
      // disabled and the spec walks straight back down onto the fallback tier.
      setSubscriptionFallbackActive(false);
      if (prior) {
        // Restore BEFORE tearing down the rest of the fallback state so a failed
        // switch keeps the prior spec and the probe re-arms instead of stranding
        // the session on the fallback tier while reporting success.
        let restored = false;
        try {
          restored = await orchestrator.switchModel(ctx, resolveModel(prior), thinking(orchestrator));
        } catch {}
        if (!restored) {
          setSubscriptionFallbackActive(true);
          armSwitchBackProbe(orchestrator);
          ctx?.ui?.notify?.(`Subscription limit cleared, but switching back to ${prior} failed; will retry.`, "warning");
          return;
        }
      }
      orchestrator.subFallbackActive = false;
      orchestrator.subFallbackMainPriorSpec = null;
      orchestrator.subFallbackModelId = null;
      ctx?.ui?.notify?.("Subscription limit cleared; switched back to personal subscription routing.", "info");
    });
  }, delay);
  orchestrator.subSwitchBackTimer.unref?.();
}
