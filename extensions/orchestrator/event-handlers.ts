import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, basename, join, relative, dirname, isAbsolute, sep } from "path";
import { validateUserRequest, validateResearch, validateArtifact } from "./validate-artifacts.js";
import { Type } from "@sinclair/typebox";
import { loadConfig, resolvePreset, reviewPresetGroupForPhase, getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { runAfterEdit, autoCommit, loadRepoAfterEditCommands } from "./commands.js";
import { taskName, getActiveTaskStatus, getEffectiveMode, getEffectivePhaseMode, saveTask, type Phase, type TaskMode } from "./state.js";
import { getLogger, initSessionLogger, addTaskDestination, setLogLevel, flushLogs } from "./log.js";
import { initTracer, finalizeTracer, getTracer } from "./tracer.js";
import { handleSpawnResult } from "./spawn-cleanup.js";
import {
  getContextDirs,
  loadAllContextFiles,
  getPhaseArtifacts,
  getLatestSynthesizedPlan,
  getArtifactManifest,
  loadPhaseReviewOutputs,
} from "./context.js";
import { PRINCIPLES_BLOCK, TOOLS_BLOCK, DELEGATION_BLOCK } from "./agents/tool-routing.js";
import { constraintsBlock, phaseConstraint } from "./agents/constraints.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { SUBAGENT_SESSION_KEY } from "./index.js";
import { registerCommandHandlers, runAfterImplementForActive } from "./command-handlers.js";
import { registerStateFileTools } from "./pp-state-tools.js";
import { isAiCommentOnlyChange } from "./ai-comment-cleanup.js";
import { handleMainRateLimit, handleSubagentRateLimit, isRateLimitError, isSdkRetryableError } from "./rate-limit-fallback.js";
import { setExtensionOnlyMode, unregisterAgentDefinitions } from "./agents/registry.js";
import { resolveModel, getModelInfo, updateRegistryFromAvailableModels } from "./model-registry.js";
import { spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { spawnBrainstormReviewers } from "./phases/brainstorm.js";
import { reviewPassUnanimousApprove } from "./phases/verdict.js";
import { nextPhase, validateExitCriteria } from "./phases/machine.js";
import { openPlannotator, waitForPlannotatorResult, cancelPendingPlannotatorWait } from "./plannotator.js";
import { advanceBanner } from "./messages.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, loadUsageSummary, isSubscriptionRouted, type UsageTracker } from "./usage-tracker.js";
import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRootRepo, normalizeRepoPath, resolveRepoForFile, type RepoInfo } from "./repo-utils.js";

const USAGE_TRACKER_KEY = Symbol.for("pi-pi:usage-tracker");

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(basePath, targetPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Builds the spawn-time context block appended to a free agent's spawn prompt:
// inlines USER_REQUEST + RESEARCH (always present by spawn time) and appends a
// path-aware manifest of additional on-demand documents (artifacts + plan).
function buildSpawnContextBlock(taskDir: string): string {
  const parts: string[] = [];

  const userRequestPath = join(taskDir, "USER_REQUEST.md");
  if (existsSync(userRequestPath)) {
    parts.push("=== USER REQUEST ===\n" + readFileSync(userRequestPath, "utf-8").trimEnd());
  }
  const researchPath = join(taskDir, "RESEARCH.md");
  if (existsSync(researchPath)) {
    parts.push("=== RESEARCH ===\n" + readFileSync(researchPath, "utf-8").trimEnd());
  }

  const manifest = getArtifactManifest(taskDir);
  if (manifest.length > 0) {
    const lines = manifest.map((m) => `- ${m.path}  — ${m.title}`);
    parts.push(
      "=== ADDITIONAL DOCUMENTS (read from disk if relevant) ===\n" +
        lines.join("\n") +
        "\nDo NOT re-read USER_REQUEST/RESEARCH from disk (already above).",
    );
  }

  return parts.join("\n\n");
}

export async function detectDefaultBranch(orchestrator: Orchestrator, repos: RepoInfo[], repoPath: string): Promise<string> {
  const normalizedPath = normalizeRepoPath(repoPath);
  const repo = repos.find((r) => r.path === normalizedPath);
  if (repo?.baseBranch) return repo.baseBranch;

  try {
    const headRef = await orchestrator.pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: normalizedPath,
      timeout: 5000,
    });
    if (headRef.code === 0) {
      const value = headRef.stdout.trim();
      if (value.startsWith("refs/remotes/")) {
        return value.slice("refs/remotes/".length);
      }
    }
  } catch {}

  try {
    const mainRef = await orchestrator.pi.exec("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
      cwd: normalizedPath,
      timeout: 5000,
    });
    if (mainRef.code === 0) return "origin/main";
  } catch {}

  try {
    const masterRef = await orchestrator.pi.exec("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], {
      cwd: normalizedPath,
      timeout: 5000,
    });
    if (masterRef.code === 0) return "origin/master";
  } catch {}

  return "origin/main";
}

export async function selectOption(ctx: any, question: string, options: string[]): Promise<string | undefined> {
  const orchestrator = Orchestrator.current;
  if (orchestrator) orchestrator.interactivePromptOpen = true;
  try {
    const result = await askUser(ctx, {
      question,
      options,
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    if (!result || isCancel(result) || result.kind !== "selection") return undefined;
    return result.selections[0];
  } finally {
    if (orchestrator) orchestrator.interactivePromptOpen = false;
  }
}

function resolveReviewers(
  orchestrator: Orchestrator,
  phase: string,
  presetName?: string,
): Record<string, any> {
  const group = reviewPresetGroupForPhase(phase);
  return resolvePreset(orchestrator.config, group, presetName);
}

function getDefaultReviewPresetName(orchestrator: Orchestrator, phase: string): string {
  return orchestrator.config.agents.subagents.presetGroups[reviewPresetGroupForPhase(phase)].default;
}

function normalizeStoredPlannerPresetName(orchestrator: Orchestrator): string {
  const requestedName = orchestrator.active?.state.activePlannerPreset ?? orchestrator.config.agents.subagents.presetGroups.planners.default;
  const plannerPresets = orchestrator.config.agents.subagents.presetGroups.planners.presets ?? {};
  const exists = Object.prototype.hasOwnProperty.call(plannerPresets, requestedName);
  const resolvedName = exists ? requestedName : (Object.keys(plannerPresets)[0] ?? requestedName);

  if (orchestrator.active && orchestrator.active.state.activePlannerPreset !== resolvedName) {
    orchestrator.active.state.activePlannerPreset = resolvedName;
    saveTask(orchestrator.active.dir, orchestrator.active.state);
  }

  if (!exists && resolvedName !== requestedName) {
    orchestrator.lastCtx?.ui?.notify(
      `Planner preset "${requestedName}" not found. Falling back to "${resolvedName}".`,
      "warning",
    );
  }

  return resolvedName;
}

function normalizeStoredReviewPresetName(orchestrator: Orchestrator, phase: string): string {
  const group = reviewPresetGroupForPhase(phase);
  const requestedName = orchestrator.active?.state.activeReviewPreset ?? getDefaultReviewPresetName(orchestrator, phase);
  const reviewPresets = orchestrator.config.agents.subagents.presetGroups[group].presets ?? {};
  const exists = Object.prototype.hasOwnProperty.call(reviewPresets, requestedName);
  const resolvedName = exists ? requestedName : (Object.keys(reviewPresets)[0] ?? requestedName);

  if (orchestrator.active && orchestrator.active.state.activeReviewPreset !== resolvedName) {
    orchestrator.active.state.activeReviewPreset = resolvedName;
    saveTask(orchestrator.active.dir, orchestrator.active.state);
  }

  if (!exists && resolvedName !== requestedName) {
    orchestrator.lastCtx?.ui?.notify(
      `Review preset "${requestedName}" not found. Falling back to "${resolvedName}".`,
      "warning",
    );
  }

  return resolvedName;
}

function tryCompleteReviewCycle(orchestrator: Orchestrator, spawnedReviewers?: number): void {
  if (
    !orchestrator.active?.state.reviewCycle ||
    orchestrator.active.state.reviewCycle.step !== "await_reviewers" ||
    orchestrator.spawnedAgentIds.size > 0 ||
    orchestrator.pendingSubagentSpawns > 0
  ) return;

  // Idempotent by state: the first call mutates reviewCycle.step away from
  // "await_reviewers" (or nulls reviewCycle), so the guard above no-ops any
  // subsequent caller. No separate dedup token needed.
  const cycle = orchestrator.active.state.reviewCycle;
  const phase = orchestrator.active.state.phase;
  const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
  const pi = orchestrator.pi;

  if (spawnedReviewers === 0 && outputs.length === 0) {
    orchestrator.active.state.reviewCycle = null;
    orchestrator.active.state.step = "llm_work";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    orchestrator.safeSendUserMessage("[PI-PI] No reviewer outputs were produced — nothing to review. Continue working.");
    return;
  }

  cycle.step = "apply_feedback";
  orchestrator.active.state.step = "apply_feedback";
  saveTask(orchestrator.active.dir, orchestrator.active.state);

  const rendered = outputs.length
    ? outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n")
    : "All reviewers failed to produce output. Review the work yourself and decide whether to approve or request changes.";

  orchestrator.transitionController.sendCustom(
    {
      customType: "pp-review-ready",
      content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
      display: false,
    },
    "instruction",
  );
  orchestrator.safeSendUserMessage(advanceBanner(reviewReadyMessage(phase, getEffectivePhaseMode(orchestrator.active.state))));
}

function reviewReadyMessage(phase: string, mode: TaskMode): string {
  if (reviewPresetGroupForPhase(phase) === "brainstormReviewers") {
    return "[PI-PI] Review cycle is ready for apply_feedback. The reviewers assessed your research artifacts (USER_REQUEST.md, RESEARCH.md, and artifacts/), not a code diff. Read their outputs and update those artifacts as needed.";
  }
  // Only autonomous plan/implement auto-advance: those must re-call
  // pp_phase_complete to finalize the pass and transition. Guided phases
  // (including debug and the interactive review phase) stay user-driven, so
  // they get neutral wording with no re-call/auto-advance directive.
  if (mode === "autonomous") {
    return "[PI-PI] Review cycle is ready for apply_feedback. Read the reviewer outputs, apply any required changes, then call pp_phase_complete again to finalize this review pass and advance the phase. Do NOT stop or wait for the user — the phase is NOT complete until you re-call pp_phase_complete.";
  }
  return "[PI-PI] Review cycle is ready for apply_feedback. Read the reviewer outputs and apply any required changes.";
}

export async function enterReviewCycle(
  orchestrator: Orchestrator,
  ctx: any,
  kind: "plannotator" | string,
): Promise<string> {
  if (!orchestrator.active) return "No active task.";
  const pi = orchestrator.pi;
  const pass = orchestrator.active.state.reviewPass + 1;

  if (kind === "plannotator") {
    orchestrator.active.state.reviewCycle = { kind: "plannotator", step: "spawn_reviewers", pass };
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    const phase = orchestrator.active.state.phase;
    if (phase === "brainstorm") {
      orchestrator.active.state.reviewCycle = null;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return "Plannotator is only available for plan and implement phases. Choose another option.";
    }
    if (phase === "plan") {
      const planContent = getLatestSynthesizedPlan(orchestrator.active.dir);
      if (!planContent) {
        orchestrator.active.state.reviewCycle = null;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        return "No synthesized plan found. Choose another option.";
      }
      const payload = { planContent, planFilePath: join(orchestrator.active.dir, "plans") };

      const { opened, reviewId, outcome } = await openPlannotator(pi, "plan-review", payload);
      if (!opened) {
        orchestrator.active.state.reviewCycle = null;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        const diagnosis = outcome === "timeout"
          ? "Plannotator did not respond within 30s (is the browser extension running?)."
          : "Plannotator is not available (no handler responded — is the browser extension installed?).";
        // End with the exact "Choose another option." sentinel that
        // handleReviewResult (pp-menu.ts) matches so the inline Review menu loops
        // back for retry/another method instead of exiting with this text.
        return `${diagnosis} Retry or pick a different review method — Choose another option.`;
      }

      let result: { approved: boolean; feedback?: string };
      ctx.ui?.setWorkingMessage?.("Waiting for Plannotator plan review…");
      try {
        result = await waitForPlannotatorResult(orchestrator, reviewId);
      } catch {
        orchestrator.active.state.reviewCycle = null;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        return "Plannotator review cancelled. Choose another option.";
      } finally {
        ctx.ui?.setWorkingMessage?.();
      }
      orchestrator.active.state.reviewCycle = null;
      if (result.approved) {
        orchestrator.active.state.reviewPass += 1;
        orchestrator.active.reviewPass = orchestrator.active.state.reviewPass;
        orchestrator.active.state.step = "user_gate";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        return "Plannotator approved the plan. Choose next action.";
      }

      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      const feedback = result.feedback ? `\n\nFeedback:\n${result.feedback}` : "";
      return `Plannotator requested changes.${feedback}\n\nAddress the user's feedback. If the feedback contains questions, answer them. If it requests changes, make the changes. Then call pp_phase_complete when done.`;
    }

    orchestrator.active.state.reviewCycle = null;
    orchestrator.active.state.step = "llm_work";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    // Implement/review-phase Plannotator is driven entirely by the menu's per-repo
    // interleaved loop (pp-menu runPlannotatorCursor); it never enters this path.
    return "Plannotator code review runs per-repo from the /pp Review menu. Open /pp → Review → Review in Plannotator.";
  }

  const phase = orchestrator.active.state.phase;
  const presetName = kind || getDefaultReviewPresetName(orchestrator, phase);
  orchestrator.active.state.reviewCycle = { kind: "auto", step: "spawn_reviewers", pass };
  orchestrator.active.state.reviewerFailureAutoRetried = false;
  orchestrator.active.state.activeReviewPreset = presetName;
  saveTask(orchestrator.active.dir, orchestrator.active.state);

  const reviewers = resolveReviewers(orchestrator, phase, presetName);
  const enabledCount = Object.values(reviewers).filter((v) => isEnabled(v)).length;
  if (enabledCount === 0) {
    orchestrator.active.state.reviewCycle = null;
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    const labelGroup = reviewPresetGroupForPhase(phase);
    const label = labelGroup === "brainstormReviewers" ? "artifact" : labelGroup === "planReviewers" ? "plan" : "code";
    return `No ${label} reviewers enabled. Choose another option.`;
  }

  orchestrator.pendingSubagentSpawns = enabledCount;
    const spawnFn = reviewPresetGroupForPhase(phase) === "brainstormReviewers"
      ? () => spawnBrainstormReviewers(
        pi,
        orchestrator.cwd,
        orchestrator.active!.dir,
        orchestrator.active!.taskId,
        orchestrator.config,
        pass,
        orchestrator.transitionController.phaseSend,
        reviewers,
        orchestrator.active?.state.repos ?? [],
      )
      : reviewPresetGroupForPhase(phase) === "planReviewers"
      ? () => spawnPlanReviewers(
        pi,
        orchestrator.cwd,
        orchestrator.active!.dir,
        orchestrator.active!.taskId,
        orchestrator.config,
        pass,
        orchestrator.transitionController.phaseSend,
        reviewers,
        orchestrator.active?.state.repos ?? [],
      )
      : () => spawnCodeReviewers(
        pi,
        orchestrator.cwd,
        orchestrator.active!.dir,
        orchestrator.active!.taskId,
        orchestrator.config,
        pass,
        phase,
        orchestrator.transitionController.phaseSend,
        reviewers,
        orchestrator.active?.state.repos ?? [],
      );
  handleSpawnResult(orchestrator, spawnFn(), {
    kind: "reviewer",
    logScope: "review",
    logMessage: "spawn reviewers failed",
    logExtra: { phase },
    onSettled: (result) => tryCompleteReviewCycle(orchestrator, result?.spawned),
  });

  orchestrator.active.state.reviewCycle.step = "await_reviewers";
  orchestrator.active.state.step = "await_reviewers";
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  return `Started review cycle pass ${pass} (auto, preset: ${presetName}). Awaiting reviewers.`;
}

export async function stopTask(orchestrator: Orchestrator): Promise<string> {
  if (!orchestrator.active) return "No active task.";
  orchestrator.abortAllSubagents();
  orchestrator.active.state.reviewCycle = null;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  const desc = orchestrator.active.description;
  const type = orchestrator.active.type;
  await orchestrator.cleanupActive();
  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();

  // Route the stop/pause compaction through the controller as a "done" target.
  // The controller supplies the summary to session_before_compact and its
  // awaitable resolves at every terminus (session_compact, no-op skip,
  // already-idle), so this await never hangs and never resolves early.
  await orchestrator.transitionController.requestTransition({
    kind: "done",
    summary: `Task "${desc}" (${type}) stopped/paused.`,
  });

  return `Task "${desc}" stopped. Use /pp → Resume to continue.`;
}

// A review is LIVE when its cycle exists and reviewers are still being awaited.
// Guards the menu/autonomous callers against re-spawning reviewers on top of a
// running cycle (the "6 agents" double-spawn). NOT "a cycle object exists": a
// completed cycle is finalized (and nulled) legitimately before the next pass.
export function isReviewCycleLive(task: ActiveTask): boolean {
  return !!task.state.reviewCycle && task.state.reviewCycle.step === "await_reviewers";
}

export function finalizeReviewCycle(task: ActiveTask): void {
  if (!task.state.reviewCycle) return;
  const kind = task.state.reviewCycle.kind;
  task.state.reviewPass = task.state.reviewCycle.pass;
  task.reviewPass = task.state.reviewPass;
  incrementReviewPass(task, kind);
  task.state.reviewCycle = null;
  task.state.step = "user_gate";
  saveTask(task.dir, task.state);
}

function incrementReviewPass(task: ActiveTask, kind: string): void {
  if (!task.state.reviewPassByKind) task.state.reviewPassByKind = {};
  const phase = task.state.phase;
  if (!task.state.reviewPassByKind[phase]) task.state.reviewPassByKind[phase] = {};
  task.state.reviewPassByKind[phase][kind] = (task.state.reviewPassByKind[phase][kind] ?? 0) + 1;
}

function completedReviewPasses(task: ActiveTask, kind: string): number {
  return task.state.reviewPassByKind?.[task.state.phase]?.[kind] ?? 0;
}

export function finalizeReviewCycleAutonomous(task: ActiveTask): void {
  if (!task.state.reviewCycle) return;
  const kind = task.state.reviewCycle.kind;
  task.state.reviewPass = task.state.reviewCycle.pass;
  task.reviewPass = task.state.reviewPass;
  incrementReviewPass(task, kind);
  task.state.reviewCycle = null;
  if (task.state.phase === "plan") {
    task.state.step = "synthesize";
  } else {
    task.state.step = "llm_work";
  }
  saveTask(task.dir, task.state);
}

export function registerOrchestratorToolsForTest(orchestrator: Orchestrator): void {
  registerOrchestratorTools(orchestrator);
}

// The normal feature tools + agents, registered together so the session_start
// path and the config-error recovery path (after a successful in-session
// re-check) register the exact same set. session_start skips this when config
// loading fails, so the recovery path MUST call it too — otherwise /pp would
// expose task menus while pp_phase_complete and the other orchestration tools
// stay unregistered. Registration is idempotent (re-running replaces handlers).
export function registerFeatureToolsAndAgents(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerCommandHandlers(orchestrator);
  registerCbmTools(pi, orchestrator.cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, orchestrator.cwd);
  registerOrchestratorTools(orchestrator);
  setExtensionOnlyMode(pi);
  orchestrator.registerAgents();
}

function registerOrchestratorTools(orchestrator: Orchestrator): void {
  registerRepoTool(orchestrator);
  registerCheckoutPrHeadTool(orchestrator);
  registerPhaseCompleteTool(orchestrator);
  registerCommitTool(orchestrator);
  registerStateFileTools(orchestrator);
}

// Extension-side PR-head checkout for the review phase. Performed here (never via the
// agent prompt) so REVIEW_READONLY_CONSTRAINT stays truthful — the agent never runs
// `git checkout` itself. Lands the repo on its PR head under strict safety rules (no stash,
// no --force, no branch switch, no worktree, no detached checkout): when the tree is clean
// and on the PR head's branch but merely behind, it fast-forwards the branch to the head
// (`git merge --ff-only`, which never detaches, never rewrites, and refuses a non-ff move).
// A dirty tree, a different branch, or a non-fast-forwardable divergence all HALT with a
// message for the user. Checking HEAD's SHA first makes this re-entrant and detached-safe.
export async function checkoutPrHead(
  orchestrator: Orchestrator,
  repoPath: string,
  headRefName: string,
  headRefOid: string,
): Promise<{ ok: boolean; message: string }> {
  const pi = orchestrator.pi;
  const name = (headRefName ?? "").trim();
  const oid = (headRefOid ?? "").trim();
  if (!name && !oid) {
    return { ok: true, message: `No PR head provided for ${repoPath}; skipping (non-PR review scope).` };
  }

  const run = (args: string[]) => pi.exec("git", args, { cwd: repoPath, timeout: 15000 });
  const target = `${name || oid}${name && oid ? ` @ ${oid}` : ""}`;

  let status;
  try {
    status = await run(["status", "--porcelain"]);
  } catch (err: any) {
    return { ok: false, message: `Cannot inspect ${repoPath}: ${err?.message ?? "git status failed"}` };
  }
  if (status.code !== 0) {
    return { ok: false, message: `Cannot inspect ${repoPath}: ${status.stderr?.trim() || status.stdout?.trim() || "git status failed"}` };
  }
  if (status.stdout.trim()) {
    return {
      ok: false,
      message:
        `HALT: ${repoPath} has uncommitted changes. Commit or stash them, then bring the repo to its PR head (${target}) and ask me to continue.\n\n${status.stdout.trim()}`,
    };
  }

  if (!oid) {
    return { ok: true, message: `${repoPath}: no PR head commit provided; left as-is (clean tree).` };
  }

  let head;
  try {
    head = await run(["rev-parse", "HEAD"]);
  } catch (err: any) {
    return { ok: false, message: `Cannot read HEAD of ${repoPath}: ${err?.message ?? "git rev-parse failed"}` };
  }
  if (head.stdout.trim() === oid) {
    return { ok: true, message: `${repoPath} is on PR head ${oid}.` };
  }

  let branch;
  try {
    branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (err: any) {
    return { ok: false, message: `Cannot read current branch of ${repoPath}: ${err?.message ?? "git rev-parse failed"}` };
  }
  const currentBranch = branch.stdout.trim();
  if (currentBranch === "HEAD") {
    return {
      ok: false,
      message:
        `HALT: ${repoPath} has a detached HEAD, not at the PR head commit ${oid}. ` +
        `Check out the PR head branch${name ? ` "${name}"` : ""} at ${oid}, then ask me to continue. I will not move HEAD for you.`,
    };
  }
  if (name && currentBranch !== name) {
    return {
      ok: false,
      message:
        `HALT: ${repoPath} is on "${currentBranch}", not the PR head branch "${name}" (target commit ${oid}). ` +
        "Check out that branch at its PR head, then ask me to continue. I will not switch branches for you.",
    };
  }

  // Clean tree, on the PR head's branch, but behind: advance the branch to the head with a
  // fast-forward-only merge. This moves the branch ref without detaching, forcing, or stashing,
  // and fails safely if the branch has diverged from the PR head.
  let ff;
  try {
    ff = await run(["merge", "--ff-only", oid]);
  } catch (err: any) {
    return { ok: false, message: `Fast-forward of ${repoPath} to PR head ${oid} failed: ${err?.message ?? "git merge failed"}` };
  }
  if (ff.code !== 0) {
    return {
      ok: false,
      message:
        `HALT: ${repoPath} (branch "${currentBranch}") cannot fast-forward to PR head ${oid} — it has diverged. ` +
        `Reconcile it with the PR head, then ask me to continue. I will not force-move or rebase it for you.` +
        `${ff.stderr?.trim() ? `\n\n${ff.stderr.trim()}` : ""}`,
    };
  }

  // `git merge --ff-only <ancestor>` returns exit 0 ("Already up to date") WITHOUT moving HEAD
  // when the branch is already ahead of the PR head, so a zero exit is not proof we landed on it.
  // Re-read HEAD and HALT if the branch carries commits beyond the PR head.
  let after;
  try {
    after = await run(["rev-parse", "HEAD"]);
  } catch (err: any) {
    return { ok: false, message: `Cannot confirm HEAD of ${repoPath} after fast-forward: ${err?.message ?? "git rev-parse failed"}` };
  }
  if (after.stdout.trim() !== oid) {
    return {
      ok: false,
      message:
        `HALT: ${repoPath} (branch "${currentBranch}") is ahead of the PR head ${oid} — it has commits the PR head does not. ` +
        "Push them to the PR (or check out the exact PR head), then ask me to continue. I will not move HEAD backwards for you.",
    };
  }
  return { ok: true, message: `${repoPath} fast-forwarded to PR head ${oid}.` };
}

function registerCheckoutPrHeadTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_checkout_pr_head",
    label: "pi-pi",
    description:
      "Land a registered repository on its PR head commit before reviewing it. " +
      "Call this ONLY for a PR-scoped review, once per repo, AFTER you have resolved the PR " +
      "(e.g. via `gh pr view --json headRefName,headRefOid`). Do NOT call it for a branch, " +
      "commit-range, or uncommitted-changes review. The extension does this safely (no worktree, " +
      "no stash, no --force, no branch switch, no detached checkout): a clean repo already on the " +
      "PR head succeeds; a clean repo on the PR head's branch but behind is fast-forwarded to the " +
      "head; a dirty tree, a different branch, or a diverged branch HALTS with a message for you to " +
      "relay to the user. You never run `git checkout` yourself.",
    parameters: Type.Object({
      repoPath: Type.String({ description: "Absolute path to the registered repository" }),
      headRefName: Type.String({ description: "PR head branch name (headRefName)" }),
      headRefOid: Type.String({ description: "PR head commit SHA (headRefOid)" }),
    }),
    async execute(_toolCallId, params: any) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      const pathInput = typeof params.repoPath === "string" ? params.repoPath.trim() : "";
      if (!pathInput) {
        return { content: [{ type: "text" as const, text: "Missing repoPath." }], isError: true as const, details: {} };
      }
      const normalized = normalizeRepoPath(pathInput);
      const repos = orchestrator.active.state.repos ?? [];
      const registered = repos.find((repo) => repo.path === normalized);
      if (!registered) {
        return { content: [{ type: "text" as const, text: `Repository is not registered: ${params.repoPath}` }], isError: true as const, details: {} };
      }
      const result = await checkoutPrHead(orchestrator, registered.path, params.headRefName ?? "", params.headRefOid ?? "");
      return { content: [{ type: "text" as const, text: result.message }], isError: result.ok ? undefined : (true as const), details: {} };
    },
  });
}

function registerRepoTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_register_repo",
    label: "pi-pi",
    description:
      "Register a git repository you're working in. Call this for every repo " +
      "including the root directory at the start of each task. Pass the base " +
      "branch — the branch this work will be merged into (e.g. origin/main, origin/develop).",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the git repository (or any path inside it)" }),
      baseBranch: Type.Optional(Type.String({ description: "Base branch for this repo (e.g. origin/main)" })),
    }),
    async execute(_toolCallId, params: any) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      getLogger().debug({ s: "tool", tool: "pp_register_repo", path: params.path, baseBranch: params.baseBranch }, "register repo called");

      const pathInput = typeof params.path === "string" ? params.path.trim() : "";
      if (!pathInput) {
        return { content: [{ type: "text" as const, text: "Missing path." }], isError: true as const, details: {} };
      }

      const normalizedInputPath = normalizeRepoPath(pathInput);
      let gitCwd = normalizedInputPath;
      try {
        gitCwd = statSync(normalizedInputPath).isDirectory() ? normalizedInputPath : dirname(normalizedInputPath);
      } catch {
        gitCwd = dirname(normalizedInputPath);
      }

      let gitRoot = "";
      try {
        const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: gitCwd, timeout: 5000 });
        if (result.code !== 0) {
          return { content: [{ type: "text" as const, text: "Not a git repository." }], isError: true as const, details: {} };
        }
        gitRoot = result.stdout.trim();
      } catch {
        return { content: [{ type: "text" as const, text: "Not a git repository." }], isError: true as const, details: {} };
      }

      if (!gitRoot) {
        return { content: [{ type: "text" as const, text: "Not a git repository." }], isError: true as const, details: {} };
      }

      const normalizedRepo = normalizeRepoPath(gitRoot);
      const normalizedRoot = normalizeRepoPath(orchestrator.cwd);
      const hadRepos = Array.isArray(orchestrator.active.state.repos);
      const repos = orchestrator.active.state.repos ?? [{ path: normalizedRoot, isRoot: true }];
      const baseBranch = typeof params.baseBranch === "string" && params.baseBranch.trim().length > 0
        ? params.baseBranch.trim()
        : undefined;
      const isRoot = normalizedRepo === normalizedRoot;

      let added = false;
      let changed = !hadRepos;

      if (isRoot) {
        const existingRootIdx = repos.findIndex((repo) => repo.isRoot);
        const existingByPathIdx = repos.findIndex((repo) => repo.path === normalizedRepo);

        if (existingRootIdx >= 0) {
          const existingRoot = repos[existingRootIdx];
          if (existingRoot.path !== normalizedRepo) {
            existingRoot.path = normalizedRepo;
            changed = true;
          }
          if (!existingRoot.isRoot) {
            existingRoot.isRoot = true;
            changed = true;
          }
          if (baseBranch && existingRoot.baseBranch !== baseBranch) {
            existingRoot.baseBranch = baseBranch;
            changed = true;
          }
          if (existingByPathIdx >= 0 && existingByPathIdx !== existingRootIdx) {
            repos.splice(existingByPathIdx, 1);
            changed = true;
          }
        } else if (existingByPathIdx >= 0) {
          const existing = repos[existingByPathIdx];
          if (!existing.isRoot) {
            existing.isRoot = true;
            changed = true;
          }
          if (baseBranch && existing.baseBranch !== baseBranch) {
            existing.baseBranch = baseBranch;
            changed = true;
          }
        } else {
          repos.push({ path: normalizedRepo, isRoot: true, ...(baseBranch ? { baseBranch } : {}) });
          added = true;
          changed = true;
        }
      } else {
        const existingByPathIdx = repos.findIndex((repo) => repo.path === normalizedRepo);
        if (existingByPathIdx >= 0) {
          const existing = repos[existingByPathIdx];
          if (baseBranch && existing.baseBranch !== baseBranch) {
            existing.baseBranch = baseBranch;
            changed = true;
          }
        } else {
          repos.push({ path: normalizedRepo, isRoot: false, ...(baseBranch ? { baseBranch } : {}) });
          added = true;
          changed = true;
        }
      }

      orchestrator.active.state.repos = repos;
      if (changed) {
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }

      if (added) {
        unregisterAgentDefinitions(orchestrator.pi);
        orchestrator.registerAgents();
      }

      const registered = repos.find((repo) => repo.path === normalizedRepo) ?? {
        path: normalizedRepo,
        isRoot,
        ...(baseBranch ? { baseBranch } : {}),
      };
      const rootLabel = registered.isRoot ? " (root)" : "";
      const baseLabel = registered.baseBranch ? `, base: ${registered.baseBranch}` : "";
      const action = added ? "Registered" : changed ? "Updated" : "Already registered";

      return {
        content: [{ type: "text" as const, text: `${action} repository: ${registered.path}${rootLabel}${baseLabel}` }],
        details: {},
      };
    },
  });
}

function registerCommitTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_commit",
    label: "pi-pi",
    description:
      "Commit modified files with a descriptive message. Call after completing a logical " +
      "unit of work (e.g. implementing one plan item, fixing a bug, adding a test). " +
      "The message should describe WHAT changed and WHY, not list files. " +
      "Prefix the message with a conventional-commit type (fix:, feat:, or chore:) " +
      "unless the user asked for a different commit style.",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message describing the change (max 72 chars for first line)" }),
      repo: Type.Optional(Type.String({ description: "Absolute path to the repo to commit in. Defaults to root." })),
    }),
    async execute(_toolCallId, params: any) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      if (!orchestrator.config.general.autoCommit) {
        return { content: [{ type: "text" as const, text: "autoCommit is disabled in config." }], details: {} };
      }

      const repos = orchestrator.active.state.repos ?? [];
      const rootRepo = findRootRepo(repos);
      const defaultRepoPath = rootRepo?.path ?? orchestrator.cwd;
      let commitRepoPath = defaultRepoPath;
      if (typeof params.repo === "string" && params.repo.trim().length > 0) {
        const normalized = normalizeRepoPath(params.repo);
        const registered = repos.find((repo) => repo.path === normalized);
        if (!registered) {
          return { content: [{ type: "text" as const, text: `Repository is not registered: ${params.repo}` }], isError: true as const, details: {} };
        }
        commitRepoPath = registered.path;
      }

      const files: string[] = [];
      try {
        const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: commitRepoPath, timeout: 5000 });
        if (statusResult.code === 0 && statusResult.stdout.trim()) {
          for (const rawLine of statusResult.stdout.split("\n")) {
            const line = rawLine.trimEnd();
            if (!line) continue;
            const pathPart = line.slice(3);
            if (!pathPart) continue;
            const finalPath = pathPart.includes(" -> ") ? pathPart.split(" -> ").at(-1)! : pathPart;
            if (!files.includes(finalPath)) {
              files.push(finalPath);
            }
          }
        }
      } catch {}
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No modified files to commit." }], details: {} };
      }
      const result = autoCommit(files, params.message, commitRepoPath);
      if (result.ok) {
        const remaining = [...orchestrator.active.modifiedFiles].filter((file) => {
          const absoluteFile = resolve(orchestrator.cwd, file);
          const repo = resolveRepoForFile(repos, absoluteFile);
          return repo?.path !== commitRepoPath;
        });
        orchestrator.active.modifiedFiles = new Set(remaining);
        orchestrator.active.state.modifiedFiles = [...orchestrator.active.modifiedFiles];
        const committed = new Set(orchestrator.active.state.committedFiles ?? []);
        for (const file of files) committed.add(file);
        orchestrator.active.state.committedFiles = [...committed];
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        orchestrator.commitReminderSent = false;
        return { content: [{ type: "text" as const, text: `Committed ${files.length} file(s): ${result.commitHash ?? "ok"}` }], details: {} };
      }
      return { content: [{ type: "text" as const, text: `Commit failed: ${result.error}` }], isError: true as const, details: {} };
    },
  });
}

function registerPhaseCompleteTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_phase_complete",
    label: "pi-pi",
    description:
      "Call when the current phase is complete. Shows a dialog to the user for " +
      "approval. The user's choice is returned — act on it accordingly.",
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of what was accomplished in this phase" }),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      const step = orchestrator.active.state.step;
      if (step === "await_planners" || step === "await_reviewers") {
        return { content: [{ type: "text" as const, text: "Subagents are still running. Wait for them to complete before calling pp_phase_complete." }], isError: true as const, details: {} };
      }
      if (orchestrator.spawnedAgentIds.size > 0 || orchestrator.pendingSubagentSpawns > 0) {
        const count = orchestrator.spawnedAgentIds.size + orchestrator.pendingSubagentSpawns;
        return { content: [{ type: "text" as const, text: `${count} subagent(s) still running. Wait for them to complete before calling pp_phase_complete.` }], isError: true as const, details: {} };
      }
      // Gate on the effective PHASE mode, not the task mode: brainstorm/debug/
      // review are always user-driven even for an autonomous task, so they must
      // fall through to the guided menu path below rather than auto-advancing.
      const effectiveMode = getEffectivePhaseMode(orchestrator.active.state);
      if (effectiveMode === "autonomous") {
        const phase = orchestrator.active.state.phase;
        let justFinalizedReviewCycle = false;
        if (orchestrator.active.state.reviewCycle?.step === "apply_feedback") {
          const completedRound = orchestrator.active.state.reviewCycle.pass;
          const completedPreset = normalizeStoredReviewPresetName(orchestrator, phase);
          const enabledReviewerCount = Object.values(resolveReviewers(orchestrator, phase, completedPreset)).filter((v) => isEnabled(v)).length;
          finalizeReviewCycleAutonomous(orchestrator.active);
          justFinalizedReviewCycle = true;
          if (reviewPassUnanimousApprove(orchestrator.active.dir, phase, completedRound, enabledReviewerCount)) {
            orchestrator.active.state.reviewApprovedClean = true;
            saveTask(orchestrator.active.dir, orchestrator.active.state);
          }
        }
        const phaseConfig = orchestrator.active.state.autonomousConfig?.phases?.[phase];
        const reviewPreset = phaseConfig?.reviewPreset;
        const maxReviewPasses = phaseConfig?.maxReviewPasses ?? 0;
        const completedAutoPasses = orchestrator.active.state.reviewPassByKind?.[phase]?.auto ?? 0;

        if (
          justFinalizedReviewCycle &&
          !orchestrator.active.state.reviewApprovedClean &&
          reviewPreset &&
          maxReviewPasses > 0 &&
          completedAutoPasses < maxReviewPasses
        ) {
          return {
            content: [{ type: "text" as const, text: `The review pass found changes to make. Apply the reviewers' required changes, then call pp_phase_complete again to re-review (pass ${completedAutoPasses + 1}/${maxReviewPasses >= 999 ? "∞" : maxReviewPasses}). Do NOT wait for the user and do NOT advance the phase.` }],
            details: {},
          };
        }

        if (
          !justFinalizedReviewCycle &&
          !orchestrator.active.state.reviewApprovedClean &&
          reviewPreset &&
          maxReviewPasses > 0 &&
          completedAutoPasses < maxReviewPasses
        ) {
          const exitCheck = validateExitCriteria(orchestrator.active.dir, orchestrator.active.type, phase);
          if (!exitCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `Cannot start review yet: ${exitCheck.reason}\n\nFix this and call pp_phase_complete again. Do NOT wait for the user.` }],
              details: {},
            };
          }
          const reviewText = await enterReviewCycle(orchestrator, ctx, reviewPreset);
          if (orchestrator.active?.state.step === "await_reviewers") {
            return {
              content: [{ type: "text" as const, text: `Reviews are running (${reviewPreset}, pass ${completedAutoPasses + 1}/${maxReviewPasses >= 999 ? "∞" : maxReviewPasses}). You will be notified automatically when the reviewer outputs are ready — then read them and proceed. Do NOT wait for the user and do NOT stop.` }],
              details: {},
            };
          }
          if (!reviewText.includes("No") || !reviewText.includes("reviewers enabled")) {
            return { content: [{ type: "text" as const, text: reviewText }], details: {} };
          }
        }

        // Terminal handoff (#1): an autonomous IMPLEMENT phase whose next phase is
        // "done" should NOT auto-complete. Run afterImplement (transitionToNextPhase
        // is skipped here, so run it explicitly — once), then open the GUIDED
        // implement menu and wait, instead of tearing the task down.
        if (phase === "implement" && nextPhase(orchestrator.active.type, phase) === "done") {
          if (!orchestrator.active.state.afterImplementRan) {
            const afterError = runAfterImplementForActive(orchestrator);
            if (afterError) {
              return { content: [{ type: "text" as const, text: `${afterError}\n\nDo NOT wait for the user — fix these and call pp_phase_complete again.` }], details: {} };
            }
            orchestrator.active.state.afterImplementRan = true;
            saveTask(orchestrator.active.dir, orchestrator.active.state);
          }
          ctx.ui.setWorkingMessage?.("Waiting for user approval…");
          try {
            const { showActiveTaskMenu, USER_CANCELLED } = await import("./pp-menu.js");
            const text = await showActiveTaskMenu(orchestrator, ctx, params.summary, "tool", true);
            if (text === USER_CANCELLED) {
              ctx.abort?.();
              return { content: [{ type: "text" as const, text: "" }], details: {} };
            }
            return { content: [{ type: "text" as const, text: text ?? "" }], details: {} };
          } finally {
            ctx.ui.setWorkingMessage?.();
          }
        }

        const plannerPreset = orchestrator.active.state.autonomousConfig?.phases?.plan?.plannerPreset;
        const result = await orchestrator.transitionToNextPhase(ctx, plannerPreset);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Transition blocked: ${result.error}` }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "" }], details: {} };
      }
      ctx.ui.setWorkingMessage?.("Waiting for user approval…");
      try {
        const { showActiveTaskMenu, USER_CANCELLED } = await import("./pp-menu.js");
        const text = await showActiveTaskMenu(orchestrator, ctx, params.summary, "tool");
        // A deliberate user ESC on the menu means "stop cleanly, let me type" —
        // mirror ask_user: abort the turn and return nothing so no new LLM turn
        // starts. This takes precedence over the reminder path below, in ALL
        // interactive cases (including while a transition is mid-flight).
        if (text === USER_CANCELLED) {
          ctx.abort?.();
          return { content: [{ type: "text" as const, text: "" }], details: {} };
        }
        // A transition or await may have started while the menu was open. The
        // controller is the source of truth; abort the pending turn so it can't
        // race. (Interactive-UX abort — stays local, not routed.)
        const curStep = orchestrator.active?.state.step;
        if (curStep === "await_planners" || curStep === "await_reviewers") {
          ctx.abort?.();
          return { content: [{ type: "text" as const, text: `Waiting for ${curStep === "await_planners" ? "planners" : "reviewers"} to complete. Do NOT proceed until notified.` }], details: {} };
        }
        if (!orchestrator.transitionController.isRunning()) {
          ctx.abort?.();
          return { content: [{ type: "text" as const, text: "" }], details: {} };
        }
        if (!text) {
          // Non-ESC dismissal (explicit "Back") while a transition is running:
          // keep the intentional artifact-update reminder (commit 10e7021).
          return { content: [{ type: "text" as const, text: "User dismissed the menu. Wait for the user's next message. When you resume work, update USER_REQUEST.md and RESEARCH.md with any new findings before calling pp_phase_complete." }], details: {} };
        }
        return { content: [{ type: "text" as const, text }], details: {} };
      } finally {
        ctx.ui.setWorkingMessage?.();
      }
    },
  });
}

function registerMainTraceHooks(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  // These hooks are registered only on the root orchestrator session
  // (registerEventHandlers is never called from the subagent branch in index.ts),
  // so they only ever receive root-session events — no SUBAGENT_SESSION_KEY gate needed.

  pi.on("before_agent_start", async (event) => {
    getTracer()?.traceMain("before_agent_start", {
      prompt: event.prompt,
      images: event.images,
      systemPrompt: event.systemPrompt,
    });
  });
  pi.on("agent_start", async () => {
    getTracer()?.traceMain("agent_start", {});
  });
  pi.on("agent_end", async (event) => {
    getTracer()?.traceMain("agent_end", { messages: event.messages });
  });
  pi.on("turn_start", async (event) => {
    const tracer = getTracer();
    if (tracer) tracer.turnIndex = event.turnIndex;
    tracer?.traceMain("turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
  });
  pi.on("turn_end", async (event) => {
    const tracer = getTracer();
    if (tracer) tracer.turnIndex = event.turnIndex;
    tracer?.traceMain("turn_end", { turnIndex: event.turnIndex, message: event.message, toolResults: event.toolResults });
  });
  pi.on("message_start", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("message_start", { turnIndex: tracer.turnIndex, message: event.message });
  });
  pi.on("message_update", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("message_update", { turnIndex: tracer.turnIndex, assistantMessageEvent: event.assistantMessageEvent });
  });
  pi.on("message_end", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("message_end", { turnIndex: tracer.turnIndex, message: event.message });
  });
  pi.on("tool_execution_start", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("tool_execution_start", { turnIndex: tracer.turnIndex, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
  });
  pi.on("tool_execution_update", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("tool_execution_update", { turnIndex: tracer.turnIndex, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, partialResult: event.partialResult });
  });
  pi.on("tool_execution_end", async (event) => {
    markMainTurnActivity(orchestrator);
    const tracer = getTracer();
    tracer?.traceMain("tool_execution_end", { turnIndex: tracer.turnIndex, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
  });
}

// Main-turn watchdog activity helpers (BUG-2). Kept module-level so they can be
// called from the several existing main-session handlers without registering a
// second handler per event.
function markMainTurnActivity(orchestrator: Orchestrator): void {
  orchestrator.mainTurnLastActivity = Date.now();
}

function endMainTurn(orchestrator: Orchestrator): void {
  orchestrator.mainTurnInFlight = false;
  orchestrator.mainTurnRecovering = false;
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  registerMainTraceHooks(orchestrator);

  // Personal-subscription Claude routing registers the sub provider with a
  // literal OAuth token (a static snapshot). That token expires within a few
  // hours, so a long-lived session would keep sending a stale token and the
  // gateway would return 401. Refresh (and re-register on change) before each
  // turn's LLM call. Cheap no-op when subscription routing is inactive or the
  // token is unchanged. registerEventHandlers runs only on the root session.
  pi.on("turn_start", async () => {
    try {
      const { refreshSubProvider } = await import("./flant-infra.js");
      await refreshSubProvider(pi);
    } catch (err: any) {
      getLogger().debug({ s: "flant", err: err?.message }, "sub provider refresh failed");
    }
  });

  // TransitionController drivers. These are the reliable idle/completion signals:
  //   - agent_end: the main loop went idle. If a transition is pending, this is
  //     when the controller fires compaction.
  //   - session_compact: compaction finished. The controller resumes (injects
  //     context/artifacts + sends the next instruction).
  // The SDK supports multiple handlers per event, so these coexist with the
  // trace-only hooks registered above. registerEventHandlers is never called on
  // the subagent branch, so these only ever see root-session events.
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx) orchestrator.lastCtx = ctx;
    endMainTurn(orchestrator);
    orchestrator.transitionController.onAgentEnd();
  });
  pi.on("session_compact", async (_event, ctx) => {
    if (ctx) orchestrator.lastCtx = ctx;
    orchestrator.transitionController.onSessionCompact();
  });

  // BUG-2: main-turn stall watchdog. A main turn can start (turn_start / manual
  // "continue" / SDK auto-retry) and then wedge with no terminal turn_end, so the
  // session sits "Working…" forever with nothing to recover it (the SDK-retryable
  // deferral below arms nothing, and startStaleAgentWatchdog only watches
  // subagents). Activity is marked from the existing main-session handlers
  // (turn_start below, tool_call, tool_result, turn_end) so we do NOT register a
  // second handler per event (the runtime allows it, but keeping one owner per
  // event is simpler and test-mock-friendly). When a turn is in flight with NO
  // activity beyond the configured threshold, abort + recover via the idle-gated
  // single-send path so recovery can't itself race into "Agent is already
  // processing".
  const startMainTurnWatchdog = () => {
    if (orchestrator.mainTurnTimer) return;
    orchestrator.mainTurnTimer = setInterval(() => {
      if (!orchestrator.active) {
        clearInterval(orchestrator.mainTurnTimer!);
        orchestrator.mainTurnTimer = null;
        return;
      }
      if (!orchestrator.mainTurnInFlight || orchestrator.mainTurnRecovering) return;
      // Only a genuinely stuck turn is a target: an idle session (turn already
      // settled), an in-progress transition, or an await_* step is not a stall.
      if (orchestrator.transitionController.isTransitioning()) return;
      const step = orchestrator.active.state.step;
      if (step === "await_planners" || step === "await_reviewers") return;
      // A turn parked on an open user-facing dialogue (ask_user / the /pp menu /
      // any interactive selectOption / the rate-limit fallback switch) is
      // user-gated, not wedged — do not abort it out from under the user.
      if (orchestrator.interactivePromptOpen || orchestrator.subFallbackDialogPending) return;
      const staleMs = orchestrator.config.performance.internals.mainTurnStale;
      if (Date.now() - orchestrator.mainTurnLastActivity <= staleMs) return;

      orchestrator.mainTurnRecovering = true;
      const taskToken = orchestrator.activeTaskToken;
      const phase = orchestrator.active.state.phase;
      getLogger().warn({ s: "watchdog", phase, staleMs }, "main turn wedged — aborting and recovering");
      orchestrator.lastCtx?.ui?.notify?.(
        `Main turn stalled with no activity for ${Math.round(staleMs / 1000)}s — recovering.`,
        "warning",
      );
      try {
        orchestrator.transitionController.abortMainAgent(orchestrator.lastCtx?.abort?.bind(orchestrator.lastCtx));
      } catch {}
      orchestrator.mainTurnInFlight = false;
      orchestrator.sendUserMessageWhenIdle(
        `[PI-PI] The previous turn stalled without completing. Continue working on the current phase (${phase}).`,
        taskToken,
      );
    }, 30000);
  };

  pi.on("turn_start", async (_event, ctx) => {
    if (ctx) orchestrator.lastCtx = ctx;
    orchestrator.mainTurnInFlight = true;
    orchestrator.mainTurnRecovering = false;
    markMainTurnActivity(orchestrator);
    startMainTurnWatchdog();
  });

  // Expose the event-driven planner-completion check so initial plan-entry
  // spawns (in command-handlers / orchestrator) can wire it as their onSettled
  // safety net (the deleted poller's former role). checkPlannerCompletion is a
  // hoisted function declaration below.
  orchestrator.checkPlannerCompletion = () => checkPlannerCompletion();

  function getUsageTracker(): UsageTracker | undefined {
    return (globalThis as any)[USAGE_TRACKER_KEY] as UsageTracker | undefined;
  }

  function trackSubagentEvent(data: any, event: "created" | "started" | "first_tool" | "first_turn" | "completed" | "failed"): void {
    if (!orchestrator.active || !data?.id) return;
    const now = Date.now();
    const lifecycle = orchestrator.agentLifecycle.get(data.id) ?? {};
    if (data.type && lifecycle.type == null) lifecycle.type = data.type;
    if (data.description && lifecycle.description == null) lifecycle.description = data.description;
    lifecycle.phase = orchestrator.active.state.phase;
    lifecycle.step = orchestrator.active.state.step ?? undefined;
    lifecycle.lastEventAt = now;
    if (event === "created" && lifecycle.createdAt == null) lifecycle.createdAt = now;
    if (event === "started" && lifecycle.startedAt == null) lifecycle.startedAt = now;
    if (event === "first_tool" && lifecycle.firstToolAt == null) lifecycle.firstToolAt = now;
    if (event === "first_turn" && lifecycle.firstTurnAt == null) lifecycle.firstTurnAt = now;
    orchestrator.agentLifecycle.set(data.id, lifecycle);

    getTracer()?.traceMain("subagent_lifecycle", {
      event,
      subagentId: data.id,
      type: data.type ?? lifecycle.type,
      description: data.description ?? lifecycle.description,
      parentToolCallId: data.toolCallId,
      phase: lifecycle.phase,
      step: lifecycle.step,
      toolName: data.toolName,
      turnCount: data.turnCount,
      tokens: data.tokens,
      durationMs: data.durationMs,
      toolUses: data.toolUses,
      modelId: data.modelId,
      status: data.status,
      error: data.error,
      result: data.result,
    });

    const ageMs = lifecycle.createdAt == null ? 0 : now - lifecycle.createdAt;
    const startedDeltaMs = lifecycle.startedAt == null || lifecycle.createdAt == null ? undefined : lifecycle.startedAt - lifecycle.createdAt;
    const firstToolDeltaMs = lifecycle.firstToolAt == null || lifecycle.createdAt == null ? undefined : lifecycle.firstToolAt - lifecycle.createdAt;
    const firstTurnDeltaMs = lifecycle.firstTurnAt == null || lifecycle.createdAt == null ? undefined : lifecycle.firstTurnAt - lifecycle.createdAt;
    const pending = orchestrator.pendingSubagentSpawns;
    const running = orchestrator.spawnedAgentIds.size;
    const desc = data.description || lifecycle.description || data.type || lifecycle.type || data.id;
    getLogger().debug({
      s: "subagent",
      id: data.id,
      event,
      description: desc,
      type: data.type ?? lifecycle.type ?? null,
      phase: lifecycle.phase ?? null,
      step: lifecycle.step ?? null,
      running,
      pending,
      ageMs,
      createdToStartedMs: startedDeltaMs ?? null,
      createdToFirstToolMs: firstToolDeltaMs ?? null,
      createdToFirstTurnMs: firstTurnDeltaMs ?? null,
      toolName: data.toolName ?? null,
      turnCount: data.turnCount ?? null,
    }, "subagent lifecycle event");
  }

  function startStaleAgentWatchdog(): void {
    if (orchestrator.staleAgentTimer) return;
    orchestrator.staleAgentTimer = setInterval(() => {
      if (!orchestrator.active || orchestrator.agentSpawnTimes.size === 0) {
        clearInterval(orchestrator.staleAgentTimer!);
        orchestrator.staleAgentTimer = null;
        return;
      }
      const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const now = Date.now();
      const staleMs = orchestrator.config.performance.internals.subagentStale;
      for (const [id, spawnTime] of orchestrator.agentSpawnTimes) {
        const record = mgr?.getRecord?.(id);
        if (record?.status === "running" || record?.status === "queued") continue;
        const lastActivity = orchestrator.agentLifecycle.get(id)?.lastEventAt ?? spawnTime;
        if (now - lastActivity > staleMs) {
          const desc = orchestrator.agentDescriptions.get(id) || id;
          pi.events.emit("subagents:rpc:stop", { requestId: crypto.randomUUID(), agentId: id });
          orchestrator.spawnedAgentIds.delete(id);
          orchestrator.agentSpawnTimes.delete(id);
          orchestrator.agentDescriptions.delete(id);
          orchestrator.agentLifecycle.delete(id);
          orchestrator.transitionController.sendCustom(
            {
              customType: "pp-agent-stale",
              content: `Aborted stale agent "${desc}" — no completion after ${Math.round(staleMs / 1000)}s.`,
              display: true,
            },
            "context",
          );
        }
      }
      if (orchestrator.agentSpawnTimes.size === 0) {
        clearInterval(orchestrator.staleAgentTimer!);
        orchestrator.staleAgentTimer = null;
      }
    }, 30000);
  }

  // An agent-invoked ask_user dialogue must suppress the main-turn stall
  // watchdog exactly like pi-pi's own selectOption does; otherwise a prompt the
  // user leaves open (or cancels) can trip a false 600s "stalled" recovery. The
  // flag is set while ANY ask_user UI is open and cleared on every terminal path
  // (answer, cancel, tool error).
  pi.events.on("ask:opened", () => {
    orchestrator.interactivePromptOpen = true;
  });
  pi.events.on("ask:answered", () => {
    orchestrator.interactivePromptOpen = false;
  });
  pi.events.on("ask:cancelled", () => {
    orchestrator.interactivePromptOpen = false;
  });

  pi.events.on("subagents:created", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    orchestrator.spawnedAgentIds.add(data.id);
    orchestrator.agentSpawnTimes.set(data.id, Date.now());
    if (orchestrator.pendingSubagentSpawns > 0) orchestrator.pendingSubagentSpawns--;
    if (data.description) {
      orchestrator.agentDescriptions.set(data.id, data.description);
    }

    trackSubagentEvent(data, "created");
    // Nudge acceptance/suppression is driven from the root `Agent` tool-call observation
    // (main-initiated by construction), NOT here — this event also fires for lineage-less
    // nested spawns, which must not count as the main agent following a nudge.

    startStaleAgentWatchdog();
    const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    mgr?.refreshWidget?.(orchestrator.lastCtx?.ui);
  });

  pi.events.on("subagents:started", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    trackSubagentEvent(data, "started");
  });

  pi.events.on("subagents:first_tool", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    trackSubagentEvent(data, "first_tool");
  });

  pi.events.on("subagents:first_turn", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    trackSubagentEvent(data, "first_turn");
  });

  function markAllAgentsConsumed(): void {
    const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    if (!mgr?.getRecord) return;
    for (const id of orchestrator.agentDescriptions.keys()) {
      const record = mgr.getRecord(id);
      if (record) record.resultConsumed = true;
    }
  }

  function checkPlannerCompletion(): void {
    if (
      !orchestrator.active ||
      orchestrator.active.state.phase !== "plan" ||
      orchestrator.active.state.step !== "await_planners" ||
      orchestrator.spawnedAgentIds.size > 0 ||
      orchestrator.pendingSubagentSpawns > 0 ||
      orchestrator.transitionController.isTransitioning()
    ) return;

    const plansDir = join(orchestrator.active.dir, "plans");
    const hasPlanFiles = existsSync(plansDir) &&
      readdirSync(plansDir).some((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"));

    const failedPlannerVariants = [...orchestrator.failedPlannerVariants];
    const effectiveMode = getEffectiveMode(orchestrator.active.state);
    // Do NOT auto-retry failed variants while a subscription-429 fallback decision
    // is in flight: re-spawning now would use the still-sub-routed model and
    // re-hit the limit. Once the user decides, the fallback nudge re-drives this.
    if (
      effectiveMode === "autonomous" &&
      failedPlannerVariants.length > 0 &&
      !orchestrator.subFallbackPendingDecision
    ) {
      const alreadyRetried = orchestrator.active.state.plannerFailureAutoRetried === true;
      if (!alreadyRetried) {
        const failedSet = new Set(failedPlannerVariants);
        const presetName = normalizeStoredPlannerPresetName(orchestrator);
        const planners = resolvePreset(orchestrator.config, "planners", presetName);
        const scopedPlanners: typeof planners = {};
        for (const [name, cfg] of Object.entries(planners)) {
          if (failedSet.has(name)) scopedPlanners[name] = cfg;
        }
        const retryCount = Object.keys(scopedPlanners).length;
        if (retryCount > 0) {
          orchestrator.active.state.plannerFailureAutoRetried = true;
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          orchestrator.failedPlannerVariants = [];
          orchestrator.pendingSubagentSpawns = retryCount;
          handleSpawnResult(
            orchestrator,
            spawnPlanners(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              orchestrator.transitionController.phaseSend,
              scopedPlanners,
              orchestrator.active?.state.repos ?? [],
            ),
            {
              kind: "planner",
              logScope: "planner",
              logMessage: "retry spawnPlanners failed",
              onSettled: checkPlannerCompletion,
            },
          );
          orchestrator.safeSendUserMessage(`[PI-PI] Retrying failed planners once: ${failedPlannerVariants.join(", ")}.`);
          return;
        }
      }

      orchestrator.failedPlannerVariants = [];
      orchestrator.active.state.plannerFailureAutoRetried = false;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      if (!hasPlanFiles) {
        // Custom (sendMessage) followUp does NOT start a turn when the agent is
        // idle (SDK agent-session.js) — emit the payload as display context and
        // start the synthesizer turn via safeSendUserMessage (sendUserMessage
        // always triggers a turn).
        orchestrator.transitionController.sendCustom(
          {
            customType: "pp-planners-error",
            content: "All planner subagents failed. Continue without planner outputs and synthesize the plan yourself.",
            display: true,
          },
          "context",
        );
        orchestrator.safeSendUserMessage("[PI-PI] All planners failed. Synthesize the plan yourself based on USER_REQUEST.md and RESEARCH.md.");
      } else {
        orchestrator.safeSendUserMessage("[PI-PI] Some planners failed. Continue with available planner outputs.");
      }
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return;
    }

    if (
      failedPlannerVariants.length > 0 &&
      effectiveMode !== "autonomous" &&
      !orchestrator.plannerFailureDialogPending &&
      orchestrator.lastCtx
    ) {
      orchestrator.plannerFailureDialogPending = true;
      void (async () => {
        try {
          const variantsText = failedPlannerVariants.join(", ");
          const question = hasPlanFiles
            ? `Some planners failed: ${variantsText}. Choose how to proceed.`
            : `All planner outputs failed: ${variantsText}. Choose how to proceed.`;
          const options = hasPlanFiles
            ? ["Retry failed planners", "Work with available planner outputs", "Stop task"]
            : ["Retry failed planners", "Stop task"];
          const choice = await selectOption(orchestrator.lastCtx, question, options);

          if (choice === "Retry failed planners") {
            const failedSet = new Set(failedPlannerVariants);
            const presetName = normalizeStoredPlannerPresetName(orchestrator);
            const planners = resolvePreset(orchestrator.config, "planners", presetName);
            const scopedPlanners: typeof planners = {};
            for (const [name, cfg] of Object.entries(planners)) {
              if (failedSet.has(name)) scopedPlanners[name] = cfg;
            }
            const retryCount = Object.keys(scopedPlanners).length;
            if (retryCount > 0) {
              orchestrator.failedPlannerVariants = [];
              orchestrator.pendingSubagentSpawns = retryCount;
              handleSpawnResult(
                orchestrator,
                spawnPlanners(
                  pi,
                  orchestrator.cwd,
                  orchestrator.active!.dir,
                  orchestrator.active!.taskId,
                  orchestrator.config,
                  orchestrator.transitionController.phaseSend,
                  scopedPlanners,
                  orchestrator.active?.state.repos ?? [],
                ),
                {
                  kind: "planner",
                  logScope: "planner",
                  logMessage: "retry spawnPlanners failed",
                  onSettled: checkPlannerCompletion,
                },
              );
              orchestrator.safeSendUserMessage(`[PI-PI] Retrying failed planners: ${variantsText}.`);
              return;
            }
          }

          if (choice === "Stop task") {
            orchestrator.safeSendUserMessage(`[PI-PI] ${await stopTask(orchestrator)}`);
            return;
          }

          if (hasPlanFiles) {
            orchestrator.failedPlannerVariants = [];
          }
        } finally {
          orchestrator.plannerFailureDialogPending = false;
          checkPlannerCompletion();
        }
      })();
      return;
    }

    if (!hasPlanFiles) {
      // Display payload as context; start the synthesizer turn via safeSendUserMessage
      // (a custom followUp message does not start an idle turn).
      orchestrator.transitionController.sendCustom(
        {
          customType: "pp-planners-error",
          content: "All planner subagents finished but no plan files were produced. You must create the plan yourself based on USER_REQUEST.md and RESEARCH.md.",
          display: true,
        },
        "context",
      );
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      orchestrator.safeSendUserMessage("[PI-PI] No plan files were produced. Create the plan yourself based on USER_REQUEST.md and RESEARCH.md.");
      return;
    }

    orchestrator.failedPlannerVariants = [];
    orchestrator.active.state.plannerFailureAutoRetried = false;
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    markAllAgentsConsumed();
    orchestrator.active.state.step = "synthesize";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    orchestrator.safeSendUserMessage("[PI-PI] All planners completed. Read their outputs and synthesize the plan.");
  }

  function checkReviewCycleCompletion(): void {
    if (
      !orchestrator.active?.state.reviewCycle ||
      orchestrator.active.state.reviewCycle.step !== "await_reviewers" ||
      orchestrator.spawnedAgentIds.size > 0 ||
      orchestrator.pendingSubagentSpawns > 0 ||
      orchestrator.transitionController.isTransitioning()
    ) return;

    const failedReviewerVariants = [...orchestrator.failedReviewerVariants];
    const effectiveMode = getEffectiveMode(orchestrator.active.state);
    // See the planner path: suppress auto-retry while a sub-429 fallback decision
    // is pending so we don't re-spawn on the still-sub-routed model.
    if (
      effectiveMode === "autonomous" &&
      failedReviewerVariants.length > 0 &&
      !orchestrator.subFallbackPendingDecision
    ) {
      const cycle = orchestrator.active.state.reviewCycle;
      const phase = orchestrator.active.state.phase;
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      const alreadyRetried = orchestrator.active.state.reviewerFailureAutoRetried === true;
      if (!alreadyRetried) {
        const presetName = normalizeStoredReviewPresetName(orchestrator, phase);
        const sourceReviewers = resolveReviewers(orchestrator, phase, presetName);
        const failedSet = new Set(failedReviewerVariants);
        const scopedReviewers: typeof sourceReviewers = {};
        for (const [name, cfg] of Object.entries(sourceReviewers)) {
          if (failedSet.has(name)) scopedReviewers[name] = cfg;
        }
        const retryCount = Object.keys(scopedReviewers).length;
        if (retryCount > 0) {
          const spawnFn = reviewPresetGroupForPhase(phase) === "brainstormReviewers"
            ? () => spawnBrainstormReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              orchestrator.transitionController.phaseSend,
              scopedReviewers,
              orchestrator.active?.state.repos ?? [],
            )
            : reviewPresetGroupForPhase(phase) === "planReviewers"
            ? () => spawnPlanReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              orchestrator.transitionController.phaseSend,
              scopedReviewers,
              orchestrator.active?.state.repos ?? [],
            )
            : () => spawnCodeReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              phase,
              orchestrator.transitionController.phaseSend,
              scopedReviewers,
              orchestrator.active?.state.repos ?? [],
            );
          orchestrator.active.state.reviewerFailureAutoRetried = true;
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          orchestrator.failedReviewerVariants = [];
          orchestrator.pendingSubagentSpawns = retryCount;
          cycle.step = "await_reviewers";
          orchestrator.active.state.step = "await_reviewers";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          handleSpawnResult(orchestrator, spawnFn(), {
            kind: "reviewer",
            logScope: "review",
            logMessage: "retry spawn reviewers failed",
            logExtra: { phase },
            onSettled: checkReviewCycleCompletion,
          });
          orchestrator.safeSendUserMessage(`[PI-PI] Retrying failed reviewers once: ${failedReviewerVariants.join(", ")}.`);
          return;
        }
      }

      orchestrator.failedReviewerVariants = [];
      orchestrator.active.state.reviewerFailureAutoRetried = false;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      if (outputs.length === 0) {
        finalizeReviewCycleAutonomous(orchestrator.active);
        orchestrator.safeSendUserMessage("[PI-PI] All reviewers failed twice. Continue without reviewer outputs and proceed with best judgment.");
        return;
      }
      orchestrator.safeSendUserMessage("[PI-PI] Some reviewers failed. Continue with available reviewer outputs.");
    }

    if (
      failedReviewerVariants.length > 0 &&
      effectiveMode !== "autonomous" &&
      !orchestrator.reviewerFailureDialogPending &&
      orchestrator.lastCtx
    ) {
      orchestrator.reviewerFailureDialogPending = true;
      void (async () => {
        try {
          const variantsText = failedReviewerVariants.join(", ");
          const choice = await selectOption(
            orchestrator.lastCtx,
            `Some reviewers failed: ${variantsText}. Choose how to proceed.`,
            ["Retry failed reviewers", "Work with available reviewer outputs", "Continue without review", "Stop task"],
          );

          if (choice === "Retry failed reviewers") {
            const cycle = orchestrator.active?.state.reviewCycle;
            if (cycle) {
              const pass = cycle.pass;
              const phase = orchestrator.active!.state.phase;
              const presetName = normalizeStoredReviewPresetName(orchestrator, phase);
              const sourceReviewers = resolveReviewers(orchestrator, phase, presetName);
              const failedSet = new Set(failedReviewerVariants);
              const scopedReviewers: typeof sourceReviewers = {};
              for (const [name, cfg] of Object.entries(sourceReviewers)) {
                if (failedSet.has(name)) scopedReviewers[name] = cfg;
              }
              const retryCount = Object.keys(scopedReviewers).length;
              if (retryCount > 0) {
                const spawnFn = reviewPresetGroupForPhase(phase) === "brainstormReviewers"
                  ? () => spawnBrainstormReviewers(
                    pi,
                    orchestrator.cwd,
                    orchestrator.active!.dir,
                    orchestrator.active!.taskId,
                    orchestrator.config,
                    pass,
                    orchestrator.transitionController.phaseSend,
                    scopedReviewers,
                    orchestrator.active?.state.repos ?? [],
                  )
                  : reviewPresetGroupForPhase(phase) === "planReviewers"
                  ? () => spawnPlanReviewers(
                    pi,
                    orchestrator.cwd,
                    orchestrator.active!.dir,
                    orchestrator.active!.taskId,
                    orchestrator.config,
                    pass,
                    orchestrator.transitionController.phaseSend,
                    scopedReviewers,
                    orchestrator.active?.state.repos ?? [],
                  )
                  : () => spawnCodeReviewers(
                    pi,
                    orchestrator.cwd,
                    orchestrator.active!.dir,
                    orchestrator.active!.taskId,
                    orchestrator.config,
                    pass,
                    phase,
                    orchestrator.transitionController.phaseSend,
                    scopedReviewers,
                    orchestrator.active?.state.repos ?? [],
                  );
                orchestrator.failedReviewerVariants = [];
                orchestrator.pendingSubagentSpawns = retryCount;
                cycle.step = "await_reviewers";
                orchestrator.active!.state.step = "await_reviewers";
                saveTask(orchestrator.active!.dir, orchestrator.active!.state);
                handleSpawnResult(orchestrator, spawnFn(), {
                  kind: "reviewer",
                  logScope: "review",
                  logMessage: "retry spawn reviewers failed",
                  logExtra: { phase },
                  onSettled: checkReviewCycleCompletion,
                });
                orchestrator.safeSendUserMessage(`[PI-PI] Retrying failed reviewers: ${variantsText}.`);
                return;
              }
            }
          }

          if (choice === "Stop task") {
            orchestrator.safeSendUserMessage(`[PI-PI] ${await stopTask(orchestrator)}`);
            return;
          }

          if (choice === "Continue without review") {
            if (!orchestrator.active?.state.reviewCycle) return;
            orchestrator.failedReviewerVariants = [];
            orchestrator.active.state.reviewCycle = null;
            orchestrator.active.state.step = "user_gate";
            saveTask(orchestrator.active.dir, orchestrator.active.state);
            orchestrator.safeSendUserMessage("[PI-PI] Review cycle skipped. Use /pp to choose the next action.");
            return;
          }

          orchestrator.failedReviewerVariants = [];
        } finally {
          orchestrator.reviewerFailureDialogPending = false;
          checkReviewCycleCompletion();
        }
      })();
      return;
    }

    if (orchestrator.active.state.reviewerFailureAutoRetried) {
      orchestrator.active.state.reviewerFailureAutoRetried = false;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    markAllAgentsConsumed();
    tryCompleteReviewCycle(orchestrator);
  }

  pi.events.on("subagents:completed", (data: any) => {
    const usageTracker = getUsageTracker();
    if (usageTracker && data?.tokens) {
      usageTracker.recordSubagentCompletion(data.tokens, undefined, {
        description: data.description || data.type || data.id || "unknown",
        agentType: data.type || "unknown",
        modelId: data.modelId || "unknown",
        durationMs: data.durationMs,
        toolUses: data.toolUses,
      });
      (orchestrator.lastCtx?.ui as any)?.requestRender?.();
    }

    if (!orchestrator.active || !data?.id) return;
    trackSubagentEvent(data, "completed");
    orchestrator.spawnedAgentIds.delete(data.id);
    orchestrator.agentDescriptions.delete(data.id);
    orchestrator.agentSpawnTimes.delete(data.id);
    orchestrator.agentLifecycle.delete(data.id);

    const desc = data.description || data.type || data.id;
    const duration = data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : "";
    const tokens = data.tokens?.total ? `${data.tokens.total} tok` : "";
    const stats = [duration, tokens].filter(Boolean).join(", ");

    orchestrator.transitionController.sendCustom(
      {
        customType: "pp-subagent-result",
        content: `${desc} completed${stats ? ` (${stats})` : ""}. Use get_subagent_result to read the output.`,
        display: false,
      },
      "context",
    );

    checkPlannerCompletion();
    checkReviewCycleCompletion();
  });

  pi.events.on("subagents:failed", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    trackSubagentEvent(data, "failed");
    orchestrator.spawnedAgentIds.delete(data.id);
    orchestrator.agentSpawnTimes.delete(data.id);
    const desc = orchestrator.agentDescriptions.get(data.id) || data.type || data.id;
    orchestrator.agentDescriptions.delete(data.id);
    orchestrator.agentLifecycle.delete(data.id);

    if (data.status === "stopped" || data.status === "aborted") {
      checkPlannerCompletion();
      checkReviewCycleCompletion();
      return;
    }

    const isApiError = data.status === "error" && (data.toolUses ?? 0) === 0;
    if (isApiError && orchestrator.spawnedAgentIds.size > 0) {
      orchestrator.abortAllSubagents();
    }

    // Subscription rate-limit (429) on a sub-routed subagent: offer the ONE
    // global switch-to-non-sub dialogue (never per-subagent). subagents:failed
    // carries the subagent's resolved model id.
    const failedModelId = typeof data.modelId === "string" ? data.modelId : undefined;
    const subRateLimited =
      isRateLimitError(data.error) &&
      isSubscriptionRouted(failedModelId) &&
      !orchestrator.subFallbackActive;
    if (subRateLimited) {
      // Set the decision-pending flag SYNCHRONOUSLY (before the completion checks
      // below) so the autonomous planner/reviewer auto-retry does NOT re-spawn
      // the failed variant on the still-sub-routed model while the fallback
      // dialogue is in flight.
      orchestrator.subFallbackPendingDecision = true;
      void handleSubagentRateLimit(orchestrator, orchestrator.lastCtx, failedModelId);
    }

    orchestrator.transitionController.sendCustom(
      {
        customType: "pp-subagent-error",
        content: isApiError
          ? `**${desc}** failed (model/API error): ${data.error || "unknown error"}. All subagents aborted. Do NOT retry — the model is likely unavailable. Report the error to the user and ask how to proceed.`
          : `**${desc}** failed: ${data.error || "unknown error"}. Do NOT retry — continue with available information.`,
        display: true,
      },
      "context",
    );

    checkPlannerCompletion();
    checkReviewCycleCompletion();
  });

  pi.on("session_before_switch" as any, async () => {
    finalizeTracer();
    if (!orchestrator.active) return;
    cancelPendingPlannotatorWait(orchestrator);
    orchestrator.abortAllSubagents();
    unregisterAgentDefinitions(pi);
    await orchestrator.cleanupActive();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) return;
    const tracker = getUsageTracker();
    if (!tracker) return;
    const sessionId = ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
    try {
      dumpUsageSummary(tracker, sessionId);
    } catch (err: any) {
      getLogger().error({ s: "usage", err: err.message }, "failed to dump usage summary");
    }
    flushLogs();
    finalizeTracer();
    delete (globalThis as any)[USAGE_TRACKER_KEY];
  });

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.cwd = ctx.cwd;
    (globalThis as any)[Symbol.for("pi-pi:orchestrator-cwd")] = ctx.cwd;

    const ppDir = join(ctx.cwd, ".pp");
    const { ensureGitignore } = await import("./orchestrator.js");
    ensureGitignore(ctx.cwd);

    let earlyLogLevel: "debug" | "info" | "warn" | "error" = "info";
    try {
      const { readRawConfig, GLOBAL_CONFIG_PATH } = await import("./config.js");
      const { isValidLogLevel: checkLevel } = await import("./log.js");
      const globalRaw = readRawConfig(GLOBAL_CONFIG_PATH);
      const projectRaw = readRawConfig(join(ppDir, "config.json"));
      const rawLevel = projectRaw?.general?.logLevel ?? globalRaw?.general?.logLevel;
      if (checkLevel(rawLevel)) earlyLogLevel = rawLevel;
    } catch {}

    initSessionLogger(ppDir, earlyLogLevel);
    const log = getLogger();
    log.info({ s: "session", cwd: ctx.cwd, logLevel: earlyLogLevel }, "session started");

    const available = (ctx as any).modelRegistry?.getAvailable?.();
    if (Array.isArray(available)) {
      const modelIds = available
        .map((m: any) => {
          const provider = typeof m?.provider === "string" ? m.provider.trim() : "";
          const id = typeof m?.id === "string" ? m.id.trim() : "";
          return provider && id ? `${provider}/${id}` : "";
        })
        .filter((id: string) => id.length > 0);
      updateRegistryFromAvailableModels(modelIds);
    }

    if (!(globalThis as any)[SUBAGENT_SESSION_KEY]) {
      const tracker = createUsageTracker();
      const sessionId = ctx.sessionManager?.getSessionId?.() || "";
      if (sessionId) {
        const previous = loadUsageSummary(sessionId);
        if (previous) tracker.loadFromSummary(previous);
      }
      (globalThis as any)[USAGE_TRACKER_KEY] = tracker;
      setFooterContext(ctx);
      setFooterTracker(tracker);
      setFooterOrchestrator(orchestrator);
      ctx.ui.setFooter(createCustomFooter);
    }

    const subagentsMgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    subagentsMgr?.refreshWidget?.(ctx.ui);
    const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
    taskStore?.refreshWidget?.(ctx.ui);

    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) {
      return;
    }

    const duplicates = orchestrator.checkForConflictingExtensions();
    if (duplicates.length > 0) {
      const msg = `pi-pi bundles its own versions of pi-subagents, pi-tasks, and pi-ask-user. ` +
        `Duplicate tools detected: ${duplicates.join(", ")}. ` +
        `Remove the conflicting packages: pi remove npm:@tintinweb/pi-subagents npm:@tintinweb/pi-tasks npm:pi-ask-user`;
      ctx.ui.notify(msg, "error");
      getLogger().error({ s: "init", duplicates }, "conflicting extensions detected");
      return;
    }

    try {
      const { setPI, initFlantOnStartup } = await import("./flant-infra.js");
      setPI(pi);
      await initFlantOnStartup(pi);
    } catch (err: any) {
      getLogger().error({ s: "flant", err: err.message }, "flant infra init failed");
    }

    try {
      orchestrator.config = loadConfig(orchestrator.cwd);
      orchestrator.configError = null;
    } catch (err: any) {
      getLogger().error({ s: "config", err: err.message }, "failed to load config on session start");
      // Surface the failure and keep a MINIMAL read-only /pp path alive instead of
      // silently killing the extension. The fallback config is for rendering only
      // (normalized defaults) — it does NOT reflect the user's invalid config, and
      // normal feature/tool/agent paths are intentionally NOT registered below.
      orchestrator.configError = err.message;
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      ctx.ui.notify(`Config error: ${err.message}`, "error");
      return;
    }

    setLogLevel(orchestrator.config.general.logLevel);
    log.info({ s: "config", logLevel: orchestrator.config.general.logLevel }, "config loaded");

    if (orchestrator.config.general.tracing) {
      const sessionId = ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
      initTracer(ppDir, sessionId);
      log.info({ s: "tracing", sessionId }, "session tracing enabled");
    } else {
      finalizeTracer();
    }

    registerFeatureToolsAndAgents(orchestrator);

    const status = getActiveTaskStatus(orchestrator.cwd, orchestrator.config.performance.internals.taskLockStale);
    if (status.kind === "single") {
      const found = status.task;
      ctx.ui.notify(
          `Paused task: "${taskName(found.dir)}" (${found.type}, phase: ${found.state.phase}). Run /pp and choose Resume to continue.`,
        "info",
      );
    } else if (status.kind === "ambiguous") {
      ctx.ui.notify(
        `${status.tasks.length} paused tasks found (their locks are free). Run /pp and choose Resume to pick one.`,
        "info",
      );
    }
  });

  pi.on("input", async (event, ctx) => {
    if (!orchestrator.active) return;
    if (event.source !== "interactive") return;

    const step = orchestrator.active.state.step;
    if (step === "await_planners" || step === "await_reviewers") {
      ctx.ui.notify("Waiting for subagents to finish. Your input will be available after they complete.", "warning");
      return { action: "handled" as const };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    orchestrator.lastCtx = ctx;
    // The controller owns the transition/await abort gate: it decides whether the
    // agent loop may start (not running during a pending/compacting/resuming
    // transition, subsuming the old compaction-pending checks, or while awaiting
    // subagents) AND issues the abort itself.
    if (orchestrator.transitionController.gateAgentStart(() => ctx.abort())) {
      return;
    }

    // Stale continuation-nudge guard. A `[PI-PI] Continue the <phase> phase…`
    // nudge is a followUp queued at turn_end; by the time it is delivered the
    // phase may have advanced (plan→implement) or the task may have changed
    // (old plan-task → new plan-task). Re-validate against the phase/token
    // captured at generation time and abort the turn on any mismatch — a stale
    // nudge is not genuine user re-engagement, so this runs BEFORE the no-active
    // early return and does NOT clear the nudge/error guards. Checked only for
    // the tracked "Continue the <phase> phase" shape; other [PI-PI] handoffs are
    // untouched.
    const nudgeMeta = orchestrator.pendingNudges.get(event.prompt ?? "");
    if (nudgeMeta !== undefined) {
      orchestrator.pendingNudges.delete(event.prompt ?? "");
      const livePhase = orchestrator.active?.state.phase;
      if (!orchestrator.active || nudgeMeta.phase !== livePhase || nudgeMeta.taskToken !== orchestrator.activeTaskToken) {
        getLogger().debug(
          { s: "hook", hook: "before_agent_start", nudgePhase: nudgeMeta.phase, livePhase, nudgeToken: nudgeMeta.taskToken, liveToken: orchestrator.activeTaskToken },
          "dropping stale continuation nudge",
        );
        ctx.abort();
        return;
      }
    }

    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;

    // Clear the nudge guard ONLY on a genuine user re-engagement. Controller-
    // injected prompts (nudges, "Begin working" handoffs, planner-error prompts)
    // are all "[PI-PI]"-prefixed and themselves restart the loop via followUp;
    // resetting on those would make consecutiveNudges oscillate 0->1->0 and the
    // halt could never fire. A nudge-induced restart must NOT clear the guard.
    const isControllerInjected = (event.prompt ?? "").startsWith("[PI-PI]");
    if (!isControllerInjected) {
      orchestrator.nudgeHalted = false;
      orchestrator.consecutiveNudges = 0;
      // Genuine user re-engagement also clears the API-error retry halt, so a
      // fresh request can auto-retry again from a clean counter.
      orchestrator.errorNudgeHalted = false;
      orchestrator.errorRetryCount = 0;
    }
    orchestrator.updateStatus(ctx);

    const phasePrompt = orchestrator.getPhasePrompt(ctx);
    const phase = orchestrator.active?.state.phase;
    const modelSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const modelInfo = getModelInfo(modelSpec);
    const repos = orchestrator.active?.state.repos ?? [];
    const contextDirs = getContextDirs(orchestrator.cwd, repos, orchestrator.config.general.loadExtraRepoConfigs);
    const systemContextFiles = loadAllContextFiles(contextDirs, "main", "system", phase, modelInfo);
    const systemSnippets = systemContextFiles.map((f) => f.content).join("\n\n");
    const effectiveMode: TaskMode = getEffectivePhaseMode(orchestrator.active.state);
    const now = new Date();
    const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const projectContext = systemSnippets
      ? ["<project_context>", systemSnippets, "</project_context>"].join("\n")
      : "";
    const agentsMdPath = join(orchestrator.cwd, "AGENTS.md");
    const agentsMd =
      orchestrator.config.general.injectAgentsMd && existsSync(agentsMdPath)
        ? [`<agents_md source="${agentsMdPath}">`, readFileSync(agentsMdPath, "utf-8"), "</agents_md>"].join("\n")
        : "";
    const checklistLine =
      phase === "implement" ? "Keep the plan checklist current: mark each item done (- [ ] → - [x]) as you complete it." : "";
    const taskBlock = [
      "<task>",
      phasePrompt,
      checklistLine,
      `Current month: ${monthYear}. Working directory: ${orchestrator.cwd}.`,
      "</task>",
    ]
      .filter(Boolean)
      .join("\n");

    const fullPrompt = [
      constraintsBlock(phase as Phase, effectiveMode),
      PRINCIPLES_BLOCK,
      TOOLS_BLOCK,
      DELEGATION_BLOCK,
      projectContext,
      agentsMd,
      taskBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      systemPrompt: fullPrompt,
    };
  });

  pi.on("tool_call", async (event, _ctx) => {
    markMainTurnActivity(orchestrator);
    getLogger().debug({ s: "hook", hook: "tool_call", tool: event.toolName }, "tool call");
    if (event.toolName === "ask_user" && orchestrator.active) {
      if (getEffectivePhaseMode(orchestrator.active.state) === "autonomous") {
        return { block: true, reason: "Autonomous mode — make your best judgment based on available context." };
      }
    }

    if (event.toolName === "Agent" && orchestrator.active) {
      const input = event.input as Record<string, unknown>;
      const requestedType = ((input.subagent_type as string) || "").toLowerCase();
      const validTypes = ["explore", "librarian", "task", "advisor", "deep-debugger", "reviewer"];
      if (!requestedType) {
        return { block: true, reason: "subagent_type is required. Valid types: explore (codebase research), librarian (external docs), task (implementation subtask), advisor (design/'why is this broken' judgment), deep-debugger (hard persistent failures), reviewer (code review — only when the user explicitly asks)." };
      }
      if (!validTypes.includes(requestedType)) {
        return { block: true, reason: `Unknown subagent_type "${requestedType}". Valid types: ${validTypes.join(", ")}.` };
      }

      const simple = orchestrator.config.agents.subagents.simple;
      const role = requestedType as keyof typeof simple;
      input.subagent_type = requestedType;
      input.model = resolveModel(simple[role].model);
      input.thinking = simple[role].thinking;

      // Spawn-time context injection: append USER_REQUEST + RESEARCH content and a
      // path-aware manifest of on-demand documents to the LLM-supplied spawn prompt.
      // explore/librarian intentionally get nothing (fast, scoped retrieval).
      if (["task", "advisor", "deep-debugger", "reviewer"].includes(requestedType)) {
        const contextBlock = buildSpawnContextBlock(orchestrator.active.dir);
        if (contextBlock) {
          const existingPrompt = typeof input.prompt === "string" ? input.prompt : "";
          input.prompt = existingPrompt ? `${existingPrompt}\n\n${contextBlock}` : contextBlock;
        }
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { file_path?: string; filePath?: string; path?: string };
      const rawPath = input.file_path || input.filePath || input.path || "";
      const resolvedPath = resolve(orchestrator.cwd, rawPath);
      const ppStateDir = resolve(orchestrator.cwd, ".pp", "state");
      const ppDir = resolve(orchestrator.cwd, ".pp");

      if (isPathInside(ppStateDir, resolvedPath)) {
        if (!resolvedPath.endsWith(".md")) {
          return { block: true, reason: "Cannot write non-.md files in .pp/state/" };
        }
      }

      const fileName = basename(resolvedPath);
      if (fileName === "state.json" && isPathInside(ppDir, resolvedPath)) {
        return { block: true, reason: "state.json is managed by the extension" };
      }

      if (fileName === "config.json" && isPathInside(ppDir, resolvedPath)) {
        return { block: true, reason: "config.json is managed by the user, not the LLM" };
      }

      // Review-phase read-only exception is scoped to AI_COMMENT markers: the main
      // agent may only insert/remove `AI_COMMENT:` markers in source files. Enforce
      // it at the gate (the constraint is otherwise prompt-level only): a source
      // write/edit is allowed only when it changes nothing but AI_COMMENT markers.
      // Publishing findings as file comments goes through this path.
      if (
        orchestrator.active?.state.phase === "review" &&
        !isPathInside(ppDir, resolvedPath)
      ) {
        const denial = {
          block: true as const,
          reason: "Review phase is read-only except for inserting/removing AI_COMMENT: markers. This edit changes non-AI_COMMENT content — record the finding instead of applying a fix.",
        };
        if (event.toolName === "edit") {
          const edits = Array.isArray((event.input as any)?.edits) ? (event.input as any).edits : [];
          const legacy = event.input as any;
          const allEdits = [
            ...edits,
            ...(typeof legacy?.oldText === "string" && typeof legacy?.newText === "string" ? [{ oldText: legacy.oldText, newText: legacy.newText }] : []),
          ];
          for (const e of allEdits) {
            if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") continue;
            if (!isAiCommentOnlyChange(e.oldText, e.newText)) return denial;
          }
        } else {
          // Anchoring inserts markers into EXISTING code; creating a new source
          // file is never a valid AI_COMMENT-only operation.
          if (!existsSync(resolvedPath)) return denial;
          const newContent = typeof (event.input as any)?.content === "string" ? (event.input as any).content : "";
          let before = "";
          try {
            before = readFileSync(resolvedPath, "utf-8");
          } catch {}
          if (!isAiCommentOnlyChange(before, newContent)) return denial;
        }
      }
    }
    return;
  });

  pi.on("tool_result", async (event, ctx) => {
    markMainTurnActivity(orchestrator);
    // ESC in an ask_user dialogue must stop the LLM's turn (treat ESC as
    // "stop, I want to type"). Only a deliberate user cancel aborts — timeout
    // and programmatic signal-aborts carry a non-"user" reason and must not.
    // The benign tool result has already been produced, so abort() yields a
    // clean stop rather than an error in the agent loop.
    if (event.toolName === "ask_user") {
      const cancelReason = (event.details as { cancelReason?: string } | undefined)?.cancelReason;
      if (cancelReason === "user") {
        getLogger().debug({ s: "hook", hook: "tool_result", tool: "ask_user" }, "user cancelled ask_user — aborting turn");
        // abort() may not emit a normal turn_end, so the main-turn flags can
        // stay set and the stall watchdog would "recover" 600s later. Clear them
        // here so a user cancel ends the turn cleanly and immediately.
        endMainTurn(orchestrator);
        orchestrator.interactivePromptOpen = false;
        ctx.abort?.();
      }
    }

    if (!orchestrator.active) return;

    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      const input = event.input as { file_path?: string; filePath?: string; path?: string };
      const filePath = input.file_path || input.filePath || input.path;
      if (!filePath) return;

      const resolvedWrite = resolve(orchestrator.cwd, filePath);
      const taskDir = orchestrator.active.dir;
      if (resolvedWrite === join(taskDir, "USER_REQUEST.md")) {
        const content = readFileSync(resolvedWrite, "utf-8");
        const result = validateUserRequest(content);
        if (!result.ok) {
          return {
            content: [
              ...event.content,
              { type: "text" as const, text: `\n\n<validation-error>\nUSER_REQUEST.md structure is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix immediately. Keep exactly: # User Request, ## Problem, ## Constraints. No other sections.\n</validation-error>` },
            ],
          };
        }
      }
      if (resolvedWrite === join(taskDir, "RESEARCH.md")) {
        const content = readFileSync(resolvedWrite, "utf-8");
        const result = validateResearch(content);
        if (!result.ok) {
          return {
            content: [
              ...event.content,
              { type: "text" as const, text: `\n\n<validation-error>\nRESEARCH.md structure is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix immediately. Keep exactly: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional). No other sections.\n</validation-error>` },
            ],
          };
        }
      }
      const artifactsDir = join(taskDir, "artifacts");
      if (isPathInside(artifactsDir, resolvedWrite) && resolvedWrite.endsWith(".md")) {
        const content = readFileSync(resolvedWrite, "utf-8");
        const result = validateArtifact(content);
        if (!result.ok) {
          return {
            content: [
              ...event.content,
              { type: "text" as const, text: `\n\n<validation-error>\nArtifact structure is invalid:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix immediately. Artifact files must start with # <Title>.\n</validation-error>` },
            ],
          };
        }
      }

      const ppDir = resolve(orchestrator.cwd, ".pp");
      if (isPathInside(ppDir, resolvedWrite)) return;

      if (orchestrator.active.state.phase !== "implement") return;

      orchestrator.active.modifiedFiles.add(resolvedWrite);
      orchestrator.active.state.modifiedFiles = [...orchestrator.active.modifiedFiles];
      orchestrator.active.state.reviewApprovedClean = false;
      // New implement edits invalidate a prior afterImplement run (e.g. fixes made
      // via the guided menu after the autonomous terminal handoff), so the hooks
      // re-run and validate the final code on the next completion.
      orchestrator.active.state.afterImplementRan = false;
      try { saveTask(orchestrator.active.dir, orchestrator.active.state); } catch {}

      const repos = orchestrator.active.state.repos ?? [];
      const repo = resolveRepoForFile(repos, resolvedWrite);
      getLogger().debug({ s: "afterEdit", file: resolvedWrite, repo: repo?.path ?? null, isRoot: repo?.isRoot ?? null }, "resolving afterEdit commands");
      const afterEditResults: Array<{ ok: boolean; command: string; output: string }> = [];
      if (repo) {
        if (repo.isRoot) {
          const fileInRepo = relative(orchestrator.cwd, resolvedWrite);
          afterEditResults.push(
            ...runAfterEdit(
              fileInRepo,
              orchestrator.config.commands.afterEdit,
              orchestrator.config.performance.commands.afterEdit,
              orchestrator.cwd,
            ),
          );
        } else if (orchestrator.config.general.loadExtraRepoConfigs) {
          const repoCommands = loadRepoAfterEditCommands(repo.path);
          if (repoCommands && Object.keys(repoCommands).length > 0) {
            const fileInRepo = relative(repo.path, resolvedWrite);
            afterEditResults.push(...runAfterEdit(fileInRepo, repoCommands, orchestrator.config.performance.commands.afterEdit, repo.path));
          }
        }
      }
      const failures = afterEditResults.filter((r) => !r.ok);

      if (failures.length > 0) {
        const failureText = failures
          .map((f) => `afterEdit command failed: ${f.command}\n${f.output}`)
          .join("\n\n");
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n\n<afterEdit>\n${failureText}\n</afterEdit>` },
          ],
        };
      }

      const lspAvailable = pi.getAllTools().some((t) => t.name === "lsp");
      if (lspAvailable) {
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n\nRun lsp diagnostics on ${filePath} to check for errors.` },
          ],
        };
      }
    }
    return;
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    const transitioning = orchestrator.transitionController.isTransitioning();
    getLogger().debug({ s: "hook", hook: "session_before_compact", transitioning, state: orchestrator.transitionController.getState() }, "before compact");
    // Controller-initiated compaction (phase transition or task done/stop/new-task):
    // supply the transition summary. The controller is the single source of truth,
    // so this works whether or not `active` is still set (done cleanup nulls it).
    if (transitioning) {
      const summary = orchestrator.transitionController.currentSummary() || "Phase transition in progress.";
      // Task-boundary discard: keep NO verbatim transcript beyond the summary so
      // the finished/replaced task cannot leak into the next task. Point
      // firstKeptEntryId at the newest branch entry (nothing before it is kept
      // verbatim). Phase transitions keep the default recent window so
      // legitimate context carries forward.
      const branchEntries = (event as any).branchEntries as Array<{ id: string }> | undefined;
      const lastEntryId = branchEntries && branchEntries.length > 0 ? branchEntries[branchEntries.length - 1].id : undefined;
      const firstKeptEntryId =
        orchestrator.transitionController.isDiscardTransition() && lastEntryId
          ? lastEntryId
          : event.preparation.firstKeptEntryId;
      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    }

    // Natural (user-triggered) compaction: re-inject phase artifacts so context
    // survives.
    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;

    const artifacts = getPhaseArtifacts(orchestrator.active.dir, orchestrator.active.state.phase);
    if (artifacts.length === 0) return;

    const artifactText = artifacts
      .map((a) => `=== ${a.name} ===\n${a.content}`)
      .join("\n\n");

    orchestrator.transitionController.sendCustom(
      {
        customType: "pp-artifact-reinject",
        content: `[PI-PI ARTIFACTS — re-injected after compaction]\n\n${artifactText}`,
        display: false,
      },
      "context",
    );

    return;
  });

  pi.on("turn_end", async (event, ctx) => {
    // The turn produced a terminal event — it is no longer wedged. If the SDK
    // auto-retries a retryable error it will emit a fresh turn_start, which
    // re-arms the watchdog.
    endMainTurn(orchestrator);
    const msg = event.message as any;
    const usageTracker = getUsageTracker();
    if (usageTracker && msg?.usage) {
      const input = typeof msg.usage.input === "number" ? msg.usage.input : 0;
      const output = typeof msg.usage.output === "number" ? msg.usage.output : 0;
      const cacheSupported = typeof msg.usage.cacheRead === "number" || typeof msg.usage.cacheWrite === "number";
      const cacheRead = typeof msg.usage.cacheRead === "number" ? msg.usage.cacheRead : 0;
      const cacheWrite = typeof msg.usage.cacheWrite === "number" ? msg.usage.cacheWrite : 0;
      const cost = typeof msg.usage.cost?.total === "number" ? msg.usage.cost.total : 0;
      const modelId = (typeof msg.model === "string" && msg.model) || ctx.model?.id || "unknown-model";
      const provider = (typeof msg.provider === "string" && msg.provider) || ctx.model?.provider || "unknown";
      usageTracker.recordTurn(modelId, provider, input, output, cacheRead, cacheWrite, cost, cacheSupported);
      (ctx.ui as any)?.requestRender?.();
    }

    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;
    // A transition is in flight (controller owns the loop) — skip orthogonal
    // turn_end work (commit reminder / nudges) until it resumes.
    if (orchestrator.transitionController.isTransitioning()) return;
    orchestrator.updateStatus(ctx);

    if (
      orchestrator.active.state.phase === "implement" &&
      orchestrator.config.general.autoCommit &&
      orchestrator.active.modifiedFiles.size > 0 &&
      !orchestrator.commitReminderSent
    ) {
      orchestrator.commitReminderSent = true;
      orchestrator.transitionController.sendCustom(
        {
          customType: "pp-commit-reminder",
          content: `You have ${orchestrator.active.modifiedFiles.size} uncommitted file(s). If you've completed a logical unit of work, call pp_commit with a descriptive message. Prefix it with a conventional-commit type (fix:, feat:, or chore:) unless the user asked for a different commit style.`,
          display: false,
        },
        "context",
      );
    }

    const phase = orchestrator.active.state.phase;

    if (msg?.stopReason === "aborted") return;
    if (msg?.stopReason === "error") {
      const errorMsg = msg.errorMessage || "unknown error";
      const contentSummary = (msg.content || []).map((c: any) => {
        if (c.type === "toolCall") return `toolCall:${c.name}`;
        if (c.type === "text" && c.text) return `text:${c.text.slice(0, 100)}`;
        if (c.type === "thinking") return `thinking:${c.thinking?.slice(0, 100) || "(redacted)"}`;
        return c.type;
      });
      getLogger().error({
        s: "turn",
        err: errorMsg,
        model: msg.model,
        provider: msg.provider,
        api: msg.api,
        input: msg.usage?.input,
        output: msg.usage?.output,
        cacheRead: msg.usage?.cacheRead,
        contentBlocks: msg.content?.length ?? 0,
        contentSummary,
      }, "turn ended with error");
      // Subscription rate-limit (429) on a sub-routed main turn: retrying the
      // same sub model is futile against an account-level limit. Offer a
      // user-gated switch to non-sub Claude instead of the generic backoff.
      const activeModelId = (typeof msg.model === "string" && msg.model) || ctx.model?.id;
      const activeProvider = (typeof msg.provider === "string" && msg.provider) || ctx.model?.provider;
      if (
        isRateLimitError(errorMsg) &&
        isSubscriptionRouted(activeModelId, activeProvider) &&
        !orchestrator.subFallbackActive
      ) {
        void handleMainRateLimit(orchestrator, ctx, activeModelId, activeProvider);
        return;
      }
      // The SDK ALSO auto-retries this class of error, but only with its own
      // short budget (getRetrySettings default: maxRetries=3, baseDelayMs=2000 →
      // ~14s of backoff) that runs INSIDE the prompt call. By the time this
      // turn_end fires, the SDK's while-loop (_runAgentPrompt) has already
      // exhausted that budget — the turn is terminally errored, no SDK retry is
      // in flight. Previously we bailed here (`return`) and deferred entirely to
      // the SDK; that shadowed pi-pi's OWN longer idle-gated retry (5×, up to
      // 32s) for exactly the errors most worth retrying (5xx/503/stream-ended),
      // so a transient gateway 503 killed the whole autonomous session in ~1min.
      //
      // We now let pi-pi's retry take over for SDK-retryable errors too. The
      // original "Agent is already processing" race the old comment worried about
      // cannot occur: sendUserMessageWhenIdle PRE-CHECKS isIdle() and defers on a
      // bounded poll, so the followUp is never delivered while a run is active.
      if (isSdkRetryableError(errorMsg)) {
        getLogger().debug({ s: "turn", err: errorMsg }, "SDK retry budget exhausted; pi-pi idle-gated retry taking over");
      }
      // Halt guard: once the consecutive-error cap is exceeded we stop auto-
      // retrying until the user re-engages. errorRetryCount is NO LONGER reset on
      // benign intervening turns (see below) — otherwise a retried turn that ends
      // as a harmless text-only reply would reset the counter and the cap could
      // never accumulate, letting transient errors nudge unbounded.
      if (orchestrator.errorNudgeHalted) {
        getLogger().debug({ s: "turn", err: errorMsg }, "error auto-retry halted; awaiting user re-engagement");
        return;
      }
      orchestrator.errorRetryCount = (orchestrator.errorRetryCount ?? 0) + 1;
      // 8 attempts with exponential backoff clamped at 60s: 2,4,8,16,32,60,60,60
      // ≈ 242s (~4min) total window. A gateway 503 can persist for minutes, and
      // an autonomous run has no human to "send any message to resume", so the
      // window is sized to outlast a transient upstream outage rather than the
      // SDK's ~14s in-prompt budget. The 60s clamp keeps late attempts from
      // ballooning to 256s+ while still spacing out probes.
      const maxRetries = 8;
      const maxDelayMs = 60_000;
      if (orchestrator.errorRetryCount <= maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, orchestrator.errorRetryCount - 1), maxDelayMs);
        // The first transient error is expected noise (the SDK just exhausted its
        // own budget); surface it quietly as info and escalate to a warning only
        // once it recurs, so a single flaky response doesn't alarm the user.
        const severity = orchestrator.errorRetryCount === 1 ? "info" : "warning";
        ctx.ui.notify(`API error (pi-pi retry ${orchestrator.errorRetryCount}/${maxRetries}): ${errorMsg}. Retrying in ${delay / 1000}s...`, severity);
        const taskToken = orchestrator.activeTaskToken;
        if (orchestrator.pendingRetryTimer) clearTimeout(orchestrator.pendingRetryTimer);
        // Arm a direct ESC interrupt for this retry window — no SDK/interactive
        // binding covers pi-pi's own timer (the turn already ended in error).
        orchestrator.armRetryEscInterrupt(ctx);
        orchestrator.pendingRetryTimer = setTimeout(() => {
          orchestrator.pendingRetryTimer = null;
          if (orchestrator.activeTaskToken !== taskToken || !orchestrator.active) {
            orchestrator.disarmRetryEscInterrupt();
            return;
          }
          // Defer until the main session is idle: sending a followUp while the SDK
          // still has an active run throws an async, runtime-swallowed "Agent is
          // already processing" error. sendUserMessageWhenIdle polls (reusing
          // pendingRetryTimer so ESC/abort still cancels) and disarms the ESC hook
          // once delivered.
          orchestrator.sendUserMessageWhenIdle(
            `[PI-PI] Transient API error; retrying the current phase (${phase}) from the last completed step.`,
            taskToken,
          );
        }, delay);
      } else {
        ctx.ui.notify(`API error persisted after ${maxRetries} retries: ${errorMsg}. Stopping auto-retry — send any message to resume.`, "error");
        // Halt (do NOT reset the counter) so no further error turn re-arms a retry
        // until the user re-engages. cancelPendingRetry would reset the count and
        // re-open the floodgate, so only clear the live timer/ESC hook here.
        orchestrator.errorNudgeHalted = true;
        if (orchestrator.pendingRetryTimer) {
          clearTimeout(orchestrator.pendingRetryTimer);
          orchestrator.pendingRetryTimer = null;
        }
        orchestrator.disarmRetryEscInterrupt();
      }
      return;
    }
    // NOTE: errorRetryCount is intentionally NOT reset here. Resetting on every
    // non-error turn let a benign nudge-induced turn zero the counter, defeating
    // the maxRetries cap and allowing unbounded error nudges. The counter is
    // reset only on genuine user re-engagement (before_agent_start) and on task
    // reset / cancelPendingRetry.

    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) {
      return;
    }

    // While awaiting subagents, completion is driven entirely by the event-driven
    // owners (checkPlannerCompletion / checkReviewCycleCompletion / tryCompleteReviewCycle,
    // wired to subagents:completed/failed and the blocking spawn promise's onSettled).
    // The old 5s setInterval poller was a redundant fallback and has been removed;
    // turn_end simply returns here (no nudge, no poll) while in an await_* step.
    if (orchestrator.active.state.step === "await_planners" || orchestrator.active.state.step === "await_reviewers") {
      return;
    }

    const contentParts = Array.isArray(msg?.content) ? msg.content : [];
    const hasText = contentParts.some((c: any) => c.type === "text" && c.text?.trim());
    const hasToolCalls = contentParts.some((c: any) => c.type === "toolCall");
    const hasToolResults = event.toolResults && event.toolResults.length > 0;
    const turnWasEmpty = !hasText && !hasToolCalls && !hasToolResults;

    const isAutonomous = getEffectivePhaseMode(orchestrator.active.state) === "autonomous";

    // Nudges fire ONLY for plan/implement. brainstorm/debug/review (and quick) are
    // interactive by nature — stopping there is normal, not a stall. They are also
    // suppressed whenever the controller is not running (a transition handoff or
    // await is in progress — that pause is plumbing, not a genuine model stop).
    const nudgesEnabled = (phase === "plan" || phase === "implement") && orchestrator.transitionController.isRunning();

    // A genuine model stop is a turn that produced no forward progress: either a
    // text-only reply (no tool call, or one that trails into text) or a fully
    // empty turn. A turn that ended on a tool call IS progress and resets the guard.
    const lastPart = contentParts.length > 0 ? contentParts[contentParts.length - 1] : null;
    const endsWithText = lastPart?.type === "text" && !!lastPart?.text?.trim();
    const isGenuineStop = turnWasEmpty || (hasText && (!hasToolCalls || endsWithText));

    if (!isGenuineStop) {
      // Forward progress — clear the consecutive-nudge guard.
      orchestrator.consecutiveNudges = 0;
      return;
    }

    if (!nudgesEnabled || orchestrator.nudgeHalted) return;

    // Single consecutive-nudge guard: nudge up to MAX_CONSECUTIVE_NUDGES times in
    // a row, then halt with one notification until the user re-engages (a fresh
    // before_agent_start resets the counter).
    const MAX_CONSECUTIVE_NUDGES = 6;
    if (orchestrator.consecutiveNudges >= MAX_CONSECUTIVE_NUDGES) {
      orchestrator.nudgeHalted = true;
      orchestrator.transitionController.sendCustom(
        {
          customType: "pp-continuation-halted",
          content: "Agent has been repeatedly interrupted without making progress. Auto-continuation paused. Send any message to resume.",
          display: true,
        },
        "context",
      );
      return;
    }

    orchestrator.consecutiveNudges++;
    const nudge = isAutonomous
      ? `[PI-PI] Continue the ${phase} phase. ${phaseConstraint(phase as Phase)} If the phase's objectives are met, call pp_phase_complete now; otherwise call the next tool. Do NOT apologize or reply with text only — respond with a tool call.`
      : `[PI-PI] Continue the ${phase} phase where you left off.`;
    // Record the nudge's phase/task at generation time so a delivery that lands
    // after the phase advanced or the task changed can be dropped (the queued
    // followUp string itself carries no token).
    orchestrator.pendingNudges.set(nudge, { phase: phase as Phase, taskToken: orchestrator.activeTaskToken });
    orchestrator.safeSendUserMessage(nudge);
  });


}
