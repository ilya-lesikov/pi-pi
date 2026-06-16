import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export interface UsageTracker {
  recordTurn(modelId: string, provider: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): void;
  recordSubagentCompletion(tokens: { input?: number; output?: number; total?: number }, cost?: number, meta?: { description?: string; modelId?: string; durationMs?: number; toolUses?: number }): void;
  loadFromSummary(summary: Record<string, unknown>): void;
  getTotalInputTokens(): number;
  getTotalOutputTokens(): number;
  getTotalCacheReadTokens(): number;
  getTotalCacheWriteTokens(): number;
  getTotalCost(): number;
  getCacheHitRate(): number;
  getPerModelUsage(): Record<string, ModelUsage>;
  getSubagentTotals(): { inputTokens: number; outputTokens: number; cost: number };
  getSubagentList(): SubagentUsage[];
  toSummary(): object;
  reset(): void;
}

export interface SubagentUsage {
  description: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  toolUses: number;
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
    subagentCost: 0,
    models: new Map<string, ModelUsage>(),
    subagents: [],
  };
}

export function createUsageTracker(): UsageTracker {
  const state = createInitialState();

  return {
    recordTurn(modelId: string, _provider: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): void {
      const safeInput = toFiniteNumber(input);
      const safeOutput = toFiniteNumber(output);
      const safeCacheRead = toFiniteNumber(cacheRead);
      const safeCacheWrite = toFiniteNumber(cacheWrite);
      const safeCost = toFiniteNumber(cost);

      state.totalInputTokens += safeInput;
      state.totalOutputTokens += safeOutput;
      state.totalCacheReadTokens += safeCacheRead;
      state.totalCacheWriteTokens += safeCacheWrite;
      state.totalCost += safeCost;
      state.totalTurns += 1;

      const key = modelId || "unknown-model";
      const usage = state.models.get(key) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 0,
      };

      usage.inputTokens += safeInput;
      usage.outputTokens += safeOutput;
      usage.cacheReadTokens += safeCacheRead;
      usage.cacheWriteTokens += safeCacheWrite;
      usage.turns += 1;
      state.models.set(key, usage);
    },

    recordSubagentCompletion(
      tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; cost?: number },
      cost?: number,
      meta?: { description?: string; modelId?: string; durationMs?: number; toolUses?: number },
    ): void {
      const safeInput = toFiniteNumber(tokens.input);
      const safeOutput = toFiniteNumber(tokens.output);
      const safeTotal = toFiniteNumber(tokens.total);
      const safeCacheRead = toFiniteNumber(tokens.cacheRead);
      const safeCacheWrite = toFiniteNumber(tokens.cacheWrite);
      const safeCost = toFiniteNumber(tokens.cost ?? cost);

      const effectiveInput = safeInput === 0 && safeOutput === 0 ? safeTotal : safeInput;

      state.subagentInputTokens += effectiveInput;
      state.subagentOutputTokens += safeOutput;
      state.subagentCost += safeCost;

      state.subagents.push({
        description: meta?.description ?? "unknown",
        modelId: meta?.modelId ?? "unknown",
        inputTokens: effectiveInput,
        outputTokens: safeOutput,
        cacheReadTokens: safeCacheRead,
        cacheWriteTokens: safeCacheWrite,
        cost: safeCost,
        durationMs: toFiniteNumber(meta?.durationMs),
        toolUses: toFiniteNumber(meta?.toolUses),
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
        for (const sa of summary.subagents as Record<string, unknown>[]) {
          const entry: SubagentUsage = {
            description: typeof sa.description === "string" ? sa.description : "unknown",
            modelId: typeof sa.modelId === "string" ? sa.modelId : "unknown",
            inputTokens: toFiniteNumber(sa.inputTokens),
            outputTokens: toFiniteNumber(sa.outputTokens),
            cacheReadTokens: toFiniteNumber(sa.cacheReadTokens),
            cacheWriteTokens: toFiniteNumber(sa.cacheWriteTokens),
            cost: toFiniteNumber(sa.cost),
            durationMs: toFiniteNumber(sa.durationMs),
            toolUses: toFiniteNumber(sa.toolUses),
          };
          state.subagents.push(entry);
          state.subagentInputTokens += entry.inputTokens;
          state.subagentOutputTokens += entry.outputTokens;
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
            turns: toFiniteNumber(usage.turns),
          });
        }
      }
      if (typeof summary.startedAt === "string") {
        state.startedAt = summary.startedAt;
      }
    },

    getTotalInputTokens(): number {
      return state.totalInputTokens;
    },

    getTotalOutputTokens(): number {
      return state.totalOutputTokens;
    },

    getTotalCacheReadTokens(): number {
      return state.totalCacheReadTokens;
    },

    getTotalCacheWriteTokens(): number {
      return state.totalCacheWriteTokens;
    },

    getTotalCost(): number {
      return state.totalCost;
    },

    getCacheHitRate(): number {
      const denominator = state.totalCacheReadTokens + state.totalInputTokens;
      if (denominator <= 0) return 0;
      return state.totalCacheReadTokens / denominator;
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
