import type { Limits } from "./fold.js";

// The ceiling for a model whose window nobody declared. It suits the smallest
// window in common use once an output reservation and a margin are taken off
// it, and it is deliberately not a fraction of anything: with no window to take
// a fraction of, a fraction is a guess dressed as arithmetic.
export const DEFAULT_MAX_PROMPT_TOKENS = 150_000;

// What a turn may generate, kept clear of the prompt.
const OUTPUT_RESERVE = 40_000;

// Held back from a declared window on top of the output reserve, because the
// estimate is an approximation and the cost of overshooting is the whole turn
// failing.
const WINDOW_MARGIN = 0.05;

// How much of a declared window is kept available above the prose that cannot
// be folded, so a session whose prose has grown still has room to work in
// rather than folding on every request.
const HEADROOM_FRACTION = 0.25;

// How far below the ceiling a fold aims. The gap is what buys requests between
// folds: each fold rewrites the prompt prefix and costs a cache miss, so
// overshooting deeply is cheaper than landing on the ceiling and crossing it
// again immediately.
const LOW_WATER_FRACTION = 0.5;

// Keeps the low-water mark clear of the incompressible floor, so a target that
// cannot be reached is not chased.
const FLOOR_HEADROOM = 0.1;

// How far past the ceiling a prompt may sit before the turn is refused rather
// than sent. Some overshoot is expected — the estimate is an approximation, and
// prose is never folded — so refusing at the ceiling itself would refuse turns
// the provider would have accepted.
export const OVERFLOW_MARGIN = 1.15;

export interface PromptcapModelSettings {
  /** The ceiling applied when no window is known. */
  maxPromptTokens?: number;
  /**
   * The model's total window. Zero or absent means unknown, which is the
   * honest default for a provider that does not report one.
   */
  contextWindow?: number;
}

export interface PromptcapSettings extends PromptcapModelSettings {
  enabled: boolean;
  /**
   * Overrides keyed by the model spec a turn asks for, matched on either the
   * full `provider/id` or the bare id.
   */
  perModel: Record<string, PromptcapModelSettings>;
}

export function resolveSettings(settings: PromptcapSettings, modelKey: string | undefined): PromptcapModelSettings {
  const resolved: PromptcapModelSettings = {
    maxPromptTokens: settings.maxPromptTokens,
    contextWindow: settings.contextWindow,
  };
  if (!modelKey) return resolved;
  const bare = modelKey.includes("/") ? modelKey.slice(modelKey.lastIndexOf("/") + 1) : modelKey;
  const override = settings.perModel[modelKey] ?? settings.perModel[bare];
  if (!override) return resolved;
  if (override.maxPromptTokens && override.maxPromptTokens > 0) resolved.maxPromptTokens = override.maxPromptTokens;
  if (override.contextWindow && override.contextWindow > 0) resolved.contextWindow = override.contextWindow;
  return resolved;
}

/**
 * The limits a turn answered by `modelKey` is held to, given how much of the
 * prompt cannot be folded.
 *
 * The ceiling climbs with that floor when a window is known, so a session whose
 * prose has grown keeps a working margin instead of folding harder and harder
 * around it. Without a declared window there is nothing safe to climb towards,
 * and the ceiling stays where it was configured.
 */
export function limitsFor(
  settings: PromptcapSettings,
  modelKey: string | undefined,
  floorTokens: number,
  reportedWindow?: number,
): Limits {
  const resolved = resolveSettings(settings, modelKey);
  let ceiling = resolved.maxPromptTokens && resolved.maxPromptTokens > 0
    ? resolved.maxPromptTokens
    : DEFAULT_MAX_PROMPT_TOKENS;

  // A window the host reports for the active model is as good as a declared
  // one, and it is the common case: an operator only has to declare a window
  // the provider keeps to itself.
  const window = resolved.contextWindow && resolved.contextWindow > 0
    ? resolved.contextWindow
    : reportedWindow && reportedWindow > 0 ? reportedWindow : 0;

  if (window > 0) {
    const hard = window - OUTPUT_RESERVE - Math.floor(window * WINDOW_MARGIN);
    const wanted = Math.min(hard, Math.max(ceiling, floorTokens + Math.floor(window * HEADROOM_FRACTION)));
    if (wanted > 0) ceiling = wanted;
  }

  const lowWater = Math.min(
    ceiling,
    Math.max(Math.floor(ceiling * LOW_WATER_FRACTION), floorTokens + Math.floor(ceiling * FLOOR_HEADROOM)),
  );

  return { ceiling, lowWater };
}
