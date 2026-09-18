type AgentMessage = Record<string, any>;

// The divisor the estimate starts from. It counts UTF-8 bytes rather than
// characters on purpose: a character count under-counts Cyrillic by around 40%,
// because Russian tokenizes at roughly half the characters per token of English
// while its UTF-8 length is roughly double.
const BYTES_PER_TOKEN = 4;

// What one image costs, in the bytes this estimate speaks in.
//
// A provider charges an image by its pixels, not by the length of the base64
// that carries it: Anthropic bills roughly width x height / 750 tokens after
// fitting the image inside 1568px, which puts a ceiling near this figure on any
// single image, and the other providers land in the same range. The payload is
// nothing like that — counted as characters, one 1080x1920 screenshot weighed
// 442K tokens where it cost 1.6K — so an image is charged the ceiling flat.
// Dimensions would be more exact, but they are worth neither the format
// parsing nor the risk of under-counting: the error left is a rounding on one
// message, where the character count was a factor of fifty on the prompt.
const IMAGE_TOKENS = 1_600;

// What a tool call costs on top of its name and arguments: the JSON block that
// carries it, and the result block that answers it.
//
// It is counted per call rather than left to the learned ratio because it does
// not scale with the conversation's bytes. A ratio asked to absorb it stops
// measuring token density and starts tracking the calls-to-bytes proportion —
// in a session of thousands of small calls it climbs without bound, and since
// the floor is scaled by that ratio, the ceiling climbs with it.
const TOOL_CALL_ENVELOPE_BYTES = 126;

// How far the learned ratio moves towards each new reading. One reading
// describes one prompt, and a turn that happens to be all YAML or all prose
// would otherwise swing the estimate for every turn after it.
const CALIBRATION_WEIGHT = 0.25;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/**
 * Approximates a prompt's token count and corrects itself from what the
 * provider charges.
 *
 * The divisor is crude on purpose — a tokenizer per model is a dependency this
 * does not need — and its error is systematic rather than random: it is wrong
 * in the same direction for a given model and a given mix of prose, YAML and
 * code. So the ratio between what a call actually cost and what this predicted
 * is worth keeping and applying to the next one.
 */
export class Estimator {
  private ratios = new Map<string, number>();

  tokens(messages: AgentMessage[], fixedBytes: number, modelKey: string): number {
    const raw = Math.floor((fixedBytes + messagesBytes(messages)) / BYTES_PER_TOKEN);
    const ratio = this.ratios.get(modelKey);
    if (!ratio || ratio <= 0) return raw;
    return Math.floor(raw * ratio);
  }

  /**
   * Records what a call was actually charged against what was predicted for it.
   *
   * The prediction has to be the uncalibrated one. A ratio learned from a
   * prediction the previous ratio had already scaled measures how far the last
   * correction fell short rather than how far the raw estimate does, and
   * folding that back in drives the ratio to the square root of the truth: a
   * model whose prompts really cost twice the raw estimate would settle at 1.41
   * and understate every prompt by a third.
   */
  observe(modelKey: string, rawPredicted: number, charged: number): void {
    if (!modelKey || rawPredicted <= 0 || charged <= 0) return;
    const observed = charged / rawPredicted;
    const previous = this.ratios.get(modelKey);
    if (!previous || previous <= 0) {
      this.ratios.set(modelKey, observed);
      return;
    }
    this.ratios.set(modelKey, previous * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT);
  }

  ratioFor(modelKey: string): number | undefined {
    return this.ratios.get(modelKey);
  }
}

/**
 * Everything a request carries besides its conversation: the system prompt and
 * the tool declarations.
 *
 * They are counted because they are not small and not constant — a user's
 * skills and MCP servers decide the tool schemas, so one session's fixed cost
 * is several times another's — and because a limit that ignores them is not a
 * limit on what the provider receives.
 */
export function fixedBytes(systemPrompt: string | undefined, tools: unknown[] | undefined): number {
  let size = systemPrompt ? byteLength(systemPrompt) : 0;
  for (const tool of tools ?? []) size += jsonBytes(tool);
  return size;
}

export function messagesBytes(messages: AgentMessage[]): number {
  let size = 0;
  for (const message of messages) size += messageBytes(message);
  return size;
}

function messageBytes(message: AgentMessage): number {
  if (!message || typeof message !== "object") return 0;
  const role = (message as any).role;
  if (role === "toolResult") {
    // The call id is sent back to name the call being answered, so it is paid
    // for twice over a call's life.
    let size = byteLength((message as any).toolName ?? "") + byteLength((message as any).toolCallId ?? "");
    for (const part of (message as any).content ?? []) size += partBytes(part);
    return size;
  }
  const content = (message as any).content;
  if (typeof content === "string") return byteLength(content);
  let size = 0;
  for (const part of content ?? []) size += partBytes(part);
  return size;
}

/**
 * What one reasoning block costs.
 *
 * The signature is counted alongside the text because a provider that receives
 * the block is charged for both, and because counting less than what might be
 * sent is the dangerous direction: an underestimate is a turn the provider
 * rejects, while an overestimate only folds sooner than it had to.
 *
 * Whether a block whose text is empty reaches the provider at all is
 * adapter-specific, and `guard` logs what these blocks weigh against what the
 * provider charged so the question can be settled from a real session rather
 * than from reading adapters.
 */
export function thinkingBytes(part: any): number {
  return byteLength(part?.thinking ?? "") + byteLength(part?.thinkingSignature ?? "");
}

/** The signature bytes of blocks carrying no reasoning text, which is what the
 * adapters disagree about. Reported for diagnosis, not used in the estimate. */
export function danglingSignatureBytes(messages: AgentMessage[]): number {
  let size = 0;
  for (const message of messages) {
    const content = (message as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "thinking" || part.redacted) continue;
      if ((part.thinking ?? "").trim().length > 0) continue;
      size += byteLength(part.thinkingSignature ?? "");
    }
  }
  return size;
}

/** What one tool call costs: its own block, and the envelope carrying it. */
export function toolCallBytes(part: any): number {
  return byteLength(part?.name ?? "") + byteLength(part?.id ?? "") + jsonBytes(part?.arguments) + TOOL_CALL_ENVELOPE_BYTES;
}

function partBytes(part: any): number {
  if (!part || typeof part !== "object") return 0;
  switch (part.type) {
    case "text":
      return byteLength(part.text ?? "");
    case "thinking":
      return thinkingBytes(part);
    case "toolCall":
      return toolCallBytes(part);
    case "image":
      return IMAGE_TOKENS * BYTES_PER_TOKEN;
    default:
      return 0;
  }
}

export { BYTES_PER_TOKEN };
