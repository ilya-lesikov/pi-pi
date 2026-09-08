import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { getLogger } from "./log.js";

// Asked out of band, so the answer never enters the session. Kept to one word
// because the reply is parsed, not read: anything but a leading YES is a no.
const ADJUDICATION_QUESTION = [
  "[PI-PI] Out-of-band check — this message is not part of the conversation and your answer is discarded.",
  "Answer with exactly one word, YES or NO, and call no tools.",
  "YES if you stopped before the user's request was carried out and can continue on your own.",
  "NO if the request is done, if what remains needs the user's answer, approval or a decision, or if you are reporting a blocker.",
  "NO if the user's last message asked you something and this turn answered it: they have to react to your answer before you carry on, however much of their request is still undone.",
].join("\n");

// A turn that ends with a question stops the session dead, so the one thing
// worth knowing is whether the user actually has to answer it.
const CHECK_IN_QUESTION = [
  "[PI-PI] Out-of-band check — this message is not part of the conversation and your answer is discarded.",
  "You ended that turn with a question. Answer with exactly one word, BLOCKING or OPTIONAL, and call no tools.",
  "BLOCKING if you cannot go on without the user: the choice is theirs to make, or you are handing back a blocker.",
  "BLOCKING if the user's own message asked you something and this turn answered it, or if you are putting an approach to them that they have not approved yet — either way they react before you carry on.",
  "OPTIONAL if you could settle it yourself under the safest reversible reading and keep working — a progress check, an offer to reorder your own queue, or permission for something the user already approved.",
].join("\n");

const ADJUDICATION_TIMEOUT_MS = 60_000;

export function parseAdjudication(text: string): boolean {
  return /^[^a-z0-9]*yes\b/i.test(text.trim());
}

/** Only an unhedged OPTIONAL overrides a stop the agent chose deliberately. */
export function parseCheckInAdjudication(text: string): boolean {
  return /^[^a-z0-9]*optional\b/i.test(text.trim());
}

function responseText(message: any): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("")
    .trim();
}

/**
 * Replay the finished turn to its own model with a one-word question appended.
 * The system prompt, tools and messages are the ones the turn itself ran with,
 * so the provider serves the shared prefix from its prompt cache.
 */
export function buildAdjudicationContext(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any, question: string = ADJUDICATION_QUESTION): any {
  const active = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
  const tools = (typeof pi.getAllTools === "function" ? pi.getAllTools() : [])
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const history = convertToLlm([...contextMessages, finalMessage].filter(Boolean) as any);
  return {
    systemPrompt: typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined,
    tools: tools.length > 0 ? tools : undefined,
    messages: [...history, { role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() }],
  };
}

async function askOutOfBand(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any, question: string): Promise<string | undefined> {
  const log = getLogger();
  const registry = ctx?.modelRegistry;
  const model = ctx?.model;
  if (!model || !registry) {
    log.debug({ s: "continuation" }, "no completion surface for the continuation check");
    return undefined;
  }
  try {
    const context = buildAdjudicationContext(pi, ctx, contextMessages, finalMessage, question);
    const options = { maxTokens: 16, signal: AbortSignal.timeout(ADJUDICATION_TIMEOUT_MS) };
    // The host's own one-shot completion resolves auth and headers itself; the
    // provider call below is the path for hosts whose registry predates it.
    let result: any;
    if (typeof registry.complete === "function") {
      result = await registry.complete(model, context, options);
    } else if (typeof registry.getApiKeyAndHeaders === "function" && typeof completeSimple === "function") {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth?.ok) return undefined;
      result = await completeSimple(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
    } else {
      log.debug({ s: "continuation" }, "no completion surface for the continuation check");
      return undefined;
    }
    const answer = responseText(result);
    log.debug({ s: "continuation", answer }, "continuation check answered");
    return answer;
  } catch (error: any) {
    log.debug({ s: "continuation", err: error?.message }, "continuation check failed");
    return undefined;
  }
}

/**
 * Whether the finished turn left work the agent can pick up by itself. Any
 * failure answers no: a missed continuation costs a turn the user can ask for,
 * an unwarranted one restarts work they consider finished.
 */
export async function adjudicateContinuation(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any): Promise<boolean> {
  const answer = await askOutOfBand(pi, ctx, contextMessages, finalMessage, ADJUDICATION_QUESTION);
  return answer === undefined ? false : parseAdjudication(answer);
}

/**
 * Whether the question the turn ended on was one the agent could have settled
 * itself. Any failure answers no, which leaves the question standing.
 */
export async function adjudicateCheckIn(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any): Promise<boolean> {
  const answer = await askOutOfBand(pi, ctx, contextMessages, finalMessage, CHECK_IN_QUESTION);
  return answer === undefined ? false : parseCheckInAdjudication(answer);
}
