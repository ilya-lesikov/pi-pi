import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageTracker, dumpUsageSummary, loadUsageSummary } from "./usage-tracker.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-usage-tracker-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("usage-tracker", () => {
  it("createUsageTracker starts with zero counts", () => {
    const tracker = createUsageTracker();

    expect(tracker.getMainInputTokens()).toBe(0);
    expect(tracker.getMainOutputTokens()).toBe(0);
    expect(tracker.getMainCacheReadTokens()).toBe(0);
    expect(tracker.getMainCacheWriteTokens()).toBe(0);
    expect(tracker.getMainCost()).toBe(0);
    expect(tracker.getTotalInputTokens()).toBe(0);
    expect(tracker.getTotalOutputTokens()).toBe(0);
    expect(tracker.getTotalCost()).toBe(0);
  });

  it("loadFromSummary is idempotent and does not double-count subagents", () => {
    const tracker = createUsageTracker();
    const summary = {
      subagents: [
        { description: "a", agentType: "Explore", modelId: "m", inputTokens: 100, outputTokens: 50, cost: 0.5, toolUses: 1, durationMs: 10 },
      ],
    };

    tracker.loadFromSummary(summary);
    tracker.loadFromSummary(summary);

    expect(tracker.getSubagentList()).toHaveLength(1);
    const totals = tracker.getSubagentTotals();
    expect(totals.inputTokens).toBe(100);
    expect(totals.outputTokens).toBe(50);
    expect(totals.cost).toBeCloseTo(0.5);
  });

  it("recordTurn accumulates input output and cache tokens", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 10, 20, 3, 4, 0.1, true);
    tracker.recordTurn("openai/gpt-5", "openai", 5, 7, 2, 1, 0.2, true);

    expect(tracker.getMainInputTokens()).toBe(15);
    expect(tracker.getMainOutputTokens()).toBe(27);
    expect(tracker.getMainCacheReadTokens()).toBe(5);
    expect(tracker.getMainCacheWriteTokens()).toBe(5);
  });

  it("recordTurn accumulates cost", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 1, 1, 0, 0, 0.25, false);
    tracker.recordTurn("openai/gpt-5", "openai", 1, 1, 0, 0, 0.5, false);

    expect(tracker.getMainCost()).toBe(0.75);
  });

  it("recordTurn handles non-finite numeric input as zero", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", Number.NaN, Number.POSITIVE_INFINITY, 0, 0, Number.NaN, false);

    expect(tracker.getMainInputTokens()).toBe(0);
    expect(tracker.getMainOutputTokens()).toBe(0);
    expect(tracker.getMainCost()).toBe(0);
  });

  it("recordTurn tracks per-model usage", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 10, 5, 1, 0, 0.2, false);
    tracker.recordTurn("anthropic/claude-opus-4-6", "anthropic", 7, 3, 0, 0, 0.3, false);

    expect(tracker.getPerModelUsage()).toEqual({
      "openai/gpt-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        cacheSupported: false,
        turns: 1,
        subscription: false,
      },
      "anthropic/claude-opus-4-6": {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheSupported: false,
        turns: 1,
        subscription: false,
      },
    });
  });

  it("recordTurn cacheSupported sets model cache support", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 1, 1, 0, 0, 0, false);
    tracker.recordTurn("openai/gpt-5", "openai", 1, 1, 0, 0, 0, true);

    expect(tracker.getPerModelUsage()["openai/gpt-5"]?.cacheSupported).toBe(true);
  });

  it("recordTurn uses unknown-model key when model id is empty", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("", "openai", 3, 2, 0, 0, 0.1, false);

    expect(tracker.getPerModelUsage()["unknown-model"]).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      turns: 1,
    });
  });

  it("recordSubagentCompletion accumulates subagent tokens", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion({ input: 11, output: 4 } as any, 0.15);
    tracker.recordSubagentCompletion({ input: 9, output: 6 }, 0.25);

    expect(tracker.getSubagentTotals()).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cost: 0.4,
    });
  });

  it("recordSubagentCompletion defaults metadata fields when missing", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion({ input: 1, output: 2 } as any);

    expect(tracker.getSubagentList()[0]).toMatchObject({
      description: "unknown",
      agentType: "unknown",
      modelId: "unknown",
      durationMs: 0,
      toolUses: 0,
    });
  });

  it("recordSubagentCompletion uses tokens.cost over fallback cost", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion({ input: 1, output: 1, cost: 0.6 } as any, 0.2);

    expect(tracker.getSubagentTotals().cost).toBe(0.6);
  });

  it("recordSubagentCompletion stores subagent metadata", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion(
      { input: 5, output: 2, cacheRead: 8, cacheWrite: 1 } as any,
      0.2,
      { description: "Planner", agentType: "planner", modelId: "openai/gpt-5", durationMs: 900, toolUses: 3 },
    );

    expect(tracker.getSubagentList()).toEqual([
      {
        description: "Planner",
        agentType: "planner",
        modelId: "openai/gpt-5",
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 8,
        cacheWriteTokens: 1,
        cacheSupported: true,
        cost: 0.2,
        durationMs: 900,
        toolUses: 3,
        subscription: false,
      },
    ]);
  });

  it("recordSubagentCompletion uses total when input and output are zero", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion({ total: 77, input: 0, output: 0 });

    expect(tracker.getSubagentTotals().inputTokens).toBe(77);
    expect(tracker.getSubagentTotals().outputTokens).toBe(0);
  });

  it("getTotalInputTokens includes main and subagent input", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 10, 0, 0, 0, 0, false);
    tracker.recordSubagentCompletion({ input: 4, output: 0 });

    expect(tracker.getTotalInputTokens()).toBe(14);
  });

  it("getTotalOutputTokens includes main and subagent output", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 0, 7, 0, 0, 0, false);
    tracker.recordSubagentCompletion({ input: 0, output: 3 } as any);

    expect(tracker.getTotalOutputTokens()).toBe(10);
  });

  it("getTotalCost includes main and subagent cost", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 0, 0, 0, 0, 1.2, false);
    tracker.recordSubagentCompletion({ input: 0, output: 0 }, 0.8);

    expect(tracker.getTotalCost()).toBe(2);
  });

  it("getCacheHitRate is cacheRead over processed input (uncached + read + write)", () => {
    const tracker = createUsageTracker();

    // uncached 30, cacheRead 10, cacheWrite 10 → 10 / (30+10+10) = 0.2
    tracker.recordTurn("openai/gpt-5", "openai", 30, 0, 10, 10, 0, true);

    expect(tracker.getCacheHitRate()).toBeCloseTo(10 / 50);
  });

  it("getCacheHitRate includes subagent cache tokens", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 10, 0, 0, 0, 0, true);
    tracker.recordSubagentCompletion({ input: 0, output: 0, cacheRead: 30, cacheWrite: 10 } as any);
    // cacheRead 30 / processed (10 + 30 + 10) = 0.6
    expect(tracker.getCacheHitRate()).toBeCloseTo(30 / 50);
  });

  it("getCacheHitRate returns zero when denominator is zero", () => {
    const tracker = createUsageTracker();
    expect(tracker.getCacheHitRate()).toBe(0);
  });

  it("getTotalProcessedInputTokens sums uncached + cache read + cache write across main and subagents", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 10, 0, 20, 5, 0, true);
    tracker.recordSubagentCompletion({ input: 3, output: 0, cacheRead: 7, cacheWrite: 2 } as any);
    // main: 10+20+5=35, subagent: 3+7+2=12 → 47
    expect(tracker.getTotalProcessedInputTokens()).toBe(47);
  });

  it("getTotalCacheReadTokens and getTotalCacheWriteTokens include subagents", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 0, 0, 20, 5, 0, true);
    tracker.recordSubagentCompletion({ input: 0, output: 0, cacheRead: 7, cacheWrite: 2 } as any);
    expect(tracker.getTotalCacheReadTokens()).toBe(27);
    expect(tracker.getTotalCacheWriteTokens()).toBe(7);
  });

  it("isCacheSupported true when any model or subagent has cache", () => {
    const tracker = createUsageTracker();
    expect(tracker.isCacheSupported()).toBe(false);

    tracker.recordTurn("openai/gpt-5", "openai", 1, 1, 0, 0, 0, true);
    expect(tracker.isCacheSupported()).toBe(true);

    tracker.reset();
    tracker.recordSubagentCompletion({ input: 1, output: 1, cacheRead: 1 } as any);
    expect(tracker.isCacheSupported()).toBe(true);
  });

  it("getPerModelUsage returns a copy", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 2, 3, 0, 0, 0, false);

    const usage = tracker.getPerModelUsage();
    usage["openai/gpt-5"]!.inputTokens = 999;

    expect(tracker.getPerModelUsage()["openai/gpt-5"]!.inputTokens).toBe(2);
  });

  it("toSummary returns complete summary", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 10, 7, 3, 2, 0.1234567, true);
    tracker.recordSubagentCompletion({ input: 4, output: 1 } as any, 0.2, { description: "Explore", agentType: "explore", modelId: "google/gemini-3.1-pro" });

    const summary = tracker.toSummary() as any;

    expect(summary.startedAt).toBeTypeOf("string");
    expect(summary.endedAt).toBeTypeOf("string");
    expect(summary.totals).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      cost: 0.123457,
      turns: 1,
    });
    expect(summary.subagents).toHaveLength(1);
    expect(summary.models["openai/gpt-5"]).toMatchObject({ inputTokens: 10, outputTokens: 7, turns: 1 });
  });

  it("loadFromSummary restores state", () => {
    const tracker = createUsageTracker();
    tracker.loadFromSummary({
      startedAt: "2026-01-01T00:00:00.000Z",
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        cost: 1.5,
        turns: 3,
      },
      models: {
        "openai/gpt-5": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          cacheSupported: true,
          turns: 3,
        },
      },
      subagents: [
        {
          description: "Reviewer",
          agentType: "reviewer",
          modelId: "anthropic/claude-opus-4-6",
          inputTokens: 7,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheSupported: false,
          cost: 0.4,
          durationMs: 200,
          toolUses: 2,
        },
      ],
    });

    expect(tracker.getMainInputTokens()).toBe(100);
    expect(tracker.getMainOutputTokens()).toBe(50);
    expect(tracker.getMainCacheReadTokens()).toBe(20);
    expect(tracker.getMainCacheWriteTokens()).toBe(5);
    expect(tracker.getMainCost()).toBe(1.5);
    expect(tracker.getSubagentTotals()).toEqual({ inputTokens: 7, outputTokens: 2, cost: 0.4 });
    expect(tracker.getPerModelUsage()["openai/gpt-5"]?.turns).toBe(3);
  });

  it("loadFromSummary handles malformed summary entries", () => {
    const tracker = createUsageTracker();

    tracker.loadFromSummary({
      startedAt: 123,
      totals: "bad",
      models: {
        "openai/gpt-5": {
          inputTokens: "x",
          outputTokens: 2,
          cacheSupported: "yes",
          turns: "z",
        },
      },
      subagents: [{ inputTokens: "bad", outputTokens: 4 }],
    } as any);

    expect(tracker.getMainInputTokens()).toBe(0);
    expect(tracker.getMainOutputTokens()).toBe(0);
    expect(tracker.getPerModelUsage()["openai/gpt-5"]).toMatchObject({
      inputTokens: 0,
      outputTokens: 2,
      cacheSupported: false,
      turns: 0,
    });
    expect(tracker.getSubagentList()[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 4,
    });
  });

  it("loadFromSummary and toSummary preserve data round-trip", () => {
    const source = createUsageTracker();
    source.recordTurn("openai/gpt-5", "openai", 13, 8, 2, 1, 0.5, true);
    source.recordSubagentCompletion({ input: 3, output: 1, cacheRead: 1 } as any, 0.1, {
      description: "Librarian",
      agentType: "librarian",
      modelId: "google/gemini-3.1-pro",
      durationMs: 321,
      toolUses: 4,
    });

    const mid = source.toSummary() as Record<string, unknown>;
    const restored = createUsageTracker();
    restored.loadFromSummary(mid);
    const roundTrip = restored.toSummary() as any;

    expect(roundTrip.totals).toEqual((mid as any).totals);
    expect(roundTrip.models).toEqual((mid as any).models);
    expect(roundTrip.subagents).toEqual((mid as any).subagents);
  });

  it("subscription main turns count tokens but contribute zero cost", () => {
    const tracker = createUsageTracker();

    // Detected via the sub/ model id prefix...
    tracker.recordTurn("sub/claude-opus-4-6", "anthropic", 100, 50, 10, 5, 1.23, true);
    // ...or via the subscription provider with a bare id (keyed under sub/).
    tracker.recordTurn("claude-opus-4-6", "pp-flant-anthropic-sub", 20, 10, 0, 0, 0.5, true);

    expect(tracker.getMainInputTokens()).toBe(120);
    expect(tracker.getMainOutputTokens()).toBe(60);
    expect(tracker.getMainCacheReadTokens()).toBe(10);
    expect(tracker.getMainCost()).toBe(0);
    expect(tracker.getTotalCost()).toBe(0);
    expect(tracker.getPerModelUsage()["sub/claude-opus-4-6"]?.subscription).toBe(true);
  });

  it("provider-detected subscription turns key under sub/ so paid rows stay separate", () => {
    const tracker = createUsageTracker();

    // Same underlying model id: one paid, one subscription (provider-only).
    tracker.recordTurn("claude-opus-4-6", "pp-flant-anthropic", 10, 5, 0, 0, 0.4, false);
    tracker.recordTurn("claude-opus-4-6", "pp-flant-anthropic-sub", 20, 10, 0, 0, 2.0, false);

    const usage = tracker.getPerModelUsage();
    expect(usage["claude-opus-4-6"]).toMatchObject({ inputTokens: 10, outputTokens: 5, subscription: false });
    expect(usage["sub/claude-opus-4-6"]).toMatchObject({ inputTokens: 20, outputTokens: 10, subscription: true });
    expect(tracker.getMainCost()).toBeCloseTo(0.4);
  });

  it("subscription subagents count tokens but contribute zero cost", () => {
    const tracker = createUsageTracker();

    tracker.recordSubagentCompletion({ input: 30, output: 15 } as any, 0.9, {
      description: "Explore", agentType: "explore", modelId: "sub/claude-haiku-4-5",
    });

    expect(tracker.getSubagentTotals()).toEqual({ inputTokens: 30, outputTokens: 15, cost: 0 });
    expect(tracker.getSubagentList()[0]?.subscription).toBe(true);
    expect(tracker.getSubagentList()[0]?.cost).toBe(0);
  });

  it("mixed paid and subscription session totals only the paid portion", () => {
    const tracker = createUsageTracker();

    tracker.recordTurn("openai/gpt-5", "openai", 10, 5, 0, 0, 0.4, false);
    tracker.recordTurn("sub/claude-opus-4-6", "pp-flant-anthropic-sub", 10, 5, 0, 0, 2.0, false);
    tracker.recordSubagentCompletion({ input: 5, output: 2 } as any, 0.1, { modelId: "openai/gpt-5" });
    tracker.recordSubagentCompletion({ input: 5, output: 2 } as any, 3.0, { modelId: "sub/claude-haiku-4-5" });

    expect(tracker.getMainCost()).toBeCloseTo(0.4);
    expect(tracker.getSubagentTotals().cost).toBeCloseTo(0.1);
    expect(tracker.getTotalCost()).toBeCloseTo(0.5);
  });

  it("subscription marker survives JSON round-trip and stays paid-only", () => {
    const source = createUsageTracker();
    source.recordTurn("sub/claude-opus-4-6", "pp-flant-anthropic-sub", 10, 5, 0, 0, 2.0, true);
    source.recordSubagentCompletion({ input: 5, output: 2 } as any, 3.0, { modelId: "sub/claude-haiku-4-5" });

    const mid = source.toSummary() as Record<string, unknown>;
    const restored = createUsageTracker();
    restored.loadFromSummary(mid);

    const roundTrip = restored.toSummary() as any;
    expect(restored.getTotalCost()).toBe(0);
    expect(restored.getPerModelUsage()["sub/claude-opus-4-6"]?.subscription).toBe(true);
    expect(restored.getSubagentList()[0]?.subscription).toBe(true);
    expect(roundTrip.totals).toEqual((mid as any).totals);
    expect(roundTrip.models).toEqual((mid as any).models);
    expect(roundTrip.subagents).toEqual((mid as any).subagents);
  });

  it("legacy summaries without subscription field default to non-subscription", () => {
    const tracker = createUsageTracker();
    tracker.loadFromSummary({
      totals: { inputTokens: 10, outputTokens: 5, cost: 1.5, turns: 1 },
      models: { "openai/gpt-5": { inputTokens: 10, outputTokens: 5, turns: 1 } },
      subagents: [{ description: "a", agentType: "x", modelId: "m", inputTokens: 3, outputTokens: 1, cost: 0.2 }],
    });

    expect(tracker.getPerModelUsage()["openai/gpt-5"]?.subscription).toBe(false);
    expect(tracker.getSubagentList()[0]?.subscription).toBe(false);
    expect(tracker.getMainCost()).toBe(1.5);
    expect(tracker.getSubagentTotals().cost).toBeCloseTo(0.2);
  });

  it("loadFromSummary recovers subscription from sub/ prefix when flag is absent", () => {
    const tracker = createUsageTracker();
    tracker.loadFromSummary({
      totals: { inputTokens: 10, outputTokens: 5, cost: 0, turns: 1 },
      models: { "sub/claude-opus-4-6": { inputTokens: 10, outputTokens: 5, turns: 1 } },
      subagents: [{ description: "a", agentType: "x", modelId: "sub/claude-haiku-4-5", inputTokens: 3, outputTokens: 1, cost: 2.5 }],
    });

    expect(tracker.getPerModelUsage()["sub/claude-opus-4-6"]?.subscription).toBe(true);
    expect(tracker.getSubagentList()[0]?.subscription).toBe(true);
    expect(tracker.getSubagentList()[0]?.cost).toBe(0);
    expect(tracker.getSubagentTotals().cost).toBe(0);
  });

  it("reset clears all state", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 1, 2, 3, 4, 0.2, true);
    tracker.recordSubagentCompletion({ input: 5, output: 6 } as any, 0.1);

    tracker.reset();

    expect(tracker.getMainInputTokens()).toBe(0);
    expect(tracker.getMainOutputTokens()).toBe(0);
    expect(tracker.getMainCacheReadTokens()).toBe(0);
    expect(tracker.getMainCacheWriteTokens()).toBe(0);
    expect(tracker.getMainCost()).toBe(0);
    expect(tracker.getSubagentTotals()).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(tracker.getPerModelUsage()).toEqual({});
    expect(tracker.getSubagentList()).toEqual([]);
  });

  it("dumpUsageSummary and loadUsageSummary write and read JSON", () => {
    const dir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = dir;
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 11, 12, 1, 0, 0.9, true);

    dumpUsageSummary(tracker, "session-1");
    const loaded = loadUsageSummary("session-1") as any;

    expect(loaded.sessionId).toBe("session-1");
    expect(loaded.totals.inputTokens).toBe(11);
    expect(loaded.totals.outputTokens).toBe(12);
    expect(loaded.models["openai/gpt-5"].turns).toBe(1);

    const filePath = join(dir, "extensions", "pp", "usage", "session-1.json");
    const raw = readFileSync(filePath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("loadUsageSummary returns null for missing and invalid files", () => {
    const dir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = dir;

    expect(loadUsageSummary("missing")).toBeNull();

    const usageDir = join(dir, "extensions", "pp", "usage");
    const invalidPath = join(usageDir, "broken.json");
    rmSync(usageDir, { recursive: true, force: true });
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(invalidPath, "{broken", "utf-8");

    expect(loadUsageSummary("broken")).toBeNull();
  });
});
