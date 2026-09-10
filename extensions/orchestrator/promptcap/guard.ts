import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { danglingSignatureBytes, Estimator, fixedBytes, messagesBytes } from "./estimate.js";
import { fold, FoldState, incompressibleTokens, tokensOf, type AgentMessage } from "./fold.js";
import { limitsFor, OVERFLOW_MARGIN, type PromptcapSettings } from "./limits.js";

export interface GuardHost {
  settings(): PromptcapSettings;
  notify?(message: string, level: "info" | "warning" | "error"): void;
  log?(event: Record<string, unknown>, message: string): void;
}

/**
 * Holds each prompt inside the limits its model was given, and learns what its
 * estimate is worth from what the provider charges.
 *
 * Folding runs on the copy the host hands the `context` event, which is the
 * last thing to touch the conversation before it becomes an LLM request. The
 * stored session is never edited, so the transcript, the UI and recall all see
 * every byte.
 */
export class PromptGuard {
  private readonly estimator = new Estimator();
  private readonly folds = new FoldState();
  private predicted: { modelKey: string; tokens: number; rawTokens: number; danglingSignatures: number } | null = null;
  /** The size the last fold settled on, for the footer and the menu. */
  lastTokens: number | null = null;
  lastCeiling: number | null = null;

  constructor(private readonly host: GuardHost) {}

  /** Called when the conversation is replaced wholesale, not merely extended. */
  reset(): void {
    this.folds.clear();
    this.predicted = null;
    this.lastTokens = null;
    this.lastCeiling = null;
  }

  apply(messages: AgentMessage[], ctx: any, tools: unknown[]): AgentMessage[] {
    const settings = this.host.settings();
    const modelKey = modelKeyOf(ctx);
    const systemPrompt = typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
    const fixed = fixedBytes(systemPrompt, tools);
    const ratio = this.estimator.ratioFor(modelKey) ?? 1;

    const window = ctx?.getContextUsage?.()?.contextWindow;
    const floor = incompressibleTokens(messages, fixed, ratio);
    const limits = limitsFor(settings, modelKey, floor, typeof window === "number" ? window : undefined);

    if (!settings.enabled) {
      this.lastTokens = null;
      this.lastCeiling = null;
      return messages;
    }

    const result = fold(messages, fixed, limits, this.folds, ratio);
    // Carried to calibration so one real turn can answer whether reasoning
    // blocks left with a signature and no text reach the provider: the adapters
    // disagree, and this is the difference the answer would show up as. Scaled
    // by the same learned ratio as the prediction it will be subtracted from,
    // or the two would be in different units and the comparison would mean
    // nothing on any model that has learned a ratio.
    const dangling = tokensOf(danglingSignatureBytes(messages), ratio);
    // The raw count is what the next charge is measured against: a ratio
    // learned from a prediction the last ratio already scaled would fold its
    // own correction back in.
    this.predicted = {
      modelKey,
      tokens: result.tokens,
      rawTokens: tokensOf(fixed + messagesBytes(messages), 1),
      danglingSignatures: dangling,
    };
    this.lastTokens = result.tokens;
    this.lastCeiling = limits.ceiling;

    if (result.tokens < result.tokensBefore) {
      this.host.log?.(
        { s: "promptcap", model: modelKey, before: result.tokensBefore, after: result.tokens, ceiling: limits.ceiling, folded: result.folded },
        "folded old tool calls to fit the model's window",
      );
    }

    // Prose is never folded, so a conversation can outgrow its window on prose
    // alone. Warning rather than refusing keeps the turn the provider might
    // still accept: the estimate is an approximation, and the alternative is a
    // dead session with no way out but a new one.
    if (result.tokens > limits.ceiling * OVERFLOW_MARGIN) {
      this.host.log?.({ s: "promptcap", model: modelKey, tokens: result.tokens, ceiling: limits.ceiling }, "the conversation does not fit even fully folded");
      this.host.notify?.(
        `This conversation no longer fits the model's window even with old tool calls folded away (~${Math.round(result.tokens / 1000)}K of ~${Math.round(limits.ceiling / 1000)}K). Start a new session, or switch to a model with a larger window.`,
        "warning",
      );
    }

    return messages;
  }

  /** Teaches the estimator what the prompt it sized actually cost. */
  calibrate(charged: number, modelKey: string): void {
    const predicted = this.predicted;
    this.predicted = null;
    if (!predicted || charged <= 0) return;
    // A turn answered by a model other than the one the prompt was sized for
    // teaches the wrong estimator: the fallback path switches providers between
    // the fold and the response.
    if (predicted.modelKey !== modelKey) return;
    if (predicted.danglingSignatures > 0) {
      this.host.log?.(
        {
          s: "promptcap",
          model: modelKey,
          predicted: predicted.tokens,
          charged,
          danglingSignatures: predicted.danglingSignatures,
          predictedWithout: predicted.tokens - predicted.danglingSignatures,
        },
        "signature-only reasoning blocks were in the prompt: charged sits at whichever prediction it matches",
      );
    }
    this.estimator.observe(modelKey, predicted.rawTokens, charged);
  }

  ratioFor(modelKey: string): number | undefined {
    return this.estimator.ratioFor(modelKey);
  }
}

export function modelKeyOf(ctx: any): string {
  const provider = ctx?.model?.provider;
  const id = ctx?.model?.id;
  if (provider && id) return `${provider}/${id}`;
  return id ?? "";
}

/**
 * Wires a guard into a session. `context` fires immediately before every LLM
 * call with a copy of the conversation; `turn_end` reports what the provider
 * charged for the prompt that copy became.
 */
export function registerPromptGuard(pi: ExtensionAPI, guard: PromptGuard): void {
  pi.on("context", (event, ctx) => {
    const messages = event?.messages as AgentMessage[] | undefined;
    if (!Array.isArray(messages)) return undefined;
    return { messages: guard.apply(messages, ctx, activeTools(pi)) as any };
  });

  pi.on("turn_end", (event: any, ctx) => {
    const usage = event?.message?.usage;
    if (!usage) return;
    const charged = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    guard.calibrate(charged, modelKeyOf(ctx));
  });
}

function activeTools(pi: ExtensionAPI): unknown[] {
  if (typeof pi.getAllTools !== "function") return [];
  const active = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
  return pi
    .getAllTools()
    .filter((tool) => active.size === 0 || active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}
