import type { Orchestrator } from "./orchestrator.js";
import { loadFlantSettings, probeSubscriptionCleared } from "./flant-infra.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive } from "./model-registry.js";
import { isSubscriptionRouted } from "./usage-tracker.js";

export function isRateLimitError(message?: string): boolean {
  return typeof message === "string" && /\b429\b|rate.?limit|too many requests|exceed your account|extra usage|draw from[\s\S]{0,40}plan limits/i.test(message);
}

function thinking(orchestrator: Orchestrator): string {
  return orchestrator.config.agents.main.thinking;
}

// The paid gateway no longer serves Claude, so a sub rate limit cannot fall
// back to flant-api. The only fallback tier for Claude is Copilot (when the
// user enabled it). Without one, wait for the switch-back probe to detect the
// cleared limit rather than routing onto a dead provider.
async function activate(orchestrator: Orchestrator, ctx: any, modelId: string, origin: "main" | "subagent"): Promise<void> {
  if (orchestrator.subFallbackActive) return;
  const settings = loadFlantSettings(orchestrator.cwd);
  if (!settings.autoRateLimitFallback) {
    ctx.ui?.notify?.("The personal subscription is rate-limited. Automatic fallback is disabled in .pp/config.json.", "warning");
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

  if (!switchMain || !hasFallbackTier) {
    orchestrator.subFallbackMainPriorSpec = null;
    armSwitchBackProbe(orchestrator);
    if (switchMain) {
      ctx.ui?.notify?.("Subscription rate limit detected. Claude has no paid-gateway fallback anymore; waiting for the limit to clear (periodic probe armed). Enable the Copilot tier for an automatic fallback, or /model to a non-Claude model to keep working.", "warning");
    } else {
      ctx.ui?.notify?.("A subscription-routed worker hit a rate limit; subscription routing is paused until the limit clears.", "warning");
    }
    return;
  }

  try {
    if (!await orchestrator.switchModel(ctx, next, thinking(orchestrator))) {
      orchestrator.subFallbackMainPriorSpec = null;
      armSwitchBackProbe(orchestrator);
      ctx.ui?.notify?.("Subscription rate limit detected, but the fallback model is unavailable. Waiting for the limit to clear.", "error");
      return;
    }
  } catch {
    orchestrator.subFallbackMainPriorSpec = null;
    armSwitchBackProbe(orchestrator);
    ctx.ui?.notify?.("Subscription rate limit detected, but switching to the fallback model failed. Waiting for the limit to clear.", "error");
    return;
  }
  orchestrator.subFallbackMainPriorSpec = mainSpec || modelId;
  ctx.ui?.notify?.(`Subscription rate limit detected; switched to ${next} and will switch back after the limit clears.`, "warning");
  armSwitchBackProbe(orchestrator);
  orchestrator.queueContinuation("[PI-PI] Provider routing changed after a subscription rate limit. Continue the current request.");
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

export function armSwitchBackProbe(orchestrator: Orchestrator): void {
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  const delay = Math.max(1, loadFlantSettings(orchestrator.cwd).switchBackIntervalMinutes) * 60_000;
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
    const ctx = orchestrator.lastCtx;
    const prior = orchestrator.subFallbackMainPriorSpec;
    if (prior) {
      // Restore BEFORE tearing down fallback state so a failed switch keeps the
      // prior spec and the probe re-arms instead of stranding the session on
      // the fallback tier while reporting success.
      let restored = false;
      try {
        restored = await orchestrator.switchModel(ctx, resolveModel(prior), thinking(orchestrator));
      } catch {}
      if (!restored) {
        armSwitchBackProbe(orchestrator);
        ctx?.ui?.notify?.(`Subscription limit cleared, but switching back to ${prior} failed; will retry.`, "warning");
        return;
      }
    }
    setSubscriptionFallbackActive(false);
    orchestrator.subFallbackActive = false;
    orchestrator.subFallbackMainPriorSpec = null;
    orchestrator.subFallbackModelId = null;
    ctx?.ui?.notify?.("Subscription limit cleared; switched back to personal subscription routing.", "info");
  }, delay);
  orchestrator.subSwitchBackTimer.unref?.();
}
