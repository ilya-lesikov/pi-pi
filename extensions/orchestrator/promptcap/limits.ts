import type { Limits } from "./fold.js";
import { DEFAULT_IMAGE_TOKENS } from "./estimate.js";

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

// The image payload a prompt may carry before the oldest of it is folded away,
// and what a fold takes it back down to.
//
// These are wire bytes, and they exist because the token budget cannot see
// them: a provider prices an image by its pixels, so a screenshot the estimate
// counts at 1.6K tokens is around 350KB of base64 on every request that carries
// it. A session navigating by screenshot would reach a 32MB body limit around
// ninety captures deep while the token ceiling still read the conversation as
// small, and the turn would be refused by the gateway rather than folded.
//
// The low-water mark is roughly three captures at the size the shrinker settles
// on, which is the recent history a model comparing one screen against the last
// actually reads; the ceiling is twice that, so a fold lands every few captures
// instead of on every turn, and each one costs one cache miss rather than a
// steady stream of them.
export const DEFAULT_IMAGE_BYTES_CEILING = 3_500_000;
export const DEFAULT_IMAGE_BYTES_LOW_WATER = 1_750_000;

export interface PromptcapModelSettings {
  /**
   * The ceiling applied when no window is known.
   *
   * It raises the ceiling and never lowers it: once the unfoldable prose plus
   * the headroom exceeds this number, that sum is the ceiling instead. To fold
   * a long session sooner, cut {@link PromptcapSettings.headroomTokens} or
   * declare a smaller {@link contextWindow}, which bounds the ceiling from
   * above.
   */
  maxPromptTokens?: number;
  /**
   * What one image is counted as. Absent means
   * {@link DEFAULT_IMAGE_TOKENS}, which suits the frontier models; a small
   * model priced at a fraction per token is charged an order of magnitude more
   * for the same image and has to say so here.
   */
  imageTokens?: number;
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
   * Whether to ask Anthropic to hold the prompt cache for an hour instead of
   * five minutes. Absent means yes.
   *
   * The five-minute default expires across any pause worth the name — reading
   * a diff, a meeting, lunch — and the next turn re-buys the whole prompt at
   * write price. One session on disk lost 23.5M tokens that way against 14.2M
   * to every fold it did. An hour costs 2x base on the tokens actually written
   * rather than 1.25x, which one read landing after five minutes already pays
   * for, and nothing at all on a flat-rate subscription.
   */
  longCacheRetention?: boolean;
  /**
   * The image payload a prompt may carry before the oldest of it folds away,
   * in the bytes that go on the wire. Absent means
   * {@link DEFAULT_IMAGE_BYTES_CEILING}.
   *
   * Global rather than per-model because what it protects is the request body,
   * and the limit on that belongs to the gateway a request passes through
   * rather than to the model answering it.
   */
  imageBytesCeiling?: number;
  /**
   * What a pass over that ceiling folds the payload back down to. Absent means
   * {@link DEFAULT_IMAGE_BYTES_LOW_WATER}; a value at or above the ceiling
   * would fold on every turn, so it is held below it.
   */
  imageBytesLowWater?: number;
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
    imageTokens: settings.imageTokens,
  };
  if (!modelKey) return resolved;
  const bare = modelKey.includes("/") ? modelKey.slice(modelKey.lastIndexOf("/") + 1) : modelKey;
  const override = settings.perModel[modelKey] ?? settings.perModel[bare];
  if (!override) return resolved;
  if (override.maxPromptTokens && override.maxPromptTokens > 0) resolved.maxPromptTokens = override.maxPromptTokens;
  if (override.contextWindow && override.contextWindow > 0) resolved.contextWindow = override.contextWindow;
  if (override.imageTokens && override.imageTokens > 0) resolved.imageTokens = override.imageTokens;
  return resolved;
}

/** What one image counts as for `modelKey`. */
export function imageTokensFor(settings: PromptcapSettings, modelKey: string | undefined): number {
  const resolved = resolveSettings(settings, modelKey).imageTokens;
  return resolved && resolved > 0 ? resolved : DEFAULT_IMAGE_TOKENS;
}

/**
 * The limits a turn answered by `modelKey` is held to, given how much of the
 * prompt cannot be folded.
 *
 * The ceiling climbs with that floor, so a session whose prose has grown keeps a
 * working margin instead of folding harder and harder around it, and it is
 * capped by what the window can actually hold: a model that admits 200K tokens
 * must start folding below 200K, however much headroom was asked for.
 *
 * Because the ceiling climbs, `maxPromptTokens` is a lower bound on it rather
 * than a cap: it decides where folding starts only while the floor is small
 * enough that floor + headroom sits under it.
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
  let hard = 0;
  if (window > 0) {
    hard = window - OUTPUT_RESERVE - Math.floor(window * WINDOW_MARGIN);
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

  // Where folding stops weighing its cache miss and takes any saving it can
  // get. Some overshoot above the ceiling is expected and harmless, but never
  // past what the window itself allows: beyond that the request is refused
  // outright, and a fold that frees a little beats a turn that does not run.
  const urgent = hard > 0 ? Math.min(Math.round(ceiling * OVERFLOW_MARGIN), hard) : Math.round(ceiling * OVERFLOW_MARGIN);

  const imageCeiling = settings.imageBytesCeiling && settings.imageBytesCeiling > 0
    ? settings.imageBytesCeiling
    : DEFAULT_IMAGE_BYTES_CEILING;
  const configuredLowWater = settings.imageBytesLowWater && settings.imageBytesLowWater > 0
    ? settings.imageBytesLowWater
    : DEFAULT_IMAGE_BYTES_LOW_WATER;
  // A low-water mark the ceiling does not sit above leaves nothing to fold into
  // and a fold on every turn, so it is held under whatever ceiling was asked
  // for rather than taken at its word.
  const imageLowWater = Math.min(configuredLowWater, Math.floor(imageCeiling / 2));

  return { ceiling, lowWater, urgent, imageCeiling, imageLowWater };
}
