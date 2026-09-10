type AgentMessage = Record<string, any>;

// The divisor the estimate starts from. It counts UTF-8 bytes rather than
// characters on purpose: a character count under-counts Cyrillic by around 40%,
// because Russian tokenizes at roughly half the characters per token of English
// while its UTF-8 length is roughly double.
const BYTES_PER_TOKEN = 4;

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
    let size = byteLength((message as any).toolName ?? "");
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

function partBytes(part: any): number {
  if (!part || typeof part !== "object") return 0;
  switch (part.type) {
    case "text":
      return byteLength(part.text ?? "");
    case "thinking":
      return thinkingBytes(part);
    case "toolCall":
      return byteLength(part.name ?? "") + jsonBytes(part.arguments);
    case "image":
      return (part.data ?? "").length;
    default:
      return 0;
  }
}

export { BYTES_PER_TOKEN };
