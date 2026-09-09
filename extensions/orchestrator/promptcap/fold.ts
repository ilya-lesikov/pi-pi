import { byteLength, messagesBytes, BYTES_PER_TOKEN } from "./estimate.js";

export type AgentMessage = Record<string, any>;

/** How much of one tool call survives into the prompt. */
export enum Tier {
  /** The call and its result as they were. */
  Verbatim = 0,
  /**
   * What the call was — its name, and enough of its arguments to name the
   * object it addressed — with its result replaced by a notice.
   */
  Digest = 1,
  /**
   * Only that the call happened, by its name.
   *
   * The name stays on the call rather than the whole pair being replaced by one
   * line summarizing many: removing a call means removing the result paired
   * with it, and a provider rejects a tool result whose call it cannot see. The
   * saving over a bare name is not worth trading a structural invariant for.
   */
  Breadcrumb = 2,
}

// Caps one argument value in a digested call. The cap is per value rather than
// over the serialized blob because JSON key order is arbitrary: cutting the
// blob drops whichever keys sort last, which can mean losing the path or the
// object name while keeping a file body.
const ARG_LEAF_BYTES = 200;

// A list-valued argument is capped by element count before its bytes are, so
// what reaches the model is still a list rather than a JSON document cut in
// half.
const ARG_LIST_KEEP = 5;

// Bound an error kept in a digested call. Both ends are kept because a long
// failure states its conclusion in either place: a rejected write leads with
// the reason, a test or lint run ends with it.
const ERROR_HEAD_BYTES = 1000;
const ERROR_TAIL_BYTES = 500;

export interface Limits {
  /** The prompt size that triggers folding. */
  ceiling: number;
  /**
   * Folded down to once the ceiling is crossed, so the next call has room to
   * grow into rather than crossing the ceiling again immediately. Overshooting
   * is what makes cache invalidation rare.
   */
  lowWater: number;
}

/**
 * Tools whose newest result is never folded.
 *
 * A skill document is operating guidance the agent believes is in effect, not
 * a lookup it can repeat: folding it away silently changes how the agent works
 * with nothing to show for it. An older load of the same skill still folds —
 * only the newest of each is pinned.
 */
export const PINNED_TOOLS = new Set(["load_skill"]);

export interface FoldResult {
  /** Estimated prompt size after folding, in tokens. */
  tokens: number;
  /** Estimated prompt size before folding, in tokens. */
  tokensBefore: number;
  /** Calls standing at digest or below-verbatim after this pass. */
  folded: number;
}

interface Call {
  id: string;
  /** Index into messages of the assistant message carrying the tool call. */
  callMessage: number;
  /** Index into that message's content array. */
  callPart: number;
  /** Index into messages of the paired tool result. */
  resultMessage: number;
  /**
   * The result's content as it arrived. Promoting a call twice in one pass
   * would otherwise measure and clamp the notice left by the first promotion
   * instead of the output it stood for.
   */
  resultContent: any[];
  tier: Tier;
}

/**
 * Remembers how far each call has been folded, so a call that has been folded
 * stays folded even when the budget briefly widens. Monotonicity is what keeps
 * the prompt's prefix stable between calls, and a stable prefix is what the
 * provider's cache is keyed on; re-expanding a call would invalidate everything
 * after it.
 */
export class FoldState {
  private tiers = new Map<string, Tier>();

  tierOf(callId: string): Tier {
    return this.tiers.get(callId) ?? Tier.Verbatim;
  }

  promote(callId: string, to: Tier): void {
    if (to > this.tierOf(callId)) this.tiers.set(callId, to);
  }

  clear(): void {
    this.tiers.clear();
  }

  get size(): number {
    return this.tiers.size;
  }
}

/**
 * Folds old tool traffic in `messages` until the prompt fits, mutating in
 * place, and reports the estimate it settled on.
 *
 * The host hands each `context` handler a deep clone of the conversation, so
 * editing it changes what the model is sent and nothing else — the session
 * store keeps every byte, which is what lets recall hand a dropped result back.
 */
export function fold(
  messages: AgentMessage[],
  fixedBytes: number,
  limits: Limits,
  state: FoldState,
  ratio = 1,
): FoldResult {
  const toTokens = (bytes: number) => tokensOf(bytes, ratio);
  let bytes = fixedBytes + messagesBytes(messages);
  const tokensBefore = toTokens(bytes);

  const calls = indexCalls(messages);
  const protectedFrom = lastUserMessageIndex(messages);

  // Re-apply what earlier requests already decided before measuring against the
  // budget. The host hands over a fresh copy of the stored conversation every
  // time, so without this a call folded ten requests ago would come back whole
  // and move the prompt's prefix.
  for (const call of calls) {
    const remembered = state.tierOf(call.id);
    if (remembered === Tier.Verbatim) continue;
    bytes -= applyTier(messages, call, remembered, protectedFrom);
    call.tier = remembered;
  }

  if (toTokens(bytes) > limits.ceiling) {
    // The low-water mark is raised to clear the incompressible floor, because a
    // target below it can never be reached: the loop would promote everything
    // on every request and still sit above the target, leaving the model no
    // recent tool history for no gain.
    const target = Math.max(limits.lowWater, toTokens(bytes - foldableBytes(messages, calls, protectedFrom)));

    for (const to of [Tier.Digest, Tier.Breadcrumb]) {
      for (const call of calls) {
        if (toTokens(bytes) <= target) break;
        if (call.tier >= to) continue;
        bytes -= applyTier(messages, call, to, protectedFrom);
        call.tier = to;
        state.promote(call.id, to);
      }
    }
  }

  return {
    tokens: toTokens(bytes),
    tokensBefore,
    folded: calls.filter((call) => call.tier !== Tier.Verbatim).length,
  };
}

/**
 * What the prompt would still cost with every tool call folded as far as it
 * goes: the prose, the fixed cost, and a breadcrumb per call. Nothing can bring
 * a prompt below this, so it is what the budget has to be set around.
 */
export function incompressibleTokens(messages: AgentMessage[], fixedBytes: number, ratio = 1): number {
  const calls = indexCalls(messages);
  const total = fixedBytes + messagesBytes(messages);
  return tokensOf(total - foldableBytes(messages, calls, lastUserMessageIndex(messages)), ratio);
}

export function tokensOf(bytes: number, ratio = 1): number {
  return Math.floor(Math.floor(Math.max(0, bytes) / BYTES_PER_TOKEN) * ratio);
}

/**
 * Pairs each tool call with its result, oldest first. A call still awaiting its
 * result belongs to the turn in flight — the one whose tool is running, or
 * whose confirmation the user is looking at — and is left out rather than
 * folded: the model is about to act on it.
 */
function indexCalls(messages: AgentMessage[]): Call[] {
  const pending = new Map<string, Call>();
  const calls: Call[] = [];

  for (let m = 0; m < messages.length; m++) {
    const message = messages[m];
    if (message?.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (let p = 0; p < content.length; p++) {
        const part = content[p];
        if (part?.type !== "toolCall" || typeof part.id !== "string" || !part.id) continue;
        pending.set(part.id, { id: part.id, callMessage: m, callPart: p, resultMessage: -1, resultContent: [], tier: Tier.Verbatim });
      }
      continue;
    }
    if (message?.role !== "toolResult") continue;
    const call = pending.get(message.toolCallId);
    if (!call) continue;
    pending.delete(message.toolCallId);
    call.resultMessage = m;
    call.resultContent = Array.isArray(message.content) ? message.content : [];
    calls.push(call);
  }

  return dropPinned(messages, calls);
}

/** Drops the newest call of each pinned tool, by the object it addressed. */
function dropPinned(messages: AgentMessage[], calls: Call[]): Call[] {
  const newest = new Map<string, Call>();
  for (const call of calls) {
    const part = callPart(messages, call);
    if (!part || !PINNED_TOOLS.has(part.name)) continue;
    newest.set(`${part.name}:${jsonText(part.arguments)}`, call);
  }
  if (newest.size === 0) return calls;
  const pinned = new Set([...newest.values()]);
  return calls.filter((call) => !pinned.has(call));
}

/**
 * The index of the newest user message. Reasoning after it is left alone:
 * Anthropic requires the thinking blocks of an assistant turn in the last
 * position to be replayed complete when that turn used tools, and OpenAI asks
 * for every reasoning item since the last user message.
 */
function lastUserMessageIndex(messages: AgentMessage[]): number {
  for (let m = messages.length - 1; m >= 0; m--) {
    if (messages[m]?.role === "user") return m;
  }
  return messages.length;
}

/** What full folding would still be able to remove from here. */
function foldableBytes(messages: AgentMessage[], calls: Call[], protectedFrom: number): number {
  let savings = 0;
  for (const call of calls) {
    if (call.tier >= Tier.Breadcrumb) continue;
    const part = callPart(messages, call);
    if (part) savings += jsonBytesOf(part.arguments) - jsonBytesOf({});
    if (call.callMessage < protectedFrom) savings += thinkingBytes(messages[call.callMessage]);
    const result = messages[call.resultMessage];
    if (!result) continue;
    const breadcrumb = byteLength(result.toolName ?? "") + byteLength(collapseResult(call, false, Tier.Breadcrumb)[0].text);
    savings += Math.max(0, messagesBytes([result]) - breadcrumb);
  }
  return savings;
}

function thinkingBytes(message: AgentMessage | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (block?.type === "thinking" && !block.redacted) size += byteLength(block.thinking ?? "");
  }
  return size;
}

/** Rewrites one call's parts to match a tier, returning the bytes it saved. */
function applyTier(messages: AgentMessage[], call: Call, to: Tier, protectedFrom: number): number {
  let saved = 0;

  const part = callPart(messages, call);
  if (part) {
    const before = jsonBytesOf(part.arguments);
    part.arguments = to >= Tier.Breadcrumb ? {} : trimArgs(part.arguments);
    saved += before - jsonBytesOf(part.arguments);
  }

  // The reasoning that produced a call is what the model needed to make it, not
  // something it re-reads twenty calls later — so it goes at the same moment,
  // except in the tail the provider requires intact. Emptying the text rather
  // than removing the block keeps every later index valid; the provider adapter
  // drops a thinking block whose text is blank.
  if (call.callMessage < protectedFrom) {
    const content = messages[call.callMessage]?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "thinking" || block.redacted || !block.thinking) continue;
        saved += byteLength(block.thinking);
        block.thinking = "";
      }
    }
  }

  const result = messages[call.resultMessage];
  if (result) {
    const before = messagesBytes([result]);
    result.content = collapseResult(call, result.isError === true, to);
    saved += before - messagesBytes([result]);
  }

  return saved;
}

function callPart(messages: AgentMessage[], call: Call): any {
  const content = messages[call.callMessage]?.content;
  if (!Array.isArray(content)) return undefined;
  const part = content[call.callPart];
  return part?.type === "toolCall" && part.id === call.id ? part : undefined;
}

/**
 * Replaces a tool result with a notice naming its size and the call it belonged
 * to, so the model can ask for it back by id. The wording is not repeated here:
 * the system prompt explains once what the notice means, which is worth
 * thousands of tokens across a session that folds hundreds of calls.
 */
function collapseResult(call: Call, isError: boolean, to: Tier): any[] {
  const text = call.resultContent.map((part: any) => (part?.type === "text" ? part.text ?? "" : "")).join("");
  // A failure is worth more than a success of the same size: it is what stops
  // the model repeating a call that cannot work, so a digested one keeps both
  // ends of its text where a digested success keeps none.
  if (isError && to < Tier.Breadcrumb) return [{ type: "text", text: clampEnds(text, call.id) }];
  return [{ type: "text", text: omission(byteLength(text), call.id) }];
}

export function omission(size: number, id: string): string {
  return id ? `[omitted: ${size}B; ${id}]` : `[omitted: ${size}B]`;
}

/** Keeps the beginning and the end of `text`, naming what was dropped between. */
function clampEnds(text: string, id: string): string {
  const size = byteLength(text);
  if (size <= ERROR_HEAD_BYTES + ERROR_TAIL_BYTES) return text;
  const head = cutBytes(text, ERROR_HEAD_BYTES);
  const tail = cutBytesFromEnd(text, ERROR_TAIL_BYTES);
  return `${head}\n${omission(size - byteLength(head) - byteLength(tail), id)}\n${tail}`;
}

/** Caps each argument value, leaving every key in place. */
function trimArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return (args ?? {}) as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    const value = Array.isArray(raw) && raw.length > ARG_LIST_KEEP
      ? [...raw.slice(0, ARG_LIST_KEEP), `…[+${raw.length - ARG_LIST_KEEP}]`]
      : raw;
    const encoded = typeof value === "string" ? value : jsonText(value);
    const size = byteLength(encoded);
    if (size <= ARG_LEAF_BYTES) {
      trimmed[key] = value;
      continue;
    }
    trimmed[key] = `${cutBytes(encoded, ARG_LEAF_BYTES)}…[+${size - ARG_LEAF_BYTES}B]`;
  }
  return trimmed;
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function jsonBytesOf(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/** The first `n` bytes of `text`, without splitting a character. */
export function cutBytes(text: string, n: number): string {
  if (byteLength(text) <= n) return text;
  let cut = text.slice(0, n);
  while (cut.length > 0 && byteLength(cut) > n) cut = cut.slice(0, -1);
  return cut;
}

/** The last `n` bytes of `text`, without splitting a character. */
export function cutBytesFromEnd(text: string, n: number): string {
  if (byteLength(text) <= n) return text;
  let cut = text.slice(-n);
  while (cut.length > 0 && byteLength(cut) > n) cut = cut.slice(1);
  return cut;
}
