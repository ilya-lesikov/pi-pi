import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";

type SpawnResult = { spawned: number; agentIds?: string[]; failedVariants: string[] };

type SpawnCleanupOptions = {
  kind: "planner" | "reviewer";
  logScope: string;
  logMessage: string;
  logExtra?: Record<string, unknown>;
  onSettled?: (result?: SpawnResult) => void;
};

// Centralizes the cleanup that runs after a planner/reviewer spawn promise
// settles. The spawn functions block until every spawned agent completes, so
// resetting pendingSubagentSpawns to 0 is the fail-safe for the spawned===0
// case and the .catch path where no subagents:completed event fires.
export function handleSpawnResult(
  orchestrator: Orchestrator,
  promise: Promise<SpawnResult>,
  opts: SpawnCleanupOptions,
): void {
  const field = opts.kind === "planner" ? "failedPlannerVariants" : "failedReviewerVariants";
  promise
    .then((result) => {
      orchestrator[field] = result.failedVariants;
      orchestrator.pendingSubagentSpawns = 0;
      opts.onSettled?.(result);
    })
    .catch((err: any) => {
      orchestrator.pendingSubagentSpawns = 0;
      opts.onSettled?.();
      getLogger().error({ s: opts.logScope, ...opts.logExtra, err: err.message }, opts.logMessage);
    });
}
