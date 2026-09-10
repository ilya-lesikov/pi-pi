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

// How much room is kept above the prose that cannot be folded, so a session
// whose prose has grown still has somewhere to work rather than folding on
// every request.
//
// It is an absolute count rather than a share of the window because it
// describes the work, not the model: the same debugging session needs the same
// recent tool history whether the model holds 200K tokens or a million. As a
// share it also made the declared ceiling meaningless — a quarter of a 1M
// window is 250K, so folding began a quarter of a million tokens above the
// floor no matter what the operator asked for.
export const DEFAULT_HEADROOM_TOKENS = 200_000;

// How much of that headroom is kept as recent tool history when a fold lands:
// the rest is the room the prompt grows back into before the next one. Each
// fold rewrites the prompt prefix and costs a cache miss, so leaving most of
// the headroom free is what makes folds rare, while what it does keep is the
// tool traffic that survives verbatim.
export const DEFAULT_KEEP_FRACTION = 0.3;

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
   * Room kept above the unfoldable floor before folding starts. Absent means
   * {@link DEFAULT_HEADROOM_TOKENS}.
   *
   * Global rather than per-model: it describes how much recent tool history the
   * work needs, which the model does not change. The model bounds it through
   * its window, not through this.
   */
  headroomTokens?: number;
  /**
   * The share of that headroom kept as recent tool history after a fold,
   * strictly between 0 and 1. Absent means {@link DEFAULT_KEEP_FRACTION}.
   */
  keepFraction?: number;
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
 * The ceiling climbs with that floor, so a session whose prose has grown keeps a
 * working margin instead of folding harder and harder around it, and it is
 * capped by what the window can actually hold: a model that admits 200K tokens
 * must start folding below 200K, however much headroom was asked for.
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

  const headroom = settings.headroomTokens && settings.headroomTokens > 0
    ? settings.headroomTokens
    : DEFAULT_HEADROOM_TOKENS;

  // The climb needs a window to be bounded by. Without one there is nothing
  // safe to climb towards — the configured ceiling is the whole of what is
  // known about the model — so it stays put, and a floor that outgrows it is
  // reported by the overflow warning rather than papered over by raising the
  // limit the operator set precisely because the window is unknown.
  if (window > 0) {
    const hard = window - OUTPUT_RESERVE - Math.floor(window * WINDOW_MARGIN);
    if (hard > 0) ceiling = Math.min(hard, Math.max(ceiling, floorTokens + headroom));
  }

  // A fold lands this far above the floor, as a share of the span between floor
  // and ceiling. Expressed against the span rather than against either end, the
  // recent history it keeps and the room it leaves are both a fixed share of
  // the headroom, whatever the prose has grown to — where the old pair of rules
  // crossed over and left the least history exactly where the headroom was
  // fully spent.
  const keep = settings.keepFraction && settings.keepFraction > 0 && settings.keepFraction < 1
    ? settings.keepFraction
    : DEFAULT_KEEP_FRACTION;
  const span = Math.max(0, ceiling - floorTokens);
  const lowWater = floorTokens + Math.floor(span * keep);

  return { ceiling, lowWater };
}
