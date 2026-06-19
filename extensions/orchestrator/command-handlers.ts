import { unregisterAgentDefinitions } from "./agents/registry.js";
import { runAfterImplement } from "./commands.js";
import { nextPhase, validateExitCriteria } from "./phases/machine.js";
import { spawnPlanners } from "./phases/planning.js";
import { Orchestrator } from "./orchestrator.js";
import { saveTask } from "./state.js";

export async function transitionToNextPhase(
  orchestrator: Orchestrator,
  ctx: any,
): Promise<{ ok: boolean; error?: string }> {
  if (!orchestrator.active) return { ok: false, error: "No active task." };

  const currentPhase = orchestrator.active.state.phase;
  if (currentPhase === "done") return { ok: false, error: "Task is already done." };

  const exitCheck = validateExitCriteria(orchestrator.active.dir, orchestrator.active.type, currentPhase);
  if (!exitCheck.ok) {
    return { ok: false, error: exitCheck.reason };
  }

  if (orchestrator.phaseStartTime > 0) {
    const elapsed = Math.round((Date.now() - orchestrator.phaseStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    ctx.ui.notify(`Phase "${currentPhase}" completed in ${min > 0 ? `${min}m ${sec}s` : `${sec}s`}`, "info");
  }

  const next = nextPhase(orchestrator.active.type, currentPhase);
  if (!next) return { ok: false, error: "No next phase available." };

  if (currentPhase === "implement") {
    const afterResults = runAfterImplement(orchestrator.config, orchestrator.cwd);
    const failures = afterResults.filter((r) => !r.ok);
    if (failures.length > 0) {
      const failureText = failures.map((f) => `${f.command}: ${f.output}`).join("\n");
      return { ok: false, error: `afterImplement commands failed:\n${failureText}\n\nFix these issues before advancing.` };
    }
  }

  orchestrator.active.state.phase = next;
  if (next !== "done") {
    orchestrator.active.state.reviewCycle = null;
    orchestrator.active.state.reviewPass = 0;
    orchestrator.active.state.reviewPassByKind = {};
    orchestrator.active.reviewPass = 0;
  }
  if (next === "plan") {
    orchestrator.active.state.step = "spawn_planners";
  } else if (next === "implement") {
    orchestrator.active.state.step = "llm_work";
  } else if (next === "brainstorm" || next === "debug") {
    orchestrator.active.state.step = "llm_work";
  } else if (next === "done") {
    orchestrator.active.state.step = null;
  }
  saveTask(orchestrator.active.dir, orchestrator.active.state);

  if (next === "done") {
    const name = orchestrator.active.description;
    const type = orchestrator.active.type;
    orchestrator.taskDoneCompactionPending = true;
    orchestrator.taskDoneCompactionSummary = `Task "${name}" (${type}) completed.`;

    orchestrator.abortAllSubagents();
    unregisterAgentDefinitions(orchestrator.pi);
    await orchestrator.cleanupActive();
    orchestrator.updateStatus(ctx);
    ctx.compact();
    ctx.ui.notify("Task completed!", "info");
    return { ok: true };
  }

  orchestrator.updateStatus(ctx);

  if (next === "plan") {
    orchestrator.active.state.step = "await_planners";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
  }

  orchestrator.compactAndTransition(ctx, orchestrator.active.dir, orchestrator.active.state.phase);

  if (next === "plan") {
    orchestrator.pendingSubagentSpawns = Object.values(orchestrator.config.planners).filter((v) => v.enabled).length;
    orchestrator.failedPlannerVariants = [];
    spawnPlanners(orchestrator.pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config).then((result) => {
      orchestrator.failedPlannerVariants = result.failedVariants;
      if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
      for (const id of result.agentIds ?? []) {
        orchestrator.spawnedAgentIds.delete(id);
      }
      orchestrator.pendingSubagentSpawns = 0;
    }).catch((err) => {
      orchestrator.pendingSubagentSpawns = 0;
      console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
    });
  }

  return { ok: true };
}

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  orchestrator.transitionToNextPhase = (ctx: any) => transitionToNextPhase(orchestrator, ctx);

  pi.registerCommand("pp", {
    description: "Open pi-pi task menu",
    handler: async (_args, ctx) => {
      const { showPpMenu } = await import("./pp-menu.js");
      const text = await showPpMenu(orchestrator, ctx, "command");
      if (text) {
        pi.sendUserMessage(`[PI-PI] ${text}`, { deliverAs: "followUp" });
      }
    },
  });
}
