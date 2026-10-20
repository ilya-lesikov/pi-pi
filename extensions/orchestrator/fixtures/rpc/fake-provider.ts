import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A model provider for the RPC conformance tests: it answers from a script
 * in PP_FAKE_SCRIPT instead of the network. Each step is either text or one
 * tool call; the step is chosen by how many assistant messages the context
 * already has, so a re-sent request gets the same answer.
 */
type Step = { text: string } | { tool: string; args: Record<string, unknown> };

function script(): Step[] {
  try {
    return JSON.parse(process.env.PP_FAKE_SCRIPT ?? "[]");
  } catch {
    return [];
  }
}

function stream(model: Model<any>, context: Context) {
  const out = createAssistantMessageEventStream();
  const steps = script();
  const index = context.messages.filter((message: any) => message.role === "assistant").length;
  const step = steps[index] ?? { text: "done" };
  const message: AssistantMessage = {
    role: "assistant",
    content: "tool" in step ? [{ type: "toolCall", id: `call-${index}`, name: step.tool, arguments: step.args }] : [{ type: "text", text: step.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "tool" in step ? "toolUse" : "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
  // Recorded for the test: what the model was actually sent.
  if (process.env.PP_FAKE_LOG) {
    void import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.PP_FAKE_LOG!, `${JSON.stringify(context.messages)}\n`));
  }
  queueMicrotask(() => {
    out.push({ type: "start", partial: message });
    out.push({ type: "done", reason: message.stopReason as any, message });
    out.end();
  });
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("pp-fake", {
    baseUrl: "http://localhost:0",
    apiKey: "fake",
    api: "pp-fake-api" as any,
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple: stream as any,
  });
}
