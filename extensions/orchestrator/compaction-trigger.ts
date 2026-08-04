import type { CompactionConfig } from "./config.js";

// Proactive in-phase compaction trigger (item 1). Computes the token threshold
// at which pi-pi asks the host to compact, honoring a fraction of the model's
// context window floored at a minimum, with per-model overrides and a hard
// window-minus-reserve ceiling for small windows. Pure + stateful helpers are
// separated so the math is unit-testable.

// Reserve headroom kept below the context window as a hard ceiling: even if the
// fraction*floor math lands higher, never arm a threshold above
// (contextWindow - RESERVE) so a tiny window still compacts before overflowing.
export const CONTEXT_RESERVE_TOKENS = 32000;

export interface ThresholdInput {
  contextWindow: number;
  modelId?: string;
  config: CompactionConfig;
}

/**
 * Resolve the effective { fraction, floorTokens } for a model, applying a
 * per-model override on top of the global defaults.
 */
export function effectiveCompactionParams(
  config: CompactionConfig,
  modelId: string | undefined,
): { fraction: number; floorTokens: number; headroomFraction: number; headroomFloorTokens: number } {
  let fraction = config.fraction;
  let floorTokens = config.floorTokens;
  let headroomFraction = config.headroomFraction;
  let headroomFloorTokens = config.headroomFloorTokens;
  if (modelId) {
    // Match either the exact spec or the bare id (drop provider prefix / sub/).
    const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
    const override = config.perModel[modelId] ?? config.perModel[bare];
    if (override) {
      if (typeof override.fraction === "number") fraction = override.fraction;
      if (typeof override.floorTokens === "number") floorTokens = override.floorTokens;
      if (typeof override.headroomFraction === "number") headroomFraction = override.headroomFraction;
      if (typeof override.headroomFloorTokens === "number") headroomFloorTokens = override.headroomFloorTokens;
    }
  }
  return { fraction, floorTokens, headroomFraction, headroomFloorTokens };
}

/**
 * Adaptive headroom for a model: max(headroomFloorTokens, headroomFraction*window).
 * Additive (not multiplicative) so the useful-work budget doesn't shrink as the
 * post-compaction baseline grows.
 */
export function compactionHeadroom(input: ThresholdInput): number {
  const { headroomFraction, headroomFloorTokens } = effectiveCompactionParams(input.config, input.modelId);
  return Math.max(headroomFloorTokens, Math.floor(input.contextWindow * headroomFraction));
}

/**
 * The adaptive next threshold after a proactive compaction left
 * `postCompactionTokens` in context:
 *   nextThreshold = min(window - RESERVE, max(baseThreshold, postCompactionTokens + headroom))
 * so the trigger CLIMBS with the growing baseline (keeping a fixed working-room
 * budget) but never exceeds the hard ceiling and never drops below the fixed
 * base threshold.
 */
export function adaptiveNextThreshold(input: ThresholdInput, postCompactionTokens: number): number {
  const base = compactionThresholdTokens(input);
  const headroom = compactionHeadroom(input);
  const ceiling = Math.max(1, input.contextWindow - CONTEXT_RESERVE_TOKENS);
  return Math.min(ceiling, Math.max(base, postCompactionTokens + headroom));
}

/**
 * Thrash guard: proactive compaction should be DISABLED when the post-compaction
 * baseline plus the requested headroom cannot fit under the (window - RESERVE)
 * ceiling. STRICT greater-than: at equality the full headroom fits exactly and
 * the adaptive threshold is still valid, so equality does NOT disable.
 */
export function wouldThrash(input: ThresholdInput, postCompactionTokens: number): boolean {
  const headroom = compactionHeadroom(input);
  const ceiling = Math.max(1, input.contextWindow - CONTEXT_RESERVE_TOKENS);
  return postCompactionTokens + headroom > ceiling;
}

/**
 * The token count at which compaction should fire for a model. Uses
 * max(fraction*window, floor) so large windows compact at the fraction and
 * mid/small windows use the floor, then clamps to (window - reserve) so a window
 * smaller than the floor still triggers before it overflows.
 *
 * Examples (defaults 30% / 250K floor):
 *   1M window   -> max(300K, 250K) = 300K (< 1M-32K ceiling)
 *   500K window -> max(150K, 250K) = 250K floor
 *   200K window -> max(60K, 250K)=250K, clamped to 200K-32K = 168K ceiling
 */
export function compactionThresholdTokens(input: ThresholdInput): number {
  const { fraction, floorTokens } = effectiveCompactionParams(input.config, input.modelId);
  const byFraction = Math.floor(input.contextWindow * fraction);
  const target = Math.max(byFraction, floorTokens);
  const ceiling = Math.max(1, input.contextWindow - CONTEXT_RESERVE_TOKENS);
  return Math.min(target, ceiling);
}

// Hysteresis state so a single crossing arms exactly one compaction and does not
// re-fire until context has DROPPED below a lower band and then re-crossed the
// threshold again. Kept per-session in memory.
export interface CompactionArmState {
  armed: boolean;
}

export function makeCompactionArmState(): CompactionArmState {
  return { armed: true };
}

/**
 * Decide whether to fire compaction now given the current token usage and the
 * arm state. Fires (returns true) only when armed AND tokens exceed the
 * threshold; disarms on firing. Re-arms once tokens fall back below the lower
 * band (threshold * rearmFraction) so post-compaction growth must materially
 * re-cross before firing again. rearmFraction defaults to 0.9 (re-arm once usage
 * drops under 90% of the threshold, i.e. after a compaction shrank the context).
 */
export function shouldFireCompaction(
  tokens: number | null,
  threshold: number,
  state: CompactionArmState,
  rearmFraction = 0.9,
): boolean {
  if (tokens == null) return false;
  const rearmBand = Math.floor(threshold * rearmFraction);
  if (!state.armed) {
    // Re-arm once usage has dropped materially below the threshold.
    if (tokens < rearmBand) state.armed = true;
    return false;
  }
  if (tokens > threshold) {
    state.armed = false;
    return true;
  }
  return false;
}
