import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUB_MODEL_PREFIX, SUB_PROVIDER } from "./flant-infra.js";

/**
 * A usage unit is subscription-routed (flat-rate personal Claude subscription,
 * not per-token billed) when its main-turn provider is the subscription
 * provider, or when the registered model id carries the `sub/` prefix. The
 * prefix is the only signal available for subagents (subagents:completed has no
 * provider field), so we always check it in addition to the provider.
 */
export function isSubscriptionRouted(modelId?: string, provider?: string): boolean {
  if (provider === SUB_PROVIDER) return true;
  return typeof modelId === "string" && modelId.startsWith(SUB_MODEL_PREFIX);
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSupported: boolean;
  turns: number;
  /** Flat-rate personal subscription: dollars are excluded from cost totals, tokens are not. */
  subscription: boolean;
}

export interface UsageTracker {
  recordTurn(modelId: string, provider: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, cacheSupported?: boolean): void;
  recordSubagentCompletion(tokens: { input?: number; output?: number; total?: number }, cost?: number, meta?: { description?: string; agentType?: string; modelId?: string; durationMs?: number; toolUses?: number }): void;
  loadFromSummary(summary: Record<string, unknown>): void;
  getTotalInputTokens(): number;
  getTotalOutputTokens(): number;
  getTotalCacheReadTokens(): number;
  getTotalCacheWriteTokens(): number;
  /** Total input the model actually processed: uncached input + cache read + cache write (main + subagents). */
  getTotalProcessedInputTokens(): number;
  getTotalCost(): number;
  getMainInputTokens(): number;
  getMainOutputTokens(): number;
  getMainCacheReadTokens(): number;
  getMainCacheWriteTokens(): number;
  getMainCost(): number;
  getCacheHitRate(): number;
  isCacheSupported(): boolean;
  getPerModelUsage(): Record<string, ModelUsage>;
  getSubagentTotals(): { inputTokens: number; outputTokens: number; cost: number };
  getSubagentList(): SubagentUsage[];
  toSummary(): object;
  reset(): void;
}

export interface SubagentUsage {
  description: string;
  agentType: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSupported: boolean;
  cost: number;
  durationMs: number;
  toolUses: number;
  /** Flat-rate personal subscription: dollars are excluded from cost totals, tokens are not. */
  subscription: boolean;
}

interface TrackerState {
  startedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
  totalTurns: number;
  subagentInputTokens: number;
  subagentOutputTokens: number;
  subagentCacheReadTokens: number;
  subagentCacheWriteTokens: number;
  subagentCost: number;
  models: Map<string, ModelUsage>;
  subagents: SubagentUsage[];
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resolveAgentDir(): string {
  const envKey = "PI_CODING_AGENT_DIR";
  const envDir = process.env[envKey];
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

function createInitialState(): TrackerState {
  return {
    startedAt: new Date().toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: 0,
    totalTurns: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheReadTokens: 0,
    subagentCacheWriteTokens: 0,
    subagentCost: 0,
    models: new Map<string, ModelUsage>(),
    subagents: [],
  };
}

export function createUsageTracker(): UsageTracker {
  const state = createInitialState();

  return {
    recordTurn(modelId: string, provider: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, cacheSupported?: boolean): void {
      const safeInput = toFiniteNumber(input);
      const safeOutput = toFiniteNumber(output);
      const safeCacheRead = toFiniteNumber(cacheRead);
      const safeCacheWrite = toFiniteNumber(cacheWrite);
      const subscription = isSubscriptionRouted(modelId, provider);
      // Subscription-routed turns are flat-rate: keep the tokens but exclude the
      // fictitious per-token dollars so totals stay paid-only by construction.
      const safeCost = subscription ? 0 : toFiniteNumber(cost);

      state.totalInputTokens += safeInput;
      state.totalOutputTokens += safeOutput;
      state.totalCacheReadTokens += safeCacheRead;
      state.totalCacheWriteTokens += safeCacheWrite;
      state.totalCost += safeCost;
      state.totalTurns += 1;

      // Key subscription turns under the sub/ prefix even when detected only by
      // provider (bare model id), so a paid and a subscription turn for the same
      // underlying model never share a row and the paid dollars stay visible.
      const baseKey = modelId || "unknown-model";
      const key = subscription && !baseKey.startsWith(SUB_MODEL_PREFIX) ? `${SUB_MODEL_PREFIX}${baseKey}` : baseKey;
      const usage = state.models.get(key) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheSupported: false,
        turns: 0,
        subscription: false,
      };

      usage.inputTokens += safeInput;
      usage.outputTokens += safeOutput;
      usage.cacheReadTokens += safeCacheRead;
      usage.cacheWriteTokens += safeCacheWrite;
      if (cacheSupported) usage.cacheSupported = true;
      if (subscription) usage.subscription = true;
      usage.turns += 1;
      state.models.set(key, usage);
    },

    recordSubagentCompletion(
      tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; cost?: number },
      cost?: number,
      meta?: { description?: string; agentType?: string; modelId?: string; durationMs?: number; toolUses?: number },
    ): void {
      const safeInput = toFiniteNumber(tokens.input);
      const safeOutput = toFiniteNumber(tokens.output);
      const safeTotal = toFiniteNumber(tokens.total);
      const safeCacheRead = toFiniteNumber(tokens.cacheRead);
      const safeCacheWrite = toFiniteNumber(tokens.cacheWrite);
      // Subagents carry no provider field, so detect subscription routing from
      // the registered model id prefix. Zero the dollars when subscription.
      const subscription = isSubscriptionRouted(meta?.modelId);
      const safeCost = subscription ? 0 : toFiniteNumber(tokens.cost ?? cost);

      const effectiveInput = safeInput === 0 && safeOutput === 0 ? safeTotal : safeInput;

      state.subagentInputTokens += effectiveInput;
      state.subagentOutputTokens += safeOutput;
      state.subagentCacheReadTokens += safeCacheRead;
      state.subagentCacheWriteTokens += safeCacheWrite;
      state.subagentCost += safeCost;

      const cacheSupported = typeof tokens.cacheRead === "number" || typeof tokens.cacheWrite === "number";

      state.subagents.push({
        description: meta?.description ?? "unknown",
        agentType: meta?.agentType ?? "unknown",
        modelId: meta?.modelId ?? "unknown",
        inputTokens: effectiveInput,
        outputTokens: safeOutput,
        cacheReadTokens: safeCacheRead,
        cacheWriteTokens: safeCacheWrite,
        cacheSupported,
        cost: safeCost,
        durationMs: toFiniteNumber(meta?.durationMs),
        toolUses: toFiniteNumber(meta?.toolUses),
        subscription,
      });
    },

    loadFromSummary(summary: Record<string, unknown>): void {
      const totals = summary.totals as Record<string, unknown> | undefined;
      const subagents = summary.subagents as Record<string, unknown> | undefined;
      const models = summary.models as Record<string, Record<string, unknown>> | undefined;
      if (totals) {
        state.totalInputTokens = toFiniteNumber(totals.inputTokens);
        state.totalOutputTokens = toFiniteNumber(totals.outputTokens);
        state.totalCacheReadTokens = toFiniteNumber(totals.cacheReadTokens);
        state.totalCacheWriteTokens = toFiniteNumber(totals.cacheWriteTokens);
        state.totalCost = toFiniteNumber(totals.cost);
        state.totalTurns = toFiniteNumber(totals.turns);
      }
      if (Array.isArray(summary.subagents)) {
        state.subagents = [];
        state.subagentInputTokens = 0;
        state.subagentOutputTokens = 0;
        state.subagentCacheReadTokens = 0;
        state.subagentCacheWriteTokens = 0;
        state.subagentCost = 0;
        for (const sa of summary.subagents as Record<string, unknown>[]) {
          const modelId = typeof sa.modelId === "string" ? sa.modelId : "unknown";
          // Pre-change summaries lack the flag; recover it from the sub/ prefix
          // so legacy subscription rows are not restored as paid.
          const subscription = sa.subscription === true || isSubscriptionRouted(modelId);
          const entry: SubagentUsage = {
            description: typeof sa.description === "string" ? sa.description : "unknown",
            agentType: typeof sa.agentType === "string" ? sa.agentType : "unknown",
            modelId,
            inputTokens: toFiniteNumber(sa.inputTokens),
            outputTokens: toFiniteNumber(sa.outputTokens),
            cacheReadTokens: toFiniteNumber(sa.cacheReadTokens),
            cacheWriteTokens: toFiniteNumber(sa.cacheWriteTokens),
            cacheSupported: sa.cacheSupported === true,
            cost: subscription ? 0 : toFiniteNumber(sa.cost),
            durationMs: toFiniteNumber(sa.durationMs),
            toolUses: toFiniteNumber(sa.toolUses),
            subscription,
          };
          state.subagents.push(entry);
          state.subagentInputTokens += entry.inputTokens;
          state.subagentOutputTokens += entry.outputTokens;
          state.subagentCacheReadTokens += entry.cacheReadTokens;
          state.subagentCacheWriteTokens += entry.cacheWriteTokens;
          state.subagentCost += entry.cost;
        }
      }
      if (models) {
        for (const [modelId, usage] of Object.entries(models)) {
          state.models.set(modelId, {
            inputTokens: toFiniteNumber(usage.inputTokens),
            outputTokens: toFiniteNumber(usage.outputTokens),
            cacheReadTokens: toFiniteNumber(usage.cacheReadTokens),
            cacheWriteTokens: toFiniteNumber(usage.cacheWriteTokens),
            cacheSupported: (usage as any).cacheSupported === true,
            turns: toFiniteNumber(usage.turns),
            subscription: (usage as any).subscription === true || isSubscriptionRouted(modelId),
          });
        }
      }
      if (typeof summary.startedAt === "string") {
        state.startedAt = summary.startedAt;
      }
    },

    getTotalInputTokens(): number {
      return state.totalInputTokens + state.subagentInputTokens;
    },

    getTotalOutputTokens(): number {
      return state.totalOutputTokens + state.subagentOutputTokens;
    },

    getTotalCacheReadTokens(): number {
      return state.totalCacheReadTokens + state.subagentCacheReadTokens;
    },

    getTotalCacheWriteTokens(): number {
      return state.totalCacheWriteTokens + state.subagentCacheWriteTokens;
    },

    getTotalProcessedInputTokens(): number {
      return (
        state.totalInputTokens +
        state.subagentInputTokens +
        state.totalCacheReadTokens +
        state.subagentCacheReadTokens +
        state.totalCacheWriteTokens +
        state.subagentCacheWriteTokens
      );
    },

    getTotalCost(): number {
      return state.totalCost + state.subagentCost;
    },

    getMainInputTokens(): number {
      return state.totalInputTokens;
    },

    getMainOutputTokens(): number {
      return state.totalOutputTokens;
    },

    getMainCacheReadTokens(): number {
      return state.totalCacheReadTokens;
    },

    getMainCacheWriteTokens(): number {
      return state.totalCacheWriteTokens;
    },

    getMainCost(): number {
      return state.totalCost;
    },

    getCacheHitRate(): number {
      const totalCacheRead = state.totalCacheReadTokens + state.subagentCacheReadTokens;
      // Session-wide, token-weighted average: cache reads over all processed
      // input (uncached input + cache read + cache write). Including cache
      // writes keeps first-touch (uncached) content from inflating the rate.
      const denominator = this.getTotalProcessedInputTokens();
      if (denominator <= 0) return 0;
      return totalCacheRead / denominator;
    },

    isCacheSupported(): boolean {
      for (const usage of state.models.values()) {
        if (usage.cacheSupported) return true;
      }
      return state.subagents.some((sa) => sa.cacheSupported);
    },

    getPerModelUsage(): Record<string, ModelUsage> {
      const out: Record<string, ModelUsage> = {};
      for (const [model, usage] of state.models.entries()) {
        out[model] = { ...usage };
      }
      return out;
    },

    getSubagentTotals(): { inputTokens: number; outputTokens: number; cost: number } {
      return {
        inputTokens: state.subagentInputTokens,
        outputTokens: state.subagentOutputTokens,
        cost: state.subagentCost,
      };
    },

    getSubagentList(): SubagentUsage[] {
      return [...state.subagents];
    },

    toSummary(): object {
      return {
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        totals: {
          inputTokens: state.totalInputTokens,
          outputTokens: state.totalOutputTokens,
          cacheReadTokens: state.totalCacheReadTokens,
          cacheWriteTokens: state.totalCacheWriteTokens,
          cost: Number(state.totalCost.toFixed(6)),
          turns: state.totalTurns,
        },
        subagents: [...state.subagents],
        models: this.getPerModelUsage(),
      };
    },

    reset(): void {
      const next = createInitialState();
      state.startedAt = next.startedAt;
      state.totalInputTokens = 0;
      state.totalOutputTokens = 0;
      state.totalCacheReadTokens = 0;
      state.totalCacheWriteTokens = 0;
      state.totalCost = 0;
      state.totalTurns = 0;
      state.subagentInputTokens = 0;
      state.subagentOutputTokens = 0;
      state.subagentCacheReadTokens = 0;
      state.subagentCacheWriteTokens = 0;
      state.subagentCost = 0;
      state.models.clear();
      state.subagents = [];
    },
  };
}

export function loadUsageSummary(sessionId: string): Record<string, unknown> | null {
  const usageDir = join(resolveAgentDir(), "extensions", "pp", "usage");
  const filePath = join(usageDir, `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function dumpUsageSummary(tracker: UsageTracker, sessionId: string): void {
  const usageDir = join(resolveAgentDir(), "extensions", "pp", "usage");
  mkdirSync(usageDir, { recursive: true });

  const summary = tracker.toSummary() as Record<string, unknown>;
  const payload = {
    sessionId,
    ...summary,
  };

  const outPath = join(usageDir, `${sessionId}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}
