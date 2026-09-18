import { byteLength, messagesBytes, toolCallBytes, BYTES_PER_TOKEN } from "./estimate.js";

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
  /**
   * Gone: the call and the result answering it are both removed, and a run of
   * them leaves one line naming what went.
   *
   * This is the only tier that reclaims what a breadcrumb still costs. A
   * breadcrumb keeps the call, and a call carries its id twice over its life —
   * once on the call, once on the result that answers it — which is the larger
   * part of what an old call weighs once its arguments and output are gone. In
   * a session of thousands of calls that residue is most of the floor, and
   * because the ceiling is set above the floor, a floor that cannot fall is a
   * prompt that cannot stop growing.
   *
   * Removing one half alone is what the provider rejects, so both go together;
   * a whole turn leaves at once and the alternation the provider expects is
   * preserved.
   */
  Drop = 3,
}

// Caps one argument value in a digested call. The cap is per value rather than
// over the serialized blob because JSON key order is arbitrary: cutting the
// blob drops whichever keys sort last, which can mean losing the path or the
// object name while keeping a file body.
const ARG_LEAF_BYTES = 400;

// What an argument carrying literal payload is capped at instead. A command or
// a file body is something the model reproduces rather than looks up, and a cut
// one is worse than an absent one: it reads as content, so it gets retyped —
// a severed heredoc, a path ending mid-segment, a marker written into a file.
// The wider cap buys the room to keep such a value whole.
const ARG_CONTENT_BYTES = 2_000;

// Argument names whose value is literal payload rather than a reference to
// something the model could look up again.
const CONTENT_ARG_KEYS = new Set(["command", "content", "oldText", "newText", "patch", "body"]);

// How many of the newest calls are never dropped, however tight the budget.
// Recent tool traffic is what the model is still working from, so it is trimmed
// as before and left in place; only what it has finished with leaves entirely.
const DROP_KEEP_RECENT = 150;

// At most this many tool names are listed in the line standing for a dropped
// run, so one long run cannot cost more than the calls it replaced.
const DROP_NAMES_LISTED = 6;

// Held back from each dropped call against the line that will stand for it.
// The line is written after the budget has been met, so without a reserve a
// fold could land on target and then overshoot it by what the lines cost.
//
// One line covers a whole run of adjacent turns, and only a turn carrying
// nothing but calls is droppable, so prose cannot fragment a run into a line
// per call: the total is bounded by how often prose interrupts the tool
// traffic, not by how many calls were made. What is reserved here is therefore
// a per-run cost charged once, where a run is what survives between two pieces
// of prose.
const DROP_LINE_RESERVE_BYTES = 64;

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
  // How far the orphan reasoning below has been blanked. It follows the calls:
  // a turn that made none is folded when the tool traffic around it is.
  let reasoningFrom = 0;
  const followReasoning = (through: number): void => {
    bytes -= stripOrphanReasoning(messages, reasoningFrom, Math.min(through, protectedFrom));
    reasoningFrom = Math.max(reasoningFrom, through);
  };

  // Re-apply what earlier requests already decided before measuring against the
  // budget. The host hands over a fresh copy of the stored conversation every
  // time, so without this a call folded ten requests ago would come back whole
  // and move the prompt's prefix.
  for (const call of calls) {
    const remembered = state.tierOf(call.id);
    if (remembered === Tier.Verbatim) continue;
    // A dropped call is removed structurally in one pass once every tier is
    // settled, so here it only has to stop counting towards the prompt.
    bytes -= remembered >= Tier.Drop
      ? dropSavings(messages, call) + stripReasoning(messages, call, protectedFrom)
      : applyTier(messages, call, remembered, protectedFrom);
    call.tier = remembered;
    followReasoning(call.callMessage);
  }
  // Remembered drops are charged their lines here; newly promoted ones add
  // theirs as they are chosen.
  bytes += dropLineReserve(messages, calls.filter((call) => call.tier >= Tier.Drop));

  if (toTokens(bytes) > limits.ceiling) {
    // The low-water mark already clears the floor by construction — it is a
    // share of the span between floor and ceiling — so an unreachable target
    // cannot be chased here.
    const target = limits.lowWater;

    for (const to of [Tier.Digest, Tier.Breadcrumb]) {
      for (const call of calls) {
        if (toTokens(bytes) <= target) break;
        if (call.tier >= to) continue;
        bytes -= applyTier(messages, call, to, protectedFrom);
        call.tier = to;
        state.promote(call.id, to);
        followReasoning(call.callMessage);
      }
    }

    const droppable = droppableCalls(messages, calls, protectedFrom);
    const newlyDropped: Call[] = [];
    for (const call of droppable) {
      if (toTokens(bytes - dropLineReserve(messages, newlyDropped)) <= target) break;
      if (call.tier >= Tier.Drop) continue;
      bytes -= dropSavings(messages, call) + stripReasoning(messages, call, protectedFrom);
      call.tier = Tier.Drop;
      state.promote(call.id, Tier.Drop);
      newlyDropped.push(call);
    }
    bytes += dropLineReserve(messages, newlyDropped);
  }

  const dropped = calls.filter((call) => call.tier >= Tier.Drop);
  if (dropped.length > 0) {
    // The reserve stood in for these lines while the budget was being met; what
    // they actually cost replaces it now they exist.
    bytes -= dropLineReserve(messages, dropped);
    bytes += applyDrops(messages, dropped);
  }

  return {
    tokens: toTokens(bytes),
    tokensBefore,
    folded: calls.filter((call) => call.tier !== Tier.Verbatim).length,
  };
}

/**
 * Blanks the reasoning that produced a call, reporting the bytes it freed.
 *
 * The reasoning that produced a call is what the model needed to make it, not
 * something it re-reads twenty calls later — so it goes at the same moment,
 * except in the tail the provider requires intact.
 */
function stripReasoning(messages: AgentMessage[], call: Call, protectedFrom: number): number {
  if (call.callMessage >= protectedFrom) return 0;
  return blankReasoning(messages[call.callMessage]);
}

/**
 * Blanks the reasoning of the assistant turns in `[from, through)` that made no
 * tool call, reporting the bytes it freed.
 *
 * Such a turn is unreachable through any call — a reply to the user, or a turn
 * the provider cut off mid-thought — so without this its reasoning is the one
 * thing in the prompt that nothing can ever remove. It weighs more than it
 * looks: the signature is the whole of the model's thinking in encrypted form,
 * and a gateway that replays it charges for every token of it, so one turn
 * truncated at its output limit can cost tens of thousands of tokens on every
 * request for the rest of the session.
 *
 * The range follows the calls rather than the clock, so a turn's reasoning goes
 * when the tool traffic it sits among goes and not before: a conversation small
 * enough never to fold keeps all of it.
 */
function stripOrphanReasoning(messages: AgentMessage[], from: number, through: number): number {
  let saved = 0;
  for (let m = from; m < through; m++) {
    const message = messages[m];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.content.some((part: any) => part?.type === "toolCall")) continue;
    saved += blankReasoning(message);
  }
  return saved;
}

/**
 * Empties every reasoning block of one message, reporting the bytes it freed.
 *
 * Emptying the text rather than removing the block keeps every later index
 * valid; the provider adapter drops a thinking block whose text is blank, and
 * an assistant turn left with nothing else is dropped whole.
 */
function blankReasoning(message: AgentMessage | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let saved = 0;
  for (const block of content) {
    if (block?.type !== "thinking" || block.redacted) continue;
    if (!block.thinking && !block.thinkingSignature) continue;
    saved += byteLength(block.thinking ?? "") + byteLength(block.thinkingSignature ?? "");
    block.thinking = "";
    // The signature is dropped with the text it certifies. The adapter already
    // discards a block whose text is empty, so this changes no request; it is
    // what keeps the estimate saying the same thing the wire does, and the
    // signature is the larger half of what goes.
    block.thinkingSignature = "";
  }
  return saved;
}

/**
 * The oldest calls that can leave without stranding the turn they belong to.
 *
 * A turn goes whole or not at all. Dropping only some of an assistant message's
 * calls leaves the message standing while the results answering them go, and a
 * turn left standing with no results beside it ends up adjacent to another
 * assistant turn — the shape the provider rejects. So a call is droppable only
 * when every call in its message is droppable too and the message carries
 * nothing else: text the model would lose, or reasoning in the tail that has to
 * be replayed intact and so cannot be blanked.
 */
function droppableCalls(messages: AgentMessage[], calls: Call[], protectedFrom: number): Call[] {
  const candidates = calls.slice(0, Math.max(0, calls.length - DROP_KEEP_RECENT));
  const byMessage = new Map<number, Call[]>();
  for (const call of candidates) {
    const group = byMessage.get(call.callMessage);
    if (group) group.push(call);
    else byMessage.set(call.callMessage, [call]);
  }

  const droppable: Call[] = [];
  for (const [index, group] of byMessage) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    let callParts = 0;
    let carriesMore = false;
    for (const part of content) {
      if (part?.type === "toolCall") {
        callParts++;
      } else if (part?.type === "thinking") {
        if (index >= protectedFrom && (part.thinking || part.thinkingSignature)) carriesMore = true;
      } else {
        carriesMore = true;
      }
    }
    // A pinned call is kept out of `calls` entirely, so a message holding one
    // fails this count and stays — which is what pinning is for.
    if (carriesMore || callParts !== group.length) continue;
    droppable.push(...group);
  }
  return droppable;
}

/** What removing a call and the result answering it would take off the prompt. */
function dropSavings(messages: AgentMessage[], call: Call): number {
  let saved = 0;
  const part = callPart(messages, call);
  if (part) saved += toolCallBytes(part);
  const result = messages[call.resultMessage];
  if (result) saved += messagesBytes([result]);
  return saved;
}

/**
 * What the lines standing for `dropped` will cost, charged once per run.
 *
 * Two dropped turns belong to the same run when nothing but the results they
 * are losing lies between them, so a prefix of pure tool traffic collapses to a
 * single line however many calls it held.
 */
function dropLineReserve(messages: AgentMessage[], dropped: Call[]): number {
  const turns = [...new Set(dropped.map((call) => call.callMessage))].sort((a, b) => a - b);
  let runs = 0;
  let previous = -1;
  for (const turn of turns) {
    if (previous < 0 || !onlyResultsBetween(messages, previous, turn)) runs++;
    previous = turn;
  }
  return runs * DROP_LINE_RESERVE_BYTES;
}

function onlyResultsBetween(messages: AgentMessage[], from: number, to: number): boolean {
  for (let m = from + 1; m < to; m++) {
    if (messages[m]?.role !== "toolResult") return false;
  }
  return true;
}

/**
 * Removes dropped calls and their results, leaving one line per run naming what
 * went, and reports what those lines cost.
 *
 * The line lands on the next surviving assistant message rather than in one of
 * its own: an assistant turn and the results answering it leave together, so
 * deleting them keeps the alternation the provider expects, while inserting a
 * message between two assistant turns would break it.
 */
function applyDrops(messages: AgentMessage[], dropped: Call[]): number {
  const ids = new Set(dropped.map((call) => call.id));
  const kept: AgentMessage[] = [];
  let tally = new Map<string, number>();
  let cost = 0;

  const flushInto = (message: AgentMessage): void => {
    if (tally.size === 0) return;
    const text = dropLine(tally);
    (message.content as any[]).unshift({ type: "text", text });
    cost += byteLength(text);
    tally = new Map();
  };

  for (const message of messages) {
    if (message?.role === "toolResult") {
      if (!ids.has(message.toolCallId)) kept.push(message);
      continue;
    }
    const content = message?.content;
    if (!Array.isArray(content)) {
      kept.push(message);
      continue;
    }
    const survivors = content.filter((part: any) => {
      if (part?.type !== "toolCall" || !ids.has(part.id)) return true;
      tally.set(part.name ?? "", (tally.get(part.name ?? "") ?? 0) + 1);
      return false;
    });
    // A turn whose calls have all gone is left holding nothing the model can
    // read: its reasoning was blanked when the calls were folded, and a block
    // with neither text nor signature is already discarded by the adapter.
    // Keeping it would leave two assistant turns adjacent with no result
    // between them, which is the shape the provider rejects.
    const speaks = survivors.some((part: any) => part?.type !== "thinking" || part.thinking || part.thinkingSignature);
    if (!speaks) continue;
    message.content = survivors;
    if (message.role === "assistant") flushInto(message);
    kept.push(message);
  }

  // A run reaching the end of the conversation has no later assistant turn to
  // land on, so it goes on the last one there is.
  if (tally.size > 0) {
    for (let m = kept.length - 1; m >= 0; m--) {
      if (kept[m]?.role !== "assistant" || !Array.isArray(kept[m].content)) continue;
      flushInto(kept[m]);
      break;
    }
  }

  messages.length = 0;
  messages.push(...kept);
  return cost;
}

/** Names what a run of dropped calls was, commonest tool first. */
function dropLine(tally: Map<string, number>): string {
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  const listed = ranked.slice(0, DROP_NAMES_LISTED).map(([name, count]) => `${name} \u00d7${count}`);
  const rest = ranked.length - listed.length;
  if (rest > 0) listed.push(`+${rest} more`);
  return `[dropped ${total} earlier calls: ${listed.join(", ")}]`;
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

  // Ordered by where the call was made, not by when its result arrived: calls
  // issued together are answered in whatever order they finish, and folding
  // oldest-first has to mean oldest as the conversation reads.
  calls.sort((a, b) => a.callMessage - b.callMessage || a.callPart - b.callPart);
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

/**
 * What full folding would still be able to remove from here.
 *
 * Drop is part of "full", so a call old enough to leave counts for everything it
 * weighs rather than for the breadcrumb it would otherwise be stuck at. This is
 * what keeps the floor — and with it the ceiling standing above the floor —
 * from rising with every call a long session makes.
 */
function foldableBytes(messages: AgentMessage[], calls: Call[], protectedFrom: number): number {
  let savings = 0;
  // Parallel calls share one assistant message, and its reasoning goes with
  // whichever of them is promoted first, so counting it once per call would
  // overstate what is left to remove and put the floor below where folding can
  // actually land.
  const countedThinking = new Set<number>();
  const droppable = new Set(droppableCalls(messages, calls, protectedFrom).map((call) => call.id));
  const droppedHere: Call[] = [];
  for (const call of calls) {
    if (call.tier >= Tier.Drop) continue;
    if (call.callMessage < protectedFrom && !countedThinking.has(call.callMessage)) {
      countedThinking.add(call.callMessage);
      savings += thinkingBytes(messages[call.callMessage]);
    }
    if (droppable.has(call.id)) {
      savings += dropSavings(messages, call);
      droppedHere.push(call);
      continue;
    }
    if (call.tier >= Tier.Breadcrumb) continue;
    const part = callPart(messages, call);
    if (part) savings += jsonBytesOf(part.arguments) - jsonBytesOf({});
    const result = messages[call.resultMessage];
    if (!result) continue;
    const breadcrumb = byteLength(result.toolName ?? "") + byteLength(result.toolCallId ?? "")
      + byteLength(collapseResult(call, false, Tier.Breadcrumb)[0].text);
    savings += Math.max(0, messagesBytes([result]) - breadcrumb);
  }
  // What full folding leaves behind includes the lines standing for what left.
  // A turn that made no call is folded with the traffic around it, so the
  // reasoning full folding reaches is what lies below the newest call.
  savings += orphanReasoningBytes(messages, reasoningThrough(calls, protectedFrom));
  return Math.max(0, savings - dropLineReserve(messages, droppedHere));
}

/** How far into the conversation a full fold blanks reasoning of its own. */
function reasoningThrough(calls: Call[], protectedFrom: number): number {
  if (calls.length === 0) return 0;
  return Math.min(calls[calls.length - 1].callMessage, protectedFrom);
}

/** What the reasoning of the callless assistant turns below `through` weighs. */
function orphanReasoningBytes(messages: AgentMessage[], through: number): number {
  let size = 0;
  for (let m = 0; m < through; m++) {
    const message = messages[m];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.content.some((part: any) => part?.type === "toolCall")) continue;
    size += thinkingBytes(message);
  }
  return size;
}

/**
 * What a message's reasoning weighs, signatures included.
 *
 * The signature is opaque base64 several times the size of the text it
 * certifies, and it goes when the text goes: a block left with a signature and
 * no text is dropped whole by the provider adapter, so counting only the text
 * as foldable leaves the larger half sitting in the floor as though nothing
 * could ever move it.
 *
 * Redacted reasoning is the exception and is left alone: there the signature is
 * the payload the provider replays, not a certificate attached to text.
 */
function thinkingBytes(message: AgentMessage | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (block?.type !== "thinking" || block.redacted) continue;
    size += byteLength(block.thinking ?? "") + byteLength(block.thinkingSignature ?? "");
  }
  return size;
}

/** Rewrites one call's parts to match a tier, returning the bytes it saved. */
function applyTier(messages: AgentMessage[], call: Call, to: Tier, protectedFrom: number): number {
  let saved = 0;

  const part = callPart(messages, call);
  if (part) {
    const before = jsonBytesOf(part.arguments);
    part.arguments = to >= Tier.Breadcrumb ? {} : trimArgs(part.arguments, call.id);
    saved += before - jsonBytesOf(part.arguments);
  }

  saved += stripReasoning(messages, call, protectedFrom);

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
  let text = "";
  let bytes = 0;
  for (const part of call.resultContent) {
    if (part?.type === "text") {
      text += part.text ?? "";
      bytes += byteLength(part.text ?? "");
      continue;
    }
    // An image's payload is most of what a result of this kind costs, so a
    // notice that counted only its caption would understate what went.
    if (part?.type === "image") bytes += (part.data ?? "").length;
  }
  // A failure is worth more than a success of the same size: it is what stops
  // the model repeating a call that cannot work, so a digested one keeps both
  // ends of its text where a digested success keeps none.
  if (isError && to < Tier.Breadcrumb) return [{ type: "text", text: clampEnds(text, call.id) }];
  return [{ type: "text", text: omission(bytes, call.id) }];
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
function trimArgs(args: unknown, callId: string): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return (args ?? {}) as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    const value = Array.isArray(raw) && raw.length > ARG_LIST_KEEP
      ? [...raw.slice(0, ARG_LIST_KEEP), `[dropped ${raw.length - ARG_LIST_KEEP} more; ${callId}]`]
      : raw;
    const encoded = typeof value === "string" ? value : jsonText(value);
    const size = byteLength(encoded);
    const cap = CONTENT_ARG_KEYS.has(key) ? ARG_CONTENT_BYTES : ARG_LEAF_BYTES;
    if (size <= cap) {
      trimmed[key] = value;
      continue;
    }
    // The notice names the call so the whole value can be asked for back, and
    // is worded as a notice rather than as an ellipsis: what stood here was
    // content, and a cut that still looks like content gets reproduced as if
    // it were the whole of it.
    trimmed[key] = `${cutBytes(encoded, cap)}[args cut: ${size - cap}B; ${callId}]`;
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
