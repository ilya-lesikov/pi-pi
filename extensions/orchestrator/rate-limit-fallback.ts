import type { Orchestrator } from "./orchestrator.js";
import { loadFlantSettings, probeSubscriptionCleared } from "./flant-infra.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive, toNonSubSpec } from "./model-registry.js";
import { isSubscriptionRouted } from "./usage-tracker.js";

export function isRateLimitError(message?: string): boolean {
  return typeof message === "string" && /\b429\b|rate.?limit|too many requests|exceed your account|extra usage|draw from[\s\S]{0,40}plan limits/i.test(message);
}

function thinking(orchestrator: Orchestrator): string {
  return orchestrator.config.agents.main.thinking;
}

async function activate(orchestrator: Orchestrator, ctx: any, modelId: string, origin: "main" | "subagent"): Promise<void> {
  if (orchestrator.subFallbackActive) return;
  const settings = loadFlantSettings(orchestrator.cwd);
  if (!settings.autoRateLimitFallback) {
    ctx.ui?.notify?.("The personal subscription is rate-limited. Automatic paid-provider fallback is disabled in .pp/config.json.", "warning");
    return;
  }
  const mainSpec = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const sameFamily = getModelInfo(modelId).family === getModelInfo(mainSpec).family;
  const switchMain = origin === "main" || (isSubscriptionRouted(mainSpec, ctx.model?.provider) && sameFamily);
  if (switchMain) {
    const next = toNonSubSpec(origin === "main" ? modelId : mainSpec);
    try {
      if (!await orchestrator.switchModel(ctx, next, thinking(orchestrator))) {
        ctx.ui?.notify?.("Subscription rate limit detected, but regular Flant routing is unavailable. Automatic continuation is paused.", "error");
        return;
      }
    } catch {
      ctx.ui?.notify?.("Subscription rate limit detected, but switching to regular Flant routing failed. Automatic continuation is paused.", "error");
      return;
    }
  }
  orchestrator.subFallbackActive = true;
  orchestrator.subFallbackModelId = modelId;
  orchestrator.subFallbackMainPriorSpec = switchMain ? mainSpec || modelId : null;
  setSubscriptionFallbackActive(true);
  ctx.ui?.notify?.("Subscription rate limit detected; switched to regular paid Flant routing and will switch back after the limit clears.", "warning");
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
    if (outcome !== "ok") {
      armSwitchBackProbe(orchestrator);
      return;
    }
    const ctx = orchestrator.lastCtx;
    setSubscriptionFallbackActive(false);
    orchestrator.subFallbackActive = false;
    const prior = orchestrator.subFallbackMainPriorSpec;
    orchestrator.subFallbackMainPriorSpec = null;
    orchestrator.subFallbackModelId = null;
    if (prior) await orchestrator.switchModel(ctx, resolveModel(prior), thinking(orchestrator));
    ctx?.ui?.notify?.("Subscription limit cleared; switched back to personal subscription routing.", "info");
  }, delay);
  orchestrator.subSwitchBackTimer.unref?.();
}
