import { unregisterAgentDefinitions } from "./agents/registry.js";
import { loadRepoAfterImplementCommands, runAfterImplement } from "./commands.js";
import { resolvePreset } from "./config.js";
import { nextPhase, validateExitCriteria } from "./phases/machine.js";
import { spawnPlanners } from "./phases/planning.js";
import { Orchestrator } from "./orchestrator.js";
import { groupFilesByRepo } from "./repo-utils.js";
import { getEffectiveMode, saveTask } from "./state.js";
import { getLogger } from "./log.js";
import { handleSpawnResult } from "./spawn-cleanup.js";

function isEnabled(value: { enabled?: boolean }): boolean {
  return value.enabled !== false;
}

export async function transitionToNextPhase(
  orchestrator: Orchestrator,
  ctx: any,
  plannerPreset?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!orchestrator.active) return { ok: false, error: "No active task." };
  const log = getLogger();
  const currentPhase = orchestrator.active.state.phase;
  log.info({ s: "phase", from: currentPhase, plannerPreset: plannerPreset ?? null }, "transition requested");
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
    const repos = orchestrator.active.state.repos ?? [];
    const grouped = groupFilesByRepo(repos, [...orchestrator.active.modifiedFiles]);
    const afterResults: Array<{ ok: boolean; command: string; output: string }> = [];
    for (const [repoPath] of grouped) {
      if (!repoPath) continue;
      const repo = repos.find((r) => r.path === repoPath);
      if (!repo) continue;
      if (repo.isRoot) {
        afterResults.push(...runAfterImplement(
          orchestrator.config.commands.afterImplement,
          orchestrator.config.performance.commands.afterImplement,
          orchestrator.cwd,
        ));
        continue;
      }
      if (!orchestrator.config.general.loadExtraRepoConfigs) continue;
      const extraCommands = loadRepoAfterImplementCommands(repoPath);
      if (!extraCommands || Object.keys(extraCommands).length === 0) continue;
      afterResults.push(...runAfterImplement(extraCommands, orchestrator.config.performance.commands.afterImplement, repoPath));
    }
    const failures = afterResults.filter((r) => !r.ok);
    if (failures.length > 0) {
      const failureText = failures.map((f) => `${f.command}: ${f.output}`).join("\n");
      return { ok: false, error: `afterImplement commands failed:\n${failureText}\n\nFix these issues before advancing.` };
    }
  }

  orchestrator.active.state.phase = next;
  orchestrator.active.state.reviewCycle = null;
  orchestrator.active.state.reviewPass = 0;
  orchestrator.active.state.reviewApprovedClean = false;
  orchestrator.active.reviewPass = 0;
  if (next === "plan") {
    const autonomousPlannerPreset =
      getEffectiveMode(orchestrator.active.state) === "autonomous"
        ? orchestrator.active.state.autonomousConfig?.phases.plan?.plannerPreset
        : undefined;
    orchestrator.active.state.activePlannerPreset =
      plannerPreset ?? autonomousPlannerPreset ?? orchestrator.config.agents.subagents.presetGroups.planners.default;
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

    orchestrator.abortAllSubagents();
    unregisterAgentDefinitions(orchestrator.pi);
    await orchestrator.cleanupActive();
    orchestrator.updateStatus(ctx);
    orchestrator.lastCtx = ctx;
    // Route the task-done compaction through the controller as a "done" target.
    void orchestrator.transitionController.requestTransition({
      kind: "done",
      summary: `Task "${name}" (${type}) completed.`,
    });
    ctx.ui.notify("Task completed!", "info");
    return { ok: true };
  }

  orchestrator.updateStatus(ctx);
  const phaseSummary = `Phase "${currentPhase}" completed. Now entering "${next}" phase.`;

  if (next === "plan") {
    orchestrator.active.state.step = "await_planners";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
  }

  const onReady = next === "plan" ? () => {
    if (!orchestrator.active) return;
    const plannerVariants = resolvePreset(orchestrator.config, "planners", orchestrator.active.state.activePlannerPreset);
    orchestrator.pendingSubagentSpawns = Object.values(plannerVariants).filter((v) => isEnabled(v)).length;
    orchestrator.failedPlannerVariants = [];
    handleSpawnResult(
      orchestrator,
      spawnPlanners(
        orchestrator.pi,
        orchestrator.cwd,
        orchestrator.active.dir,
        orchestrator.active.taskId,
        orchestrator.config,
        orchestrator.transitionController.phaseSend,
        plannerVariants,
        orchestrator.active?.state.repos ?? [],
      ),
      { kind: "planner", logScope: "planner", logMessage: "spawnPlanners failed", onSettled: (result) => { if (!result?.spawned) orchestrator.checkPlannerCompletion(); } },
    );
  } : undefined;

  orchestrator.compactAndTransition(ctx, orchestrator.active.dir, orchestrator.active.state.phase, onReady, phaseSummary);

  return { ok: true };
}

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  orchestrator.transitionToNextPhase = (ctx: any, plannerPreset?: string) => transitionToNextPhase(orchestrator, ctx, plannerPreset);

  pi.registerCommand("pp", {
    description: "Open pi-pi task menu",
    handler: async (_args, ctx) => {
      const { showPpMenu } = await import("./pp-menu.js");
      const text = await showPpMenu(orchestrator, ctx, "command");
      if (text) {
        orchestrator.safeSendUserMessage(`[PI-PI] ${text}`);
      }
    },
  });
}
