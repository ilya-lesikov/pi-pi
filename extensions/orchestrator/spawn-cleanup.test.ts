import { describe, it, expect, vi } from "vitest";
import { handleSpawnResult } from "./spawn-cleanup.js";
import type { Orchestrator } from "./orchestrator.js";

function makeOrchestrator(): Orchestrator {
  return {
    pendingSubagentSpawns: 3,
    failedPlannerVariants: [],
    failedReviewerVariants: [],
  } as unknown as Orchestrator;
}

describe("handleSpawnResult", () => {
  it("resets pending and records failed planner variants on success", async () => {
    const orch = makeOrchestrator();
    const onSettled = vi.fn();
    handleSpawnResult(orch, Promise.resolve({ spawned: 2, agentIds: ["a"], failedVariants: ["bad"] }), {
      kind: "planner",
      logScope: "planner",
      logMessage: "x",
      onSettled,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.pendingSubagentSpawns).toBe(0);
    expect(orch.failedPlannerVariants).toEqual(["bad"]);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("resets pending and still runs onSettled on rejection (fail-safe)", async () => {
    const orch = makeOrchestrator();
    const onSettled = vi.fn();
    handleSpawnResult(orch, Promise.reject(new Error("boom")), {
      kind: "reviewer",
      logScope: "review",
      logMessage: "x",
      onSettled,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.pendingSubagentSpawns).toBe(0);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("targets failedReviewerVariants for the reviewer kind", async () => {
    const orch = makeOrchestrator();
    handleSpawnResult(orch, Promise.resolve({ spawned: 0, agentIds: [], failedVariants: ["r"] }), {
      kind: "reviewer",
      logScope: "review",
      logMessage: "x",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.failedReviewerVariants).toEqual(["r"]);
    expect(orch.pendingSubagentSpawns).toBe(0);
  });
});
