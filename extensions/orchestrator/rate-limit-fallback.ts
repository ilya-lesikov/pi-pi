import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";
import { isSubscriptionRouted } from "./usage-tracker.js";
import { setSubscriptionFallbackActive, toNonSubSpec } from "./model-registry.js";
import { loadFlantSettings, probeSubscriptionCleared } from "./flant-infra.js";
import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";

// Recognise a rate-limit / 429 error from a turn's or subagent's error message.
export function isRateLimitError(message?: string): boolean {
  if (typeof message !== "string") return false;
  return /\b429\b|rate.?limit|too many requests|exceed your account/i.test(message);
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
  if (orchestrator.subFallbackDialogPending) return;
  if (!ctx?.hasUI) {
    // No UI to ask — leave sub routing in place; the error is surfaced elsewhere.
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

  // Switch the CURRENT main model to the non-sub equivalent ONLY when the 429 was
  // on the main turn. For a SUBAGENT 429 the failing model is the subagent's, not
  // the main session's — switching the main model here would change the active
  // orchestrator model the user never touched (e.g. debug's GPT -> Claude). The
  // session override above already re-routes the retried/next subagent.
  if (origin === "main" && subModelId) {
    const nonSub = toNonSubSpec(subModelId);
    const ok = await orchestrator.switchModel(ctx, nonSub, currentThinking(orchestrator));
    if (!ok) log.warn({ s: "ratelimit", nonSub }, "failed to switch main model to non-sub");
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

function currentThinking(orchestrator: Orchestrator): string {
  const phase = orchestrator.active?.state.phase;
  const orchestrators = orchestrator.config?.agents?.orchestrators as Record<string, { thinking?: string }> | undefined;
  const key = phase === "debug" || phase === "brainstorm" || phase === "review" || phase === "quick" ? phase : "implement";
  return orchestrators?.[key]?.thinking ?? "high";
}

// Arm the fixed-interval switch-back probe. On each interval an out-of-band probe
// checks whether the sub limit cleared; a 429/failure silently re-arms, a success
// opens the switch-back dialogue. Only one timer runs at a time.
export function armSwitchBackProbe(orchestrator: Orchestrator): void {
  if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
  const minutes = Math.max(1, loadFlantSettings().switchBackIntervalMinutes || 30);
  const taskToken = orchestrator.activeTaskToken;
  orchestrator.subSwitchBackTimer = setTimeout(() => {
    orchestrator.subSwitchBackTimer = null;
    void runSwitchBackProbe(orchestrator, taskToken);
  }, minutes * 60 * 1000);
}

async function runSwitchBackProbe(orchestrator: Orchestrator, taskToken: number): Promise<void> {
  const log = getLogger();
  if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active || !orchestrator.subFallbackActive) {
    return;
  }
  const modelId = orchestrator.subFallbackModelId;
  if (!modelId) {
    armSwitchBackProbe(orchestrator);
    return;
  }
  const outcome = await probeSubscriptionCleared(modelId);
  if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active || !orchestrator.subFallbackActive) {
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
  orchestrator.subFallbackActive = false;
  setSubscriptionFallbackActive(false);
  if (orchestrator.subSwitchBackTimer) {
    clearTimeout(orchestrator.subSwitchBackTimer);
    orchestrator.subSwitchBackTimer = null;
  }
  const ok = await orchestrator.switchModel(ctx, subModelId, currentThinking(orchestrator));
  if (!ok) log.warn({ s: "ratelimit", subModelId }, "failed to switch back to sub model");
  orchestrator.subFallbackModelId = null;
  ctx.ui?.notify?.("Switched back to the personal Claude subscription.", "info");
  const phase = orchestrator.active?.state.phase ?? "current";
  orchestrator.sendUserMessageWhenIdle(
    `[PI-PI] Switched back to the personal Claude subscription. Continue working on the current phase (${phase}).`,
    orchestrator.activeTaskToken,
  );
}
