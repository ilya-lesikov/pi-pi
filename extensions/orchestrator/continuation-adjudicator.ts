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

const ADJUDICATION_TIMEOUT_MS = 60_000;

export function parseAdjudication(text: string): boolean {
  return /^[^a-z0-9]*yes\b/i.test(text.trim());
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
 * Replay the finished turn to its own model with a yes/no question appended.
 * The system prompt, tools and messages are the ones the turn itself ran with,
 * so the provider serves the shared prefix from its prompt cache.
 */
export function buildAdjudicationContext(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any): any {
  const active = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
  const tools = (typeof pi.getAllTools === "function" ? pi.getAllTools() : [])
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const history = convertToLlm([...contextMessages, finalMessage].filter(Boolean) as any);
  return {
    systemPrompt: typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined,
    tools: tools.length > 0 ? tools : undefined,
    messages: [...history, { role: "user", content: [{ type: "text", text: ADJUDICATION_QUESTION }], timestamp: Date.now() }],
  };
}

/**
 * Whether the finished turn left work the agent can pick up by itself. Any
 * failure answers no: a missed continuation costs a turn the user can ask for,
 * an unwarranted one restarts work they consider finished.
 */
export async function adjudicateContinuation(pi: ExtensionAPI, ctx: any, contextMessages: any[], finalMessage: any): Promise<boolean> {
  const log = getLogger();
  const registry = ctx?.modelRegistry;
  const model = ctx?.model;
  if (!model || !registry) {
    log.debug({ s: "continuation" }, "no completion surface for the continuation check");
    return false;
  }
  try {
    const context = buildAdjudicationContext(pi, ctx, contextMessages, finalMessage);
    const options = { maxTokens: 16, signal: AbortSignal.timeout(ADJUDICATION_TIMEOUT_MS) };
    // The host's own one-shot completion resolves auth and headers itself; the
    // provider call below is the path for hosts whose registry predates it.
    let result: any;
    if (typeof registry.complete === "function") {
      result = await registry.complete(model, context, options);
    } else if (typeof registry.getApiKeyAndHeaders === "function" && typeof completeSimple === "function") {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth?.ok) return false;
      result = await completeSimple(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
    } else {
      log.debug({ s: "continuation" }, "no completion surface for the continuation check");
      return false;
    }
    const answer = responseText(result);
    log.debug({ s: "continuation", answer }, "continuation check answered");
    return parseAdjudication(answer);
  } catch (error: any) {
    log.debug({ s: "continuation", err: error?.message }, "continuation check failed");
    return false;
  }
}
