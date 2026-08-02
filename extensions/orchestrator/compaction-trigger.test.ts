import { describe, it, expect } from "vitest";
import {
  compactionThresholdTokens,
  effectiveCompactionParams,
  shouldFireCompaction,
  makeCompactionArmState,
  CONTEXT_RESERVE_TOKENS,
} from "./compaction-trigger.js";
import type { CompactionConfig } from "./config.js";

const cfg = (over: Partial<CompactionConfig> = {}): CompactionConfig => ({
  enabled: true,
  fraction: 0.3,
  floorTokens: 250000,
  perModel: {},
  ...over,
});

describe("compactionThresholdTokens", () => {
  it("uses the fraction for a large (1M) window", () => {
    expect(compactionThresholdTokens({ contextWindow: 1_000_000, config: cfg() })).toBe(300_000);
  });

  it("uses the 250K floor for a 500K window (fraction would be 150K)", () => {
    expect(compactionThresholdTokens({ contextWindow: 500_000, config: cfg() })).toBe(250_000);
  });

  it("clamps to window - reserve for a small window below the floor", () => {
    const w = 200_000;
    expect(compactionThresholdTokens({ contextWindow: w, config: cfg() })).toBe(w - CONTEXT_RESERVE_TOKENS);
  });

  it("applies a per-model override", () => {
    const c = cfg({ perModel: { "gpt-5.6-sol": { fraction: 0.5, floorTokens: 100000 } } });
    // 400K window * 0.5 = 200K > 100K floor.
    expect(compactionThresholdTokens({ contextWindow: 400_000, modelId: "pp-flant-openai/gpt-5.6-sol", config: c })).toBe(200_000);
  });

  // M6 (4): after a provider-tier switch to a github-copilot model, the trigger
  // recomputes against THAT model's (smaller) context window. Copilot opus
  // ships a 160K window; with the default 250K floor a 160K window is below the
  // floor, so the threshold clamps to window - reserve (NOT the 250K floor and
  // NOT the prior larger-window threshold).
  it("recomputes for a switched-to github-copilot model's smaller window", () => {
    // Before the switch: a 1M flant window -> 300K threshold.
    expect(compactionThresholdTokens({ contextWindow: 1_000_000, modelId: "pp-flant-anthropic/claude-opus-4-8", config: cfg() })).toBe(300_000);
    // After switching to github-copilot/claude-opus-4.5 (160K window): the new
    // window drives the threshold, clamped to window - reserve.
    const copilotWindow = 160_000;
    expect(
      compactionThresholdTokens({ contextWindow: copilotWindow, modelId: "github-copilot/claude-opus-4.5", config: cfg() }),
    ).toBe(copilotWindow - CONTEXT_RESERVE_TOKENS);
  });
});

describe("effectiveCompactionParams", () => {
  it("matches a per-model override by bare id", () => {
    const c = cfg({ perModel: { "claude-opus-4-8": { fraction: 0.25 } } });
    expect(effectiveCompactionParams(c, "pp-flant-anthropic/claude-opus-4-8").fraction).toBe(0.25);
  });
  it("falls back to global defaults with no override", () => {
    expect(effectiveCompactionParams(cfg(), "unknown/model")).toEqual({ fraction: 0.3, floorTokens: 250000 });
  });
});

describe("shouldFireCompaction (hysteresis)", () => {
  it("fires once on crossing then disarms until re-armed", () => {
    const state = makeCompactionArmState();
    const threshold = 300_000;
    // Below threshold: no fire.
    expect(shouldFireCompaction(200_000, threshold, state)).toBe(false);
    // Cross: fires once.
    expect(shouldFireCompaction(310_000, threshold, state)).toBe(true);
    expect(state.armed).toBe(false);
    // Still high (post-fire, before compaction shrinks it): no repeat fire.
    expect(shouldFireCompaction(320_000, threshold, state)).toBe(false);
    // Compaction shrank context below the re-arm band (90% = 270K): re-arm.
    expect(shouldFireCompaction(260_000, threshold, state)).toBe(false);
    expect(state.armed).toBe(true);
    // Grows past threshold again: fires again.
    expect(shouldFireCompaction(305_000, threshold, state)).toBe(true);
  });

  it("does not fire when tokens are unknown (null)", () => {
    expect(shouldFireCompaction(null, 300_000, makeCompactionArmState())).toBe(false);
  });

  it("does not re-arm while usage stays within the band just under threshold", () => {
    const state = makeCompactionArmState();
    shouldFireCompaction(310_000, 300_000, state); // fire + disarm
    // 295K is above the 270K re-arm band -> stays disarmed.
    expect(shouldFireCompaction(295_000, 300_000, state)).toBe(false);
    expect(state.armed).toBe(false);
  });
});
