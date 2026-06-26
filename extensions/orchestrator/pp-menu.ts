import { existsSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { isDeepStrictEqual } from "util";
import { askUser } from "../../3p/pi-ask-user/index.js";
import { unregisterAgentDefinitions } from "./agents/registry.js";
import {
  type AfterEditCommand,
  type AfterImplementCommand,
  GLOBAL_CONFIG_PATH,
  getDefaultConfig,
  loadConfig,
  mergeConfigLayers,
  readRawConfig,
  removeConfigValue,
  resolvePreset,
  writeConfigValue,
  type PiPiConfig,
  type PresetGroup,
  type VariantConfig,
} from "./config.js";
import {
  loadBrainstormReviewOutputs,
  loadCodeReviewOutputs,
  loadPlanReviewOutputs,
} from "./context.js";
import { detectDefaultBranch, enterReviewCycle, finalizeReviewCycle } from "./event-handlers.js";
import { Orchestrator } from "./orchestrator.js";
import { cancelPendingPlannotatorWait } from "./plannotator.js";
import { spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { spawnBrainstormReviewers } from "./phases/brainstorm.js";
import { nextPhase } from "./phases/machine.js";
import { getAllAliases, getModelFamilies, getModelInfo, resolveModel, updateRegistryFromAvailableModels } from "./model-registry.js";

import {
  listTasks,
  getEffectiveMode,
  loadTask,
  lockTask,
  saveTask,
  taskAge,
  taskName,
  type AutonomousConfig,
  type TaskMode,
  type TaskInfo,
  type TaskType,
} from "./state.js";
import {
  clearFlantGeneratedConfig,
  getFlantGeneratedConfig,
  loadFlantSettings,
  saveFlantSettings,
  unregisterFlantProviders,
  updateFlantInfra,
  type FlantSettings,
} from "./flant-infra.js";
import { normalizeRepoPath, type RepoInfo } from "./repo-utils.js";
import { getLogger, addTaskDestination, setLogLevel } from "./log.js";

type MenuMode = "command" | "tool";

const BACK = "back" as const;

type OptionInput = string | { title: string; description?: string };

async function selectOption(ctx: any, question: string, options: OptionInput[]): Promise<string | undefined> {
  const result = await askUser(ctx, {
    question,
    options,
    allowFreeform: false,
    allowComment: false,
    allowMultiple: false,
  });
  if (!result || result.kind !== "selection") return undefined;
  return result.selections[0];
}

function opt(title: string, description: string): OptionInput {
  return { title, description };
}

function getRegisteredRepos(orchestrator: Orchestrator): RepoInfo[] {
  const repos = orchestrator.active?.state.repos ?? [];
  if (repos.length > 0) return repos;
  return [{ path: normalizeRepoPath(orchestrator.cwd), isRoot: true }];
}

function validateRepos(repos: RepoInfo[]): RepoInfo[] {
  return repos.filter((repo) => {
    try {
      if (!existsSync(repo.path)) return false;
      return existsSync(join(repo.path, ".git"));
    } catch {
      return false;
    }
  });
}

function formatRepoLabel(repo: RepoInfo): string {
  return `${repo.path}${repo.isRoot ? " (root)" : ""}`;
}

function formatRepoList(repos: RepoInfo[]): string {
  return repos
    .map((repo) => {
      const base = repo.baseBranch ? `, base: ${repo.baseBranch}` : "";
      return `- ${formatRepoLabel(repo)}${base}`;
    })
    .join("\n");
}

function appendSection(content: string, heading: string, body: string): string {
  const normalized = content.trimEnd();
  if (normalized.includes(`${heading}\n`)) return normalized + "\n";
  return `${normalized}\n\n${heading}\n${body}\n`;
}

function appendToSection(content: string, heading: string, body: string): string {
  const normalized = content.trimEnd();
  if (normalized.includes(body)) return normalized + "\n";

  const lines = normalized.split("\n");
  const sectionIndex = lines.findIndex((line) => line.trim() === heading);
  if (sectionIndex === -1) {
    return appendSection(normalized, heading, body);
  }

  let insertIndex = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      insertIndex = i;
      break;
    }
  }

  const insertLines = body.split("\n");
  if (insertIndex > sectionIndex + 1 && lines[insertIndex - 1]?.trim() !== "") {
    insertLines.unshift("");
  }
  lines.splice(insertIndex, 0, ...insertLines);
  return lines.join("\n") + "\n";
}

function appendRepoContext(content: string, repos: RepoInfo[]): string {
  if (repos.length === 0) return content;
  const lines = repos.map((repo) => `- ${formatRepoLabel(repo)}${repo.baseBranch ? ` (base: ${repo.baseBranch})` : ""}`);
  return appendToSection(content, "## Constraints", `Registered repositories:\n${lines.join("\n")}`);
}

function appendResearchOpenQuestions(content: string, text: string): string {
  const normalized = content.trimEnd();
  if (normalized.includes("## Open Questions\n")) {
    return `${normalized}\n${text}\n`;
  }
  return `${normalized}\n\n## Open Questions\n${text}\n`;
}

async function pickCommitForRepo(orchestrator: Orchestrator, ctx: any, repo: RepoInfo): Promise<string | null> {
  let commits: Array<{ hash: string; message: string; age: string }> = [];
  try {
    const logResult = await orchestrator.pi.exec(
      "git", ["log", "--oneline", "--format=%h\t%s\t%cr", "-30"],
      { cwd: repo.path, timeout: 5000 },
    );
    if (logResult.code === 0 && logResult.stdout.trim()) {
      commits = logResult.stdout.trim().split("\n").map((line) => {
        const [hash, message, age] = line.split("\t");
        return { hash: hash || "", message: message || "", age: age || "" };
      }).filter((c) => c.hash);
    }
  } catch {}
  if (commits.length === 0) {
    ctx.ui.notify(`No commits found in ${repo.path}.`, "info");
    return null;
  }
  const commitOptions: OptionInput[] = commits.map((c) => ({
    title: `${c.hash} ${c.message}`,
    description: c.age,
  }));
  commitOptions.push({ title: "Back", description: "Return to the previous menu" });
  const picked = await selectOption(ctx, `Review changes since (${repo.path}):`, commitOptions);
  if (!picked || picked === "Back") return null;
  const pickedHash = picked.split(" ")[0];
  return pickedHash || null;
}

interface RepoPrContext {
  repoPath: string;
  prUrl: string | null;
  prContext: string | null;
}

function setStep(orchestrator: Orchestrator, step: string): void {
  if (!orchestrator.active) return;
  orchestrator.active.state.step = step;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
}

function showStatus(orchestrator: Orchestrator, ctx: any): void {
  if (!orchestrator.active) {
    ctx.ui.notify("No active task.", "info");
    return;
  }
  const cycle = orchestrator.active.state.reviewCycle
    ? ` | ReviewCycle: ${orchestrator.active.state.reviewCycle.kind}/${orchestrator.active.state.reviewCycle.step} (pass ${orchestrator.active.state.reviewCycle.pass})`
    : "";
  ctx.ui.notify(
    `Type: ${orchestrator.active.type} | Phase: ${orchestrator.active.state.phase} | Step: ${orchestrator.active.state.step} | ReviewPass: ${orchestrator.active.state.reviewPass}${cycle} | Task: ${orchestrator.active.description} | Age: ${taskAge(orchestrator.active.state)} | Dir: ${orchestrator.active.dir}`,
    "info",
  );
}

async function abortCurrentWork(orchestrator: Orchestrator, ctx: any): Promise<void> {
  orchestrator.abortAllSubagents();
  ctx.abort?.();
  await ctx.waitForIdle?.();
  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);
}

async function pauseTask(orchestrator: Orchestrator, ctx: any): Promise<string> {
  if (!orchestrator.active) return "No active task.";

  cancelPendingPlannotatorWait(orchestrator);
  orchestrator.abortAllSubagents();
  ctx.abort?.();
  await ctx.waitForIdle?.();

  const name = orchestrator.active.description;
  const type = orchestrator.active.type;

  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.taskDoneCompactionPending = true;
  orchestrator.taskDoneCompactionSummary = `Task "${name}" (${type}) paused.`;

  orchestrator.updateStatus(ctx);
  await new Promise<void>((resolve) => {
    const compact = ctx.compact;
    if (!compact) { orchestrator.taskDoneCompactionPending = false; orchestrator.taskDoneCompactionSummary = ""; resolve(); return; }
    compact({
      onComplete: () => { orchestrator.taskDoneCompactionPending = false; resolve(); },
      onError: () => { orchestrator.taskDoneCompactionPending = false; orchestrator.taskDoneCompactionSummary = ""; resolve(); },
    });
  });
  ctx.ui.notify(`Task "${name}" paused. Use /pp → Resume to continue.`, "info");
  return `Task "${name}" paused.`;
}

async function finishTask(orchestrator: Orchestrator, ctx: any): Promise<string> {
  if (!orchestrator.active) return "No active task.";

  cancelPendingPlannotatorWait(orchestrator);
  orchestrator.abortAllSubagents();
  ctx.abort?.();
  await ctx.waitForIdle?.();

  const name = orchestrator.active.description;
  const type = orchestrator.active.type;
  const dir = orchestrator.active.dir;

  orchestrator.taskDoneCompactionPending = true;
  orchestrator.taskDoneCompactionSummary = `Task "${name}" (${type}) completed.`;

  orchestrator.active.state.phase = "done";
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.updateStatus(ctx);
  ctx.compact?.();

  const urExists = existsSync(join(dir, "USER_REQUEST.md"));
  const resExists = existsSync(join(dir, "RESEARCH.md"));

  if ((type === "brainstorm" || type === "debug") && urExists && resExists) {
    const taskRelPath = relative(join(orchestrator.cwd, ".pp", "state"), dir);
    ctx.ui.notify(
      `Task "${name}" completed. Artifacts saved.\nUse /pp → Implement → From and choose ${taskRelPath}`,
      "info",
    );
  } else {
    ctx.ui.notify(`Task "${name}" completed.`, "info");
  }

  return `Task "${name}" completed.`;
}

function loadPhaseReviewOutputs(taskDir: string, phase: string, pass: number): { name: string; content: string }[] {
  if (phase === "brainstorm") return loadBrainstormReviewOutputs(taskDir, pass);
  if (phase === "plan") return loadPlanReviewOutputs(taskDir, pass);
  return loadCodeReviewOutputs(taskDir, pass);
}

function getDefaultReviewPresetName(config: PiPiConfig, phase: string): string {
  if (phase === "brainstorm") return config.defaultPresets.brainstormReviewers;
  if (phase === "plan") return config.defaultPresets.planReviewers;
  return config.defaultPresets.codeReviewers;
}

function getReviewPresetGroup(phase: string): PresetGroup {
  if (phase === "brainstorm") return "brainstormReviewers";
  if (phase === "plan") return "planReviewers";
  return "codeReviewers";
}

export async function pickPreset(
  ctx: any,
  orchestrator: Orchestrator,
  group: PresetGroup,
  title: string,
): Promise<string | null> {
  const presets = orchestrator.config.presets[group] ?? {};
  const defaultPresetName = orchestrator.config.defaultPresets[group];

  const options: OptionInput[] = [];
  const byTitle = new Map<string, string>();

  for (const [presetName, variants] of Object.entries(presets)) {
    const enabledModels = Object.values(variants)
      .filter((variant) => variant.enabled)
      .map((variant) => {
        const info = getModelInfo(variant.model);
        return `${info.vendor}/${info.family} (${variant.thinking})`;
      });
    const description = enabledModels.length > 0 ? enabledModels.join(", ") : "No enabled models";
    const optionTitle = presetName === defaultPresetName ? `${presetName} [default]` : presetName;
    byTitle.set(optionTitle, presetName);
    options.push({ title: optionTitle, description });
  }

  options.push({ title: "Back", description: "Return to the previous menu" });

  const choice = await selectOption(ctx, title, options);
  if (!choice || choice === "Back") return null;
  return byTitle.get(choice) ?? null;
}

export async function resumeTask(
  orchestrator: Orchestrator,
  ctx: any,
  task: TaskInfo,
): Promise<{ ok: boolean; error?: string }> {
  const pi = orchestrator.pi;

  try {
    orchestrator.config = loadConfig(orchestrator.cwd);
  } catch (err: any) {
    const message = `Config error: ${err.message}`;
    ctx.ui.notify(message, "error");
    return { ok: false, error: message };
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockTask(task.dir, orchestrator.config.timeouts);
  } catch {
    const staleSeconds = Math.round(orchestrator.config.timeouts.lockStale / 1000);
    const message =
      `Cannot resume: task is locked by another pi session (or a session that crashed less than ${staleSeconds}s ago). ` +
      `Wait ${staleSeconds}s for the lock to expire, or kill the other session first.`;
    ctx.ui.notify(message, "error");
    return { ok: false, error: message };
  }

  orchestrator.resetTaskScopedState();
  orchestrator.activeTaskToken++;

  const normalizedRoot = normalizeRepoPath(orchestrator.cwd);
  if (!task.state.repos || task.state.repos.length === 0) {
    task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    saveTask(task.dir, task.state);
  }

  if (!task.state.repos.some((repo) => repo.isRoot)) {
    const rootByPath = task.state.repos.find((repo) => repo.path === normalizedRoot);
    if (rootByPath) {
      rootByPath.isRoot = true;
    } else if (task.state.repos.length > 0) {
      task.state.repos[0]!.isRoot = true;
    } else {
      task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    }
    saveTask(task.dir, task.state);
  }

  const validRepos = validateRepos(task.state.repos ?? []);
  if ((task.state.repos?.length ?? 0) !== validRepos.length) {
    const pruned = (task.state.repos?.length ?? 0) - validRepos.length;
    task.state.repos = validRepos;
    saveTask(task.dir, task.state);
    ctx.ui.notify(`Pruned ${pruned} stale repo(s) that no longer exist.`, "warning");
  }

  if (!task.state.repos || task.state.repos.length === 0) {
    task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    saveTask(task.dir, task.state);
  }

  const needsRepoRegistrationPrompt = task.state.repos.some((repo) => !repo.baseBranch);

  orchestrator.active = {
    dir: task.dir,
    type: task.type,
    state: task.state,
    release,
    taskId: orchestrator.taskIdFromDir(task.dir),
    modifiedFiles: new Set(task.state.modifiedFiles ?? []),
    reviewPass: task.state.reviewPass,
    description: task.state.description,
  };

  addTaskDestination(task.dir);
  setLogLevel(orchestrator.config.logLevel);
  getLogger().info({ s: "task", dir: task.dir, type: task.type, phase: task.state.phase }, "task resumed");

  const modelConfig = orchestrator.config.mainModel[
    task.type === "debug" ? "debug"
    : task.type === "brainstorm" ? "brainstorm"
    : task.type === "review" ? "review"
    : "implement"
  ];
  const modelOk = await orchestrator.switchModel(ctx, modelConfig.model, modelConfig.thinking);
  if (!modelOk) {
    ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
  }

  orchestrator.registerAgents();
  pi.setSessionName(orchestrator.active.description.slice(0, 50));
  orchestrator.lastCtx = ctx;
  orchestrator.updateStatus(ctx);

  orchestrator.injectContextAndArtifacts(orchestrator.active.dir, orchestrator.active.state.phase);

  if (orchestrator.active.state.phase === "plan" && orchestrator.active.state.step === "await_planners") {
    const plansDir = join(orchestrator.active.dir, "plans");
    const requestedPlannerPresetName = orchestrator.active.state.activePlannerPreset ?? orchestrator.config.defaultPresets.planners;
    const plannerPresetExists = Object.prototype.hasOwnProperty.call(orchestrator.config.presets.planners ?? {}, requestedPlannerPresetName);
    const plannerPresetName = plannerPresetExists
      ? requestedPlannerPresetName
      : (Object.keys(orchestrator.config.presets.planners ?? {})[0] ?? requestedPlannerPresetName);
    if (orchestrator.active.state.activePlannerPreset !== plannerPresetName) {
      orchestrator.active.state.activePlannerPreset = plannerPresetName;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    if (!plannerPresetExists && plannerPresetName !== requestedPlannerPresetName) {
      ctx.ui.notify(
        `Planner preset "${requestedPlannerPresetName}" not found. Falling back to "${plannerPresetName}".`,
        "warning",
      );
    }
    const plannerVariants = resolvePreset(orchestrator.config, "planners", plannerPresetName);
    const enabledVariants = Object.entries(plannerVariants).filter(([, v]) => v.enabled);
    const planFiles = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
      : [];
    const completedVariants = new Set(planFiles.map((f) => f.replace(/^\d+_/, "").replace(/\.md$/, "")));
    const hasAllEnabledVariants = enabledVariants.every(([name]) => completedVariants.has(name));
    if (hasAllEnabledVariants) {
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    } else {
      const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));
      if (missingVariants.length > 0) {
        const missingConfig: typeof plannerVariants = {};
        for (const [name, cfg] of missingVariants) missingConfig[name] = cfg;
        orchestrator.pendingSubagentSpawns = missingVariants.length;
        orchestrator.failedPlannerVariants = [];
        spawnPlanners(
          pi,
          orchestrator.cwd,
          orchestrator.active.dir,
          orchestrator.active.taskId,
          orchestrator.config,
          missingConfig,
          orchestrator.active?.state.repos ?? [],
        ).then((result) => {
          orchestrator.failedPlannerVariants = result.failedVariants;
          if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
          for (const id of result.agentIds ?? []) {
            orchestrator.spawnedAgentIds.delete(id);
          }
          orchestrator.pendingSubagentSpawns = 0;
        }).catch((err: any) => {
          orchestrator.pendingSubagentSpawns = 0;
          getLogger().error({ s: "planner", err: err.message }, "spawnPlanners failed");
        });
      } else {
        orchestrator.active.state.step = "synthesize";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
    }
  }

  if (orchestrator.active.state.reviewCycle) {
    const cycle = orchestrator.active.state.reviewCycle;
    const phase = orchestrator.active.state.phase;
    const requestedReviewPresetName = orchestrator.active.state.activeReviewPreset
      ?? getDefaultReviewPresetName(orchestrator.config, phase);
    const group = getReviewPresetGroup(phase);
    const reviewPresetExists = Object.prototype.hasOwnProperty.call(orchestrator.config.presets[group] ?? {}, requestedReviewPresetName);
    const presetName = reviewPresetExists
      ? requestedReviewPresetName
      : (Object.keys(orchestrator.config.presets[group] ?? {})[0] ?? requestedReviewPresetName);
    if (orchestrator.active.state.activeReviewPreset !== presetName) {
      orchestrator.active.state.activeReviewPreset = presetName;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    if (!reviewPresetExists && presetName !== requestedReviewPresetName) {
      ctx.ui.notify(
        `Review preset "${requestedReviewPresetName}" not found. Falling back to "${presetName}".`,
        "warning",
      );
    }
    const reviewers = phase === "brainstorm"
      ? resolvePreset(orchestrator.config, "brainstormReviewers", presetName)
      : phase === "plan"
      ? resolvePreset(orchestrator.config, "planReviewers", presetName)
      : resolvePreset(orchestrator.config, "codeReviewers", presetName);
    const reviewerCount = Object.values(reviewers).filter((v) => v.enabled).length;

    if (cycle.kind === "auto" && (cycle.step === "spawn_reviewers" || cycle.step === "await_reviewers")) {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      if (outputs.length >= reviewerCount) {
        cycle.step = "apply_feedback";
        orchestrator.active.state.step = "apply_feedback";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
        pi.sendMessage(
          {
            customType: "pp-review-ready",
            content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
            display: false,
          },
          { deliverAs: "steer" },
        );
      } else {
        const completedVariants = new Set(
          outputs.map((o) => o.name.replace(/^\d+_/, "").replace(/_round-\d+\.md$/, "").replace(/\.md$/, "")),
        );
        const enabledVariants = Object.entries(reviewers).filter(([, v]) => v.enabled);
        const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));

        if (missingVariants.length === 0) {
          cycle.step = "apply_feedback";
          orchestrator.active.state.step = "apply_feedback";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
          pi.sendMessage(
            {
              customType: "pp-review-ready",
              content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
              display: false,
            },
            { deliverAs: "steer" },
          );
        } else {
          const missingReviewerConfig: typeof reviewers = {};
          for (const [name, cfg] of missingVariants) missingReviewerConfig[name] = cfg;
          orchestrator.active.state.activeReviewPreset = presetName;
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          orchestrator.pendingSubagentSpawns = missingVariants.length;
          const spawnFn = phase === "brainstorm"
            ? () => spawnBrainstormReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              missingReviewerConfig,
              orchestrator.active?.state.repos ?? [],
            )
            : phase === "plan"
            ? () => spawnPlanReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              missingReviewerConfig,
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
              missingReviewerConfig,
              orchestrator.active?.state.repos ?? [],
            );
          orchestrator.failedReviewerVariants = [];
          spawnFn().then((result) => {
            orchestrator.failedReviewerVariants = result.failedVariants;
            if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
            for (const id of result.agentIds ?? []) {
              orchestrator.spawnedAgentIds.delete(id);
            }
            orchestrator.pendingSubagentSpawns = 0;
          }).catch((err: any) => {
            orchestrator.pendingSubagentSpawns = 0;
            getLogger().error({ s: "review", err: err.message }, "spawn reviewers failed");
          });
          cycle.step = "await_reviewers";
          orchestrator.active.state.step = "await_reviewers";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
        }
      }
    } else if (cycle.step === "apply_feedback") {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
      pi.sendMessage(
        {
          customType: "pp-review-ready",
          content: `[PI-PI] Review cycle is in apply_feedback step.\n\n${rendered}`,
          display: false,
        },
        { deliverAs: "steer" },
      );
    }
  }

  const step = orchestrator.active.state.step;
  if (step === "await_planners" || step === "await_reviewers") {
    ctx.ui.notify(`Resumed task. Awaiting subagents (${step}).`, "info");
  } else if (step === "apply_feedback") {
    orchestrator.safeSendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Read reviewer outputs and apply feedback.`);
  } else {
    orchestrator.safeSendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Continue working.`);
  }

  if (needsRepoRegistrationPrompt) {
    orchestrator.safeSendUserMessage(
      "[PI-PI] Register your repos using pp_register_repo (including the root) before continuing.",
    );
  }

  return { ok: true };
}

function listCompletedFromTasks(cwd: string): TaskInfo[] {
  const paused = new Set<string>([
    ...listTasks(cwd, "brainstorm").map((t) => t.dir),
    ...listTasks(cwd, "debug").map((t) => t.dir),
    ...listTasks(cwd, "review").map((t) => t.dir),
  ]);
  const results: TaskInfo[] = [];

  for (const type of ["brainstorm", "debug", "review"] as TaskType[]) {
    const typeDir = join(cwd, ".pp", "state", type);
    if (!existsSync(typeDir)) continue;
    for (const entry of readdirSync(typeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(typeDir, entry.name);
      if (paused.has(dir)) continue;
      try {
        const state = loadTask(dir);
        if (state.phase !== "done") continue;
        if (!existsSync(join(dir, "USER_REQUEST.md")) || !existsSync(join(dir, "RESEARCH.md"))) continue;
        results.push({ dir, state, type });
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => {
    const aTime = a.state.startedAt ? new Date(a.state.startedAt).getTime() : 0;
    const bTime = b.state.startedAt ? new Date(b.state.startedAt).getTime() : 0;
    return bTime - aTime;
  });

  return results;
}

async function showSubagentsMenu(ctx: any): Promise<void> {
  const api = (globalThis as any)[Symbol.for("pi-subagents:menu")] as { showMenu?: (menuCtx: any) => Promise<void> } | undefined;
  if (!api?.showMenu) {
    ctx.ui.notify("Subagents menu API is not available.", "warning");
    return;
  }
  await api.showMenu(ctx);
}

async function showLspMenu(ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "LSP", [
      { title: "Status", description: "Show detected language servers and their state" },
      { title: "Restart", description: "Stop all servers. They reinitialize on next use" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as {
      status?: (menuCtx: any) => Promise<void>;
      restart?: (menuCtx: any) => Promise<void>;
    } | undefined;

    if (!api?.status || !api?.restart) {
      ctx.ui.notify("LSP API is not available.", "warning");
      continue;
    }

    if (choice === "Status") {
      await api.status(ctx);
      continue;
    }

    await api.restart(ctx);
  }
}

function countFlantProviders(settings: FlantSettings): { anthropic: number; openai: number } {
  const models = settings.cachedFlantModels ?? [];
  const anthropic = models.filter((m) => m.startsWith("claude-")).length;
  return { anthropic, openai: Math.max(0, models.length - anthropic) };
}

function collectRoleAssignments(config: Partial<PiPiConfig> | null): string[] {
  if (!config) return [];
  const out: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (typeof value === "string" && value.length > 0) out.push(`${key} = ${value}`);
  };

  add("mainModel.implement", config.mainModel?.implement?.model);
  add("mainModel.debug", config.mainModel?.debug?.model);
  add("mainModel.brainstorm", config.mainModel?.brainstorm?.model);
  add("mainModel.review", config.mainModel?.review?.model);

  const addPresetAssignments = (group: "planners" | "planReviewers" | "codeReviewers" | "brainstormReviewers") => {
    const presets = config.presets?.[group];
    if (!presets || typeof presets !== "object") return;
    for (const [presetName, variants] of Object.entries(presets)) {
      if (!variants || typeof variants !== "object") continue;
      for (const [name, variant] of Object.entries(variants as Record<string, any>)) {
        if (variant?.enabled) add(`presets.${group}.${presetName}.${name}`, variant.model);
      }
    }
  };

  addPresetAssignments("planners");
  addPresetAssignments("planReviewers");
  addPresetAssignments("codeReviewers");
  addPresetAssignments("brainstormReviewers");

  add("agents.explore", config.agents?.explore?.model);
  add("agents.librarian", config.agents?.librarian?.model);
  add("agents.task", config.agents?.task?.model);
  return out;
}

function flantStatusText(settings: FlantSettings): string {
  const providers = countFlantProviders(settings);
  const assignments = collectRoleAssignments(getFlantGeneratedConfig());
  const lines = [
    `Enabled: ${settings.enabled ? "yes" : "no"}`,
    `Auto-update: ${settings.autoUpdate ? "yes" : "no"}`,
    `Last updated: ${settings.lastUpdated ?? "never"}`,
    `Providers: pp-flant-anthropic (${providers.anthropic} models), pp-flant-openai (${providers.openai} models)`,
  ];
  if (assignments.length === 0) {
    lines.push("Role assignments: none");
  } else {
    lines.push("Role assignments:");
    for (const assignment of assignments) {
      lines.push(`- ${assignment}`);
    }
  }
  return lines.join("\n");
}

function describeUpdateResult(result: { ok: boolean; error?: string; models?: string[] }): { text: string; kind: "info" | "warning" | "error" } {
  if (!result.ok) {
    return { text: `Flant update failed: ${result.error ?? "unknown error"}`, kind: "error" };
  }
  const models = result.models ?? [];
  const anthropic = models.filter((m) => m.startsWith("claude-")).length;
  const openai = Math.max(0, models.length - anthropic);
  return {
    text: `Flant update completed: ${models.length} models (pp-flant-anthropic: ${anthropic}, pp-flant-openai: ${openai}).`,
    kind: "info",
  };
}

async function showFlantInfraMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const settings = loadFlantSettings();
    const enableLabel = `Enable: ${settings.enabled ? "ON" : "OFF"}`;
    const options: OptionInput[] = [enableLabel];
    if (settings.enabled) {
      options.push(
        `Auto-update on startup: ${settings.autoUpdate ? "ON" : "OFF"}`,
        `Cache period: ${settings.cacheTTLDays} ${settings.cacheTTLDays === 1 ? "day" : "days"}`,
        "Update now",
        "Current status",
      );
    }
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Flant AI Infrastructure", options);
    if (!choice || choice === "Back") return BACK;

    if (choice === enableLabel) {
      if (settings.enabled) {
        const next = { ...settings, enabled: false };
        saveFlantSettings(next);
        unregisterFlantProviders(orchestrator.pi);
        clearFlantGeneratedConfig();
        ctx.ui.notify("Flant AI Infrastructure disabled.", "info");
      } else {
        if (!process.env.FLANT_API_KEY) {
          ctx.ui.notify("Set FLANT_API_KEY environment variable first.", "warning");
          continue;
        }
        const next = { ...settings, enabled: true };
        saveFlantSettings(next);
        const result = await updateFlantInfra(orchestrator.pi);
        const message = describeUpdateResult(result);
        ctx.ui.notify(message.text, message.kind);
      }
      continue;
    }

    if (choice.startsWith("Auto-update on startup:")) {
      saveFlantSettings({ ...settings, autoUpdate: !settings.autoUpdate });
      ctx.ui.notify(`Auto-update on startup: ${!settings.autoUpdate ? "ON" : "OFF"}`, "info");
      continue;
    }

    if (choice.startsWith("Cache period:")) {
      const selected = await selectOption(ctx, "Cache period", [
        { title: "1 day", description: "Refresh model metadata daily" },
        { title: "3 days", description: "Refresh model metadata every three days" },
        { title: "7 days", description: "Default — refresh weekly" },
        { title: "14 days", description: "Refresh model metadata every two weeks" },
        { title: "30 days", description: "Refresh model metadata monthly" },
        { title: "Back", description: "Return to the previous menu" },
      ]);
      if (!selected || selected === "Back") continue;
      const days = Number(selected.split(" ")[0]);
      if (!Number.isFinite(days) || days <= 0) continue;
      saveFlantSettings({ ...settings, cacheTTLDays: days });
      ctx.ui.notify(`Cache period set to ${days} ${days === 1 ? "day" : "days"}.`, "info");
      continue;
    }

    if (choice === "Update now") {
      const result = await updateFlantInfra(orchestrator.pi);
      const message = describeUpdateResult(result);
      ctx.ui.notify(message.text, message.kind);
      continue;
    }

    ctx.ui.notify(flantStatusText(settings), "info");
  }
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatElapsedDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function showUsage(ctx: any): void {
  const tracker = (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] as
    | {
        getTotalInputTokens(): number; getTotalOutputTokens(): number;
        getTotalCacheReadTokens(): number; getTotalCacheWriteTokens(): number;
        getTotalCost(): number; getCacheHitRate(): number;
        getMainInputTokens(): number; getMainOutputTokens(): number;
        getMainCacheReadTokens(): number; getMainCacheWriteTokens(): number;
        getMainCost(): number;
        getPerModelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; turns: number }>;
        getSubagentList(): Array<{ description: string; agentType: string; modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number }>;
      }
    | undefined;

  if (!tracker) {
    ctx.ui.notify("No usage data available.", "info");
    return;
  }

  const totalInput = tracker.getTotalInputTokens();
  const totalOutput = tracker.getTotalOutputTokens();
  const totalCacheRead = tracker.getTotalCacheReadTokens();
  const totalCost = tracker.getTotalCost();
  const totalCacheRate = (totalCacheRead + totalInput) > 0
    ? totalCacheRead / (totalCacheRead + totalInput)
    : 0;

  const mainInput = tracker.getMainInputTokens();
  const mainOutput = tracker.getMainOutputTokens();
  const mainCacheRead = tracker.getMainCacheReadTokens();
  const mainCost = tracker.getMainCost();
  const models = tracker.getPerModelUsage();
  const subagents = tracker.getSubagentList();

  const byModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cacheSupported: boolean; cost: number }>();
  const mainModelEntries = Object.entries(models);
  const mainTotalTokens = mainModelEntries.reduce((s, [, u]) => s + u.inputTokens + u.outputTokens, 0);
  for (const [modelId, usage] of mainModelEntries) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const modelCostShare = mainTotalTokens > 0 ? mainCost * (modelTokens / mainTotalTokens) : 0;
    byModel.set(modelId, {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, cacheSupported: usage.cacheSupported, cost: modelCostShare,
    });
  }
  for (const sa of subagents) {
    const key = sa.modelId !== "unknown" ? sa.modelId : `subagent:${sa.description}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
    } else {
      byModel.set(key, {
        input: sa.inputTokens, output: sa.outputTokens,
        cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens, cacheSupported: sa.cacheSupported, cost: sa.cost,
      });
    }
  }

  const lines: string[] = ["Session usage (total):"];
  lines.push(`  Input: ${formatTokenCount(totalInput)} tokens`);
  lines.push(`  Output: ${formatTokenCount(totalOutput)} tokens`);
  if (totalCacheRead > 0) lines.push(`  Cache: ⚡${Math.round(totalCacheRate * 100)}% hit rate`);
  if (totalCost > 0) lines.push(`  Cost: $${totalCost.toFixed(2)}`);

  if (byModel.size > 0) {
    lines.push("");
    lines.push("By model:");
    for (const [modelId, m] of byModel) {
      const cr = (m.cacheRead + m.input) > 0 ? Math.round(m.cacheRead / (m.cacheRead + m.input) * 100) : 0;
      const parts = [`↑${formatTokenCount(m.input)}`, `↓${formatTokenCount(m.output)}`];
      if (m.cacheSupported) parts.push(`⚡${cr}%`);
      if (m.cost > 0) parts.push(`$${m.cost.toFixed(2)}`);
      lines.push(`  ${modelId}: ${parts.join("  ")}`);
    }
  }

  lines.push("");
  lines.push("By agent:");
  const agentModelNames = Object.keys(models);
  if (agentModelNames.length > 0) {
    const mainCacheSupported = mainModelEntries.some(([, u]) => u.cacheSupported);
    const mainParts = [`↑${formatTokenCount(mainInput)}`, `↓${formatTokenCount(mainOutput)}`];
    const mainCR = (mainCacheRead + mainInput) > 0 ? Math.round(mainCacheRead / (mainCacheRead + mainInput) * 100) : 0;
    if (mainCacheSupported) mainParts.push(`⚡${mainCR}%`);
    if (mainCost > 0) mainParts.push(`$${mainCost.toFixed(2)}`);
    lines.push(`  Main (${agentModelNames.join(", ")}): ${mainParts.join("  ")}`);
  }
  const byAgentType = new Map<string, { input: number; output: number; cacheRead: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number; count: number }>();
  for (const sa of subagents) {
    const key = sa.agentType || sa.description;
    const existing = byAgentType.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
      existing.durationMs += sa.durationMs;
      existing.toolUses += sa.toolUses;
      existing.count += 1;
    } else {
      byAgentType.set(key, {
        input: sa.inputTokens, output: sa.outputTokens, cacheRead: sa.cacheReadTokens,
        cacheSupported: sa.cacheSupported, cost: sa.cost, durationMs: sa.durationMs, toolUses: sa.toolUses, count: 1,
      });
    }
  }
  for (const [agentType, agg] of byAgentType) {
    const saCR = (agg.cacheRead + agg.input) > 0
      ? Math.round(agg.cacheRead / (agg.cacheRead + agg.input) * 100) : 0;
    const parts = [`↑${formatTokenCount(agg.input)}`, `↓${formatTokenCount(agg.output)}`];
    if (agg.cacheSupported) parts.push(`⚡${saCR}%`);
    if (agg.cost > 0) parts.push(`$${agg.cost.toFixed(2)}`);
    if (agg.durationMs > 0) parts.push(formatElapsedDuration(agg.durationMs));
    if (agg.toolUses > 0) parts.push(`${agg.toolUses} tools`);
    const countSuffix = agg.count > 1 ? ` (×${agg.count})` : "";
    lines.push(`  ${agentType}${countSuffix}: ${parts.join("  ")}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function showInfoMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = [];
    options.push({ title: "Subagents", description: "Manage running agents" });
    options.push({ title: "LSP", description: "Language server status and controls" });
    options.push({ title: "Usage", description: "Show session token usage and cost breakdown" });
    if (orchestrator.active) {
      options.push({ title: "Task status", description: "Show current task phase, step, and timing" });
    }
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Info", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }
    if (choice === "LSP") {
      await showLspMenu(ctx);
      continue;
    }
    if (choice === "Usage") {
      showUsage(ctx);
      continue;
    }
    if (choice === "Task status") {
      showStatus(orchestrator, ctx);
      continue;
    }
  }
}

type Scope = "global" | "project";
type MainModelRole = keyof PiPiConfig["mainModel"];
type AgentRole = keyof PiPiConfig["agents"];
type TimeoutKey = keyof PiPiConfig["timeouts"];
type CommandListKey = keyof PiPiConfig["commands"];

export interface ConfigSourceInfo {
  activeValue: any;
  defaultValue: any;
  flantValue: any | undefined;
  globalValue: any | undefined;
  projectValue: any | undefined;
  source: "default" | "flant" | "global" | "project";
}

const ORCHESTRATOR_ROLES: Array<{ role: MainModelRole; label: string; description: string }> = [
  { role: "brainstorm", label: "Brainstormer", description: "mainModel.brainstorm" },
  { role: "implement", label: "Implementer", description: "mainModel.implement (also used for plan phase)" },
  { role: "debug", label: "Debugger", description: "mainModel.debug" },
  { role: "review", label: "Reviewer", description: "mainModel.review" },
];

const SUBAGENT_ROLES: Array<{ role: AgentRole; label: string; description: string }> = [
  { role: "explore", label: "Explore", description: "agents.explore" },
  { role: "librarian", label: "Librarian", description: "agents.librarian" },
  { role: "task", label: "Task", description: "agents.task" },
];

const PRESET_GROUP_ITEMS: Array<{ group: PresetGroup; label: string }> = [
  { group: "brainstormReviewers", label: "Brainstorm reviewers" },
  { group: "planners", label: "Planners" },
  { group: "planReviewers", label: "Plan reviewers" },
  { group: "codeReviewers", label: "Code reviewers" },
];

const TIMEOUT_LABELS: Record<TimeoutKey, string> = {
  afterEdit: "After file edit command",
  afterImplement: "After implementation command",
  agentSpawn: "Subagent spawn",
  agentReadyPing: "Subagent ready ping",
  agentStale: "Subagent stale",
  lockStale: "Lock stale",
  lockUpdate: "Lock update",
};

const VALID_NAME_RE = /^[A-Za-z0-9-]+$/;

function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pp", "config.json");
}

function getScopeConfigPath(orchestrator: Orchestrator, scope: Scope): string {
  return scope === "global" ? GLOBAL_CONFIG_PATH : getProjectConfigPath(orchestrator.cwd);
}

function hasNestedKey(obj: unknown, keyPath: string[]): boolean {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

function getNestedValue(obj: unknown, keyPath: string[]): any {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setNestedValue(obj: Record<string, any>, keyPath: string[], value: any): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) cursor[key] = {};
    cursor = cursor[key] as Record<string, any>;
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
}

function deleteNestedValue(obj: Record<string, any>, keyPath: string[]): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    cursor = current;
  }
  delete cursor[keyPath[keyPath.length - 1]!];
}

function formatInlineValue(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tagsString(tags: string[]): string {
  return tags.length > 0 ? `(${tags.join(", ")})` : "";
}

function withTags(label: string, tags: string): string {
  return tags ? `${label} ${tags}` : label;
}

function getRawScopeValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  return getNestedValue(raw, keyPath);
}

function getRawScopeConfigs(orchestrator: Orchestrator): { globalConfig: Record<string, any>; projectConfig: Record<string, any> } {
  return {
    globalConfig: readRawConfig(GLOBAL_CONFIG_PATH),
    projectConfig: readRawConfig(getProjectConfigPath(orchestrator.cwd)),
  };
}

function hasLayerOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): boolean {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  return hasNestedKey(raw, keyPath);
}

function getLayerOverrideValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  return getNestedValue(raw, keyPath);
}

function getOwnedScopes(orchestrator: Orchestrator, keyPath: string[]): Scope[] {
  const out: Scope[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) out.push("global");
  if (hasLayerOverride(orchestrator, "project", keyPath)) out.push("project");
  return out;
}

export function getConfigSourceInfo(orchestrator: Orchestrator, keyPath: string[]): ConfigSourceInfo {
  const { globalConfig, projectConfig } = getRawScopeConfigs(orchestrator);
  const flantConfig = getFlantGeneratedConfig() as Record<string, any> | null;
  const activeValue = getNestedValue(orchestrator.config as Record<string, any>, keyPath);
  const defaultValue = getNestedValue(getDefaultConfig() as Record<string, any>, keyPath);
  const flantValue = flantConfig ? getNestedValue(flantConfig, keyPath) : undefined;
  const globalValue = hasNestedKey(globalConfig, keyPath) ? getNestedValue(globalConfig, keyPath) : undefined;
  const projectValue = hasNestedKey(projectConfig, keyPath) ? getNestedValue(projectConfig, keyPath) : undefined;
  const source = hasNestedKey(projectConfig, keyPath)
    ? "project"
    : hasNestedKey(globalConfig, keyPath)
    ? "global"
    : flantConfig && hasNestedKey(flantConfig, keyPath)
    ? "flant"
    : "default";
  return {
    activeValue,
    defaultValue,
    flantValue,
    globalValue,
    projectValue,
    source,
  };
}

export function formatSourceTags(currentValue: any, info: ConfigSourceInfo): string {
  const tags: string[] = [];
  if (isDeepStrictEqual(currentValue, info.activeValue)) tags.push("active");
  if (isDeepStrictEqual(currentValue, info.defaultValue)) tags.push("default");
  if (info.flantValue !== undefined && isDeepStrictEqual(currentValue, info.flantValue)) tags.push("flant");
  if (info.globalValue !== undefined && isDeepStrictEqual(currentValue, info.globalValue)) tags.push("global");
  if (info.projectValue !== undefined && isDeepStrictEqual(currentValue, info.projectValue)) tags.push("project");
  return tagsString(tags);
}

export function buildResetOptions(orchestrator: Orchestrator, keyPath: string[]): OptionInput[] {
  const options: OptionInput[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) {
    options.push(opt("Reset global setting", formatInlineValue(getLayerOverrideValue(orchestrator, "global", keyPath))));
  }
  if (hasLayerOverride(orchestrator, "project", keyPath)) {
    options.push(opt("Reset project setting", formatInlineValue(getLayerOverrideValue(orchestrator, "project", keyPath))));
  }
  return options;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

export function parseDuration(input: string): number | null {
  const match = /^\s*(\d+)\s*(ms|s|m|h)?\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60000;
  if (unit === "h") return value * 3600000;
  return null;
}

export function slugify(text: string, maxLen = 40): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const safe = collapsed.replace(/[^A-Za-z0-9 _./:-]/g, "").trim();
  const base = safe || collapsed || "(empty)";
  if (base.length <= maxLen) return base;
  return `${base.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function tryApplyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const target = scope === "global" ? nextGlobal : nextProject;
    setNestedValue(target, keyPath, value);
    mergeConfigLayers(nextGlobal, nextProject);
    writeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath, value);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function tryClearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const target = scope === "global" ? nextGlobal : nextProject;
    deleteNestedValue(target, keyPath);
    mergeConfigLayers(nextGlobal, nextProject);
    removeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function parseCommaSeparated(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeUniqueTitle(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (true) {
    const candidate = `${base} (${index})`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeProviderLabel(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "x-ai") return "xAI";
  if (provider === "qwen") return "Qwen";
  if (provider === "pp-flant-anthropic") return "Flant Anthropic";
  if (provider === "pp-flant-openai") return "Flant OpenAI";
  return provider;
}

function providerOrder(provider: string): number {
  if (provider === "pp-flant-anthropic") return 0;
  if (provider === "pp-flant-openai") return 1;
  if (provider === "anthropic") return 2;
  if (provider === "openai") return 3;
  if (provider === "google") return 4;
  if (provider === "deepseek") return 5;
  if (provider === "x-ai") return 6;
  if (provider === "qwen") return 7;
  return 99;
}

function compareModelVersion(a: string, b: string): number {
  const aParts = (a.match(/\d+/g) ?? []).map(Number);
  const bParts = (b.match(/\d+/g) ?? []).map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return a.localeCompare(b);
}

function listAvailableModels(ctx: any): Array<{ provider: string; id: string; spec: string }> {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return [];

  const seen = new Set<string>();
  const models: Array<{ provider: string; id: string; spec: string }> = [];
  for (const model of available) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const spec = `${provider}/${id}`;
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id, spec });
  }

  models.sort((a, b) => {
    const byProviderOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byProviderOrder !== 0) return byProviderOrder;
    const byProviderName = a.provider.localeCompare(b.provider);
    if (byProviderName !== 0) return byProviderName;
    return compareModelVersion(b.id, a.id);
  });

  return models;
}

async function pickScope(ctx: any, orchestrator: Orchestrator): Promise<Scope | null> {
  const choice = await selectOption(ctx, "Scope", [
    opt("Set globally", GLOBAL_CONFIG_PATH),
    opt("Set for project", getProjectConfigPath(orchestrator.cwd)),
    opt("Back", "Return to the previous menu"),
  ]);
  if (!choice || choice === "Back") return null;
  if (choice === "Set globally") return "global";
  if (choice === "Set for project") return "project";
  return null;
}

async function pickScopeFromOwned(ctx: any, orchestrator: Orchestrator, keyPath: string[]): Promise<Scope | null> {
  const scopes = getOwnedScopes(orchestrator, keyPath);
  if (scopes.length === 0) return null;
  if (scopes.length === 1) return scopes[0]!;
  const options: OptionInput[] = [
    opt("Global override", GLOBAL_CONFIG_PATH),
    opt("Project override", getProjectConfigPath(orchestrator.cwd)),
    opt("Back", "Return to the previous menu"),
  ];
  const choice = await selectOption(ctx, "Choose override scope", options);
  if (!choice || choice === "Back") return null;
  return choice === "Global override" ? "global" : "project";
}

async function pickModel(ctx: any, currentModel?: string): Promise<string | null> {
  const aliasMap = getAllAliases();
  const families = getModelFamilies();
  const availableModels = listAvailableModels(ctx);
  const availableSpecs = new Set(availableModels.map((m) => m.spec));
  const currentResolved = currentModel ? resolveModel(currentModel) : null;
  const currentAvailable = currentResolved ? availableSpecs.has(currentResolved) : false;
  const visibleAliases = new Set(
    Object.entries(aliasMap)
      .filter(([, resolved]) => availableSpecs.has(resolved))
      .map(([alias]) => alias),
  );
  const options: OptionInput[] = [];
  const selectionToModel = new Map<string, string>();
  const usedTitles = new Set<string>();

  if (currentModel && !visibleAliases.has(currentModel)) {
    const tags = ["active"];
    if (!currentAvailable) tags.push("unavailable");
    const title = makeUniqueTitle(withTags(currentModel, tagsString(tags)), usedTitles);
    options.push(opt(title, "Current model"));
    selectionToModel.set(title, currentModel);
  }

  const aliasEntries: Array<{ provider: string; displayName: string; alias: string }> = [];
  for (const family of families) {
    for (const alias of family.aliases) {
      if (!visibleAliases.has(alias)) continue;
      aliasEntries.push({
        provider: alias.split("/")[0] ?? "",
        displayName: family.displayName,
        alias,
      });
    }
  }

  aliasEntries.sort((a, b) => {
    const byProviderOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byProviderOrder !== 0) return byProviderOrder;
    const byProviderName = a.provider.localeCompare(b.provider);
    if (byProviderName !== 0) return byProviderName;
    return a.displayName.localeCompare(b.displayName);
  });

  for (const entry of aliasEntries) {
    const providerLabel = normalizeProviderLabel(entry.provider);
    const tags = entry.alias === currentModel ? tagsString(["active"]) : "";
    const title = makeUniqueTitle(withTags(`${providerLabel} — ${entry.displayName} (latest)`, tags), usedTitles);
    options.push(opt(title, entry.alias));
    selectionToModel.set(title, entry.alias);
  }

  if (availableModels.length > 0) {
    for (const model of availableModels) {
      if (currentModel && model.spec === currentModel) continue;
      const providerLabel = normalizeProviderLabel(model.provider);
      const title = makeUniqueTitle(`${providerLabel} — ${model.id}`, usedTitles);
      options.push(opt(title, model.spec));
      selectionToModel.set(title, model.spec);
    }
  }

  options.push(opt("Back", "Return to the previous menu"));

  while (true) {
    const choice = await selectOption(ctx, "Model", options);
    if (!choice || choice === "Back") return null;
    const selected = selectionToModel.get(choice);
    if (selected) return selected;
  }
}

async function pickThinking(
  ctx: any,
  allowXhigh: boolean,
  orchestrator?: Orchestrator,
  keyPath?: string[],
): Promise<string | null> {
  const options: OptionInput[] = [];
  const byTitle = new Map<string, string>();
  const usedTitles = new Set<string>();
  const values = ["off", "low", "medium", "high"];
  if (allowXhigh) values.push("xhigh");
  const info = orchestrator && keyPath ? getConfigSourceInfo(orchestrator, keyPath) : null;
  for (const value of values) {
    const label = thinkingLabel(value);
    const title = makeUniqueTitle(withTags(label, info ? formatSourceTags(value, info) : ""), usedTitles);
    options.push(title);
    byTitle.set(title, value);
  }
  options.push(opt("Back", "Return to the previous menu"));
  const choice = await selectOption(ctx, "Thinking level", options);
  if (!choice || choice === "Back") return null;
  return byTitle.get(choice) ?? null;
}

function refreshSubagentDefinitions(orchestrator: Orchestrator, keyPath: string[]): void {
  if (keyPath[0] !== "agents") return;
  unregisterAgentDefinitions(orchestrator.pi);
  orchestrator.registerAgents();
}

function applyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): void {
  const result = tryApplyConfigChange(orchestrator, scope, keyPath, value);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify(`Config update rejected: ${result.error}`, "error");
    return;
  }
  const available = (orchestrator.lastCtx as any)?.modelRegistry?.getAvailable?.();
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
  refreshSubagentDefinitions(orchestrator, keyPath);
}

function clearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): void {
  const result = tryClearConfigOverride(orchestrator, scope, keyPath);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify(`Config update rejected: ${result.error}`, "error");
    return;
  }
  refreshSubagentDefinitions(orchestrator, keyPath);
}

function thinkingLabel(value: string): string {
  if (value === "off") return "Off";
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  if (value === "xhigh") return "Extra High";
  return value;
}

function logLevelLabel(value: string): string {
  if (value === "debug") return "Debug";
  if (value === "info") return "Info";
  if (value === "warn") return "Warning";
  if (value === "error") return "Error";
  return value;
}

function applyScopeChoice(orchestrator: Orchestrator, keyPath: string[], value: any, scope: Scope | null): void {
  if (!scope) return;
  applyConfigChange(orchestrator, scope, keyPath, value);
}

function enabledPresetSummary(variants: Record<string, VariantConfig>): string {
  const enabled = Object.entries(variants)
    .filter(([, variant]) => variant.enabled)
    .map(([name, variant]) => {
      const info = getModelInfo(variant.model);
      return `${name}: ${info.vendor}/${info.family} (${variant.thinking})`;
    });
  return enabled.length > 0 ? enabled.join(", ") : "No enabled models";
}

async function promptRequiredInput(ctx: any, label: string): Promise<string | null> {
  const value = await ctx.ui.input(label);
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed;
}

async function promptSafeName(ctx: any, label: string): Promise<string | null> {
  const value = await promptRequiredInput(ctx, label);
  if (!value) return null;
  if (!VALID_NAME_RE.test(value)) {
    ctx.ui.notify("Use only letters, numbers, and '-'.", "warning");
    return null;
  }
  return value;
}

function maybeHandleResetChoice(orchestrator: Orchestrator, choice: string, keyPath: string[]): boolean {
  if (choice === "Reset global setting") {
    clearConfigOverride(orchestrator, "global", keyPath);
    return true;
  }
  if (choice === "Reset project setting") {
    clearConfigOverride(orchestrator, "project", keyPath);
    return true;
  }
  return false;
}

async function showOrchestratorEditor(
  orchestrator: Orchestrator,
  ctx: any,
  role: MainModelRole,
  label: string,
): Promise<typeof BACK> {
  while (true) {
    const current = orchestrator.config.mainModel[role];
    const modelInfo = getConfigSourceInfo(orchestrator, ["mainModel", role, "model"]);
    const thinkingInfo = getConfigSourceInfo(orchestrator, ["mainModel", role, "thinking"]);
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${withTags(current.model, formatSourceTags(current.model, modelInfo))}`, "Select model"),
      opt(`Thinking: ${withTags(thinkingLabel(current.thinking), formatSourceTags(current.thinking, thinkingInfo))}`, "Select thinking level"),
      ...buildResetOptions(orchestrator, ["mainModel", role]),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, current.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, ["mainModel", role, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, false, orchestrator, ["mainModel", role, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, ["mainModel", role, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    maybeHandleResetChoice(orchestrator, choice, ["mainModel", role]);
  }
}

async function showOrchestratorsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = ORCHESTRATOR_ROLES.map(({ role, label, description }) => {
      const current = orchestrator.config.mainModel[role];
      return opt(label, `${current.model} / ${thinkingLabel(current.thinking)} — ${description}`);
    });
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Orchestrators", options);
    if (!choice || choice === "Back") return BACK;
    const picked = ORCHESTRATOR_ROLES.find((item) => item.label === choice);
    if (!picked) continue;
    await showOrchestratorEditor(orchestrator, ctx, picked.role, picked.label);
  }
}

async function showSimpleSubagentEditor(
  orchestrator: Orchestrator,
  ctx: any,
  role: AgentRole,
  label: string,
): Promise<typeof BACK> {
  while (true) {
    const current = orchestrator.config.agents[role];
    const modelInfo = getConfigSourceInfo(orchestrator, ["agents", role, "model"]);
    const thinkingInfo = getConfigSourceInfo(orchestrator, ["agents", role, "thinking"]);
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${withTags(current.model, formatSourceTags(current.model, modelInfo))}`, "Select model"),
      opt(`Thinking: ${withTags(thinkingLabel(current.thinking), formatSourceTags(current.thinking, thinkingInfo))}`, "Select thinking level"),
      ...buildResetOptions(orchestrator, ["agents", role]),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, current.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, ["agents", role, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, true, orchestrator, ["agents", role, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, ["agents", role, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    maybeHandleResetChoice(orchestrator, choice, ["agents", role]);
  }
}

async function addPresetVariant(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<void> {
  const variantName = await promptSafeName(ctx, "Agent name");
  if (!variantName) return;
  if (orchestrator.config.presets[group]?.[presetName]?.[variantName]) {
    ctx.ui.notify(`Agent '${variantName}' already exists.`, "warning");
    return;
  }
  const model = await pickModel(ctx);
  if (!model) return;
  const thinking = await pickThinking(ctx, true);
  if (!thinking) return;
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return;
  applyConfigChange(orchestrator, scope, ["presets", group, presetName, variantName], {
    enabled: true,
    model,
    thinking,
  });
}

async function removePresetVariant(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
  variantName: string,
): Promise<void> {
  const scope = await pickScopeFromOwned(ctx, orchestrator, ["presets", group, presetName, variantName]);
  if (!scope) return;
  const rawPresetValue = getRawScopeValue(orchestrator, scope, ["presets", group, presetName]);
  if (!rawPresetValue || typeof rawPresetValue !== "object" || Array.isArray(rawPresetValue)) {
    ctx.ui.notify("No override in selected scope.", "info");
    return;
  }
  const rawPreset = rawPresetValue as Record<string, VariantConfig>;
  if (!Object.prototype.hasOwnProperty.call(rawPreset, variantName)) {
    ctx.ui.notify("Agent is inherited and cannot be removed in selected scope.", "info");
    return;
  }
  if (Object.keys(rawPreset).length <= 1) {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const target = scope === "global" ? nextGlobal : nextProject;
    deleteNestedValue(target, ["presets", group, presetName]);
    const merged = mergeConfigLayers(nextGlobal, nextProject);
    const mergedPreset = merged.presets[group]?.[presetName] ?? {};
    if (Object.keys(mergedPreset).length === 0) {
      ctx.ui.notify("Cannot delete the last agent: no lower-layer preset is available.", "warning");
      return;
    }
    deletePresetFromScope(orchestrator, scope, group, presetName);
    return;
  }
  const nextPreset = structuredClone(rawPreset);
  delete nextPreset[variantName];
  applyConfigChange(orchestrator, scope, ["presets", group, presetName], nextPreset);
}

async function showPresetVariantEditor(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
  variantName: string,
): Promise<typeof BACK> {
  while (true) {
    const variant = orchestrator.config.presets[group]?.[presetName]?.[variantName];
    if (!variant) return BACK;
    const modelInfo = getConfigSourceInfo(orchestrator, ["presets", group, presetName, variantName, "model"]);
    const thinkingInfo = getConfigSourceInfo(orchestrator, ["presets", group, presetName, variantName, "thinking"]);
    const enabledInfo = getConfigSourceInfo(orchestrator, ["presets", group, presetName, variantName, "enabled"]);
    const options: OptionInput[] = [
      opt(`Model: ${withTags(variant.model, formatSourceTags(variant.model, modelInfo))}`, "Select model"),
      opt(`Thinking: ${withTags(thinkingLabel(variant.thinking), formatSourceTags(variant.thinking, thinkingInfo))}`, "Select thinking level"),
      opt(`${variant.enabled ? "Disable" : "Enable"}: ${withTags(variant.enabled ? "ON" : "OFF", formatSourceTags(variant.enabled, enabledInfo))}`, "Toggle enabled state"),
    ];
    if (getOwnedScopes(orchestrator, ["presets", group, presetName, variantName]).length > 0) {
      options.push(opt("Delete", "Delete this agent override"));
    }
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, variantName, options);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, variant.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, ["presets", group, presetName, variantName, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, true, orchestrator, ["presets", group, presetName, variantName, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, ["presets", group, presetName, variantName, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Disable:") || choice.startsWith("Enable:")) {
      applyScopeChoice(
        orchestrator,
        ["presets", group, presetName, variantName, "enabled"],
        !variant.enabled,
        await pickScope(ctx, orchestrator),
      );
      continue;
    }
    await removePresetVariant(orchestrator, ctx, group, presetName, variantName);
    return BACK;
  }
}

async function showPresetAgentsMenu(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<typeof BACK> {
  while (true) {
    const preset = orchestrator.config.presets[group]?.[presetName] ?? {};
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    for (const [variantName, variant] of Object.entries(preset)) {
      const title = variant.enabled ? variantName : `${variantName} (disabled)`;
      options.push(opt(title, `${variant.model} / ${thinkingLabel(variant.thinking)}`));
      byTitle.set(title, variantName);
    }
    options.push(opt("New agent", "Add a new agent"));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Agents", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New agent") {
      await addPresetVariant(orchestrator, ctx, group, presetName);
      continue;
    }
    const variantName = byTitle.get(choice);
    if (!variantName) continue;
    await showPresetVariantEditor(orchestrator, ctx, group, presetName, variantName);
  }
}

function deletePresetFromScope(orchestrator: Orchestrator, scope: Scope, group: PresetGroup, presetName: string): void {
  const rawGroup = getRawScopeValue(orchestrator, scope, ["presets", group]);
  if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) return;
  const nextGroup = structuredClone(rawGroup as Record<string, Record<string, VariantConfig>>);
  delete nextGroup[presetName];
  if (Object.keys(nextGroup).length === 0) {
    clearConfigOverride(orchestrator, scope, ["presets", group]);
  } else {
    applyConfigChange(orchestrator, scope, ["presets", group], nextGroup);
  }
}

async function showPresetEditor(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<typeof BACK> {
  while (true) {
    const preset = orchestrator.config.presets[group]?.[presetName];
    if (!preset) return BACK;
    const isDefault = orchestrator.config.defaultPresets[group] === presetName;
    const options: OptionInput[] = [
      opt("Use as default", isDefault ? "Already default" : "Set as default preset"),
      opt("Agents", `${Object.keys(preset).length} agents`),
    ];
    if (getOwnedScopes(orchestrator, ["presets", group, presetName]).length > 0) {
      options.push(opt("Delete", "Delete this preset override"));
    }
    options.push(...buildResetOptions(orchestrator, ["presets", group, presetName]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, isDefault ? `${presetName} (default)` : presetName, options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Use as default") {
      applyScopeChoice(orchestrator, ["defaultPresets", group], presetName, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === "Agents") {
      await showPresetAgentsMenu(orchestrator, ctx, group, presetName);
      continue;
    }
    if (choice === "Delete") {
      if (isDefault) {
        ctx.ui.notify("Cannot delete the default preset. Change the default first.", "warning");
        continue;
      }
      const scope = await pickScopeFromOwned(ctx, orchestrator, ["presets", group, presetName]);
      if (!scope) continue;
      deletePresetFromScope(orchestrator, scope, group, presetName);
      return BACK;
    }
    maybeHandleResetChoice(orchestrator, choice, ["presets", group, presetName]);
  }
}

async function addNewPreset(orchestrator: Orchestrator, ctx: any, group: PresetGroup): Promise<void> {
  const name = await promptSafeName(ctx, "Preset name");
  if (!name) return;
  if (orchestrator.config.presets[group]?.[name]) {
    ctx.ui.notify(`Preset '${name}' already exists.`, "warning");
    return;
  }
  const variantName = await promptSafeName(ctx, "Initial agent name");
  if (!variantName) return;
  const model = await pickModel(ctx);
  if (!model) return;
  const thinking = await pickThinking(ctx, true);
  if (!thinking) return;
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return;
  applyConfigChange(orchestrator, scope, ["presets", group, name], {
    [variantName]: { enabled: true, model, thinking },
  });
}

async function showPresetSettings(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  title: string,
): Promise<typeof BACK> {
  while (true) {
    const presets = orchestrator.config.presets[group] ?? {};
    const defaultName = orchestrator.config.defaultPresets[group];
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    for (const [presetName, variants] of Object.entries(presets)) {
      const optionTitle = presetName === defaultName ? `${presetName} (default)` : presetName;
      options.push(opt(optionTitle, enabledPresetSummary(variants)));
      byTitle.set(optionTitle, presetName);
    }
    options.push(opt("New preset", "Create preset"));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, title, options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New preset") {
      await addNewPreset(orchestrator, ctx, group);
      continue;
    }
    const presetName = byTitle.get(choice);
    if (!presetName) continue;
    await showPresetEditor(orchestrator, ctx, group, presetName);
  }
}

async function showSubagentSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = SUBAGENT_ROLES.map(({ role, label, description }) => {
      const current = orchestrator.config.agents[role];
      return opt(label, `${current.model} / ${thinkingLabel(current.thinking)} — ${description}`);
    });
    for (const item of PRESET_GROUP_ITEMS) {
      options.push(opt(item.label, `${Object.keys(orchestrator.config.presets[item.group] ?? {}).length} presets`));
    }
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Subagents", options);
    if (!choice || choice === "Back") return BACK;
    const simple = SUBAGENT_ROLES.find((item) => item.label === choice);
    if (simple) {
      await showSimpleSubagentEditor(orchestrator, ctx, simple.role, simple.label);
      continue;
    }
    const group = PRESET_GROUP_ITEMS.find((item) => item.label === choice);
    if (!group) continue;
    await showPresetSettings(orchestrator, ctx, group.group, group.label);
  }
}

function getEditableCommandList(orchestrator: Orchestrator, scope: Scope, key: CommandListKey): any[] {
  void scope;
  return structuredClone(orchestrator.config.commands[key]);
}

function writeCommandList(orchestrator: Orchestrator, scope: Scope, key: CommandListKey, list: any[]): void {
  applyConfigChange(orchestrator, scope, ["commands", key], list);
}

async function showAfterEditCommands(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const commands = orchestrator.config.commands.afterEdit;
    const info = getConfigSourceInfo(orchestrator, ["commands", "afterEdit"]);
    const options: OptionInput[] = [];
    const byTitle = new Map<string, number>();
    const usedTitles = new Set<string>();
    commands.forEach((cmd, index) => {
      const title = makeUniqueTitle(slugify(cmd.run, 56), usedTitles);
      options.push(opt(title, `${cmd.glob.length} patterns`));
      byTitle.set(title, index);
    });
    options.push(opt("New command", "Add command"));
    options.push(...buildResetOptions(orchestrator, ["commands", "afterEdit"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `After file edit: ${commands.length} commands ${formatSourceTags(commands, info)}`.trim(), options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New command") {
      const run = await promptRequiredInput(ctx, "Command to run");
      if (!run) continue;
      const globInput = await promptRequiredInput(ctx, "Glob patterns (comma-separated)");
      if (!globInput) {
        ctx.ui.notify("At least one file pattern is required.", "warning");
        continue;
      }
      const patterns = parseCommaSeparated(globInput);
      if (patterns.length === 0) {
        ctx.ui.notify("At least one file pattern is required.", "warning");
        continue;
      }
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const list = getEditableCommandList(orchestrator, scope, "afterEdit") as AfterEditCommand[];
      list.push({ run, glob: patterns });
      writeCommandList(orchestrator, scope, "afterEdit", list);
      continue;
    }
    if (maybeHandleResetChoice(orchestrator, choice, ["commands", "afterEdit"])) continue;
    const index = byTitle.get(choice);
    if (index === undefined) continue;
    while (true) {
      const command = orchestrator.config.commands.afterEdit[index];
      if (!command) break;
      const commandChoice = await selectOption(ctx, slugify(command.run, 70), [
        opt("Command", "View or edit command string"),
        opt("Triggers", `${command.glob.length} patterns`),
        opt("Delete command", "Remove this command"),
        opt("Back", "Return to previous menu"),
      ]);
      if (!commandChoice || commandChoice === "Back") break;
      if (commandChoice === "Command") {
        const action = await selectOption(ctx, "Command", [
          opt("View", command.run),
          opt("Edit", "Edit command string"),
          opt("Back", "Return to previous menu"),
        ]);
        if (action === "View") {
          ctx.ui.notify(command.run, "info");
          continue;
        }
        if (action === "Edit") {
          const run = await promptRequiredInput(ctx, "New command string");
          if (!run) continue;
          const scope = await pickScope(ctx, orchestrator);
          if (!scope) continue;
          const list = getEditableCommandList(orchestrator, scope, "afterEdit") as AfterEditCommand[];
          if (!list[index]) continue;
          list[index] = { ...list[index], run };
          writeCommandList(orchestrator, scope, "afterEdit", list);
        }
        continue;
      }
      if (commandChoice === "Triggers") {
        while (true) {
          const current = orchestrator.config.commands.afterEdit[index];
          if (!current) break;
          const patternOptions: OptionInput[] = current.glob.map((glob) => opt(glob, "Pattern"));
          patternOptions.push(opt("New pattern", "Add trigger pattern"));
          patternOptions.push(opt("Back", "Return to previous menu"));
          const patternChoice = await selectOption(ctx, "File patterns", patternOptions);
          if (!patternChoice || patternChoice === "Back") break;
          if (patternChoice === "New pattern") {
            const value = await promptRequiredInput(ctx, "Pattern");
            if (!value) continue;
            const scope = await pickScope(ctx, orchestrator);
            if (!scope) continue;
            const list = getEditableCommandList(orchestrator, scope, "afterEdit") as AfterEditCommand[];
            if (!list[index]) continue;
            list[index] = { ...list[index], glob: [...(list[index].glob ?? []), value] };
            writeCommandList(orchestrator, scope, "afterEdit", list);
            continue;
          }
          const patternIndex = current.glob.findIndex((glob) => glob === patternChoice);
          if (patternIndex < 0) continue;
          const action = await selectOption(ctx, patternChoice, [
            opt("View", patternChoice),
            opt("Edit", "Edit pattern"),
            opt("Delete", "Delete pattern"),
            opt("Back", "Return to previous menu"),
          ]);
          if (!action || action === "Back") continue;
          if (action === "View") {
            ctx.ui.notify(patternChoice, "info");
            continue;
          }
          const scope = await pickScope(ctx, orchestrator);
          if (!scope) continue;
          const list = getEditableCommandList(orchestrator, scope, "afterEdit") as AfterEditCommand[];
          if (!list[index]) continue;
          const nextGlob = [...(list[index].glob ?? [])];
          if (action === "Delete") {
            nextGlob.splice(patternIndex, 1);
          } else {
            const value = await promptRequiredInput(ctx, "New pattern");
            if (!value) continue;
            nextGlob[patternIndex] = value;
          }
          list[index] = { ...list[index], glob: nextGlob };
          writeCommandList(orchestrator, scope, "afterEdit", list);
        }
        continue;
      }
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const list = getEditableCommandList(orchestrator, scope, "afterEdit") as AfterEditCommand[];
      if (!list[index]) continue;
      list.splice(index, 1);
      writeCommandList(orchestrator, scope, "afterEdit", list);
      break;
    }
  }
}

async function showAfterImplementCommands(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const commands = orchestrator.config.commands.afterImplement;
    const info = getConfigSourceInfo(orchestrator, ["commands", "afterImplement"]);
    const options: OptionInput[] = [];
    const byTitle = new Map<string, number>();
    const usedTitles = new Set<string>();
    commands.forEach((cmd, index) => {
      const title = makeUniqueTitle(slugify(cmd.run, 56), usedTitles);
      options.push(opt(title, cmd.run));
      byTitle.set(title, index);
    });
    options.push(opt("New command", "Add command"));
    options.push(...buildResetOptions(orchestrator, ["commands", "afterImplement"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `After implementation: ${commands.length} commands ${formatSourceTags(commands, info)}`.trim(), options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New command") {
      const run = await promptRequiredInput(ctx, "Command to run");
      if (!run) continue;
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const list = getEditableCommandList(orchestrator, scope, "afterImplement") as AfterImplementCommand[];
      list.push({ run });
      writeCommandList(orchestrator, scope, "afterImplement", list);
      continue;
    }
    if (maybeHandleResetChoice(orchestrator, choice, ["commands", "afterImplement"])) continue;
    const index = byTitle.get(choice);
    if (index === undefined) continue;
    while (true) {
      const command = orchestrator.config.commands.afterImplement[index];
      if (!command) break;
      const commandChoice = await selectOption(ctx, slugify(command.run, 70), [
        opt("Command", "View or edit command string"),
        opt("Delete command", "Remove this command"),
        opt("Back", "Return to previous menu"),
      ]);
      if (!commandChoice || commandChoice === "Back") break;
      if (commandChoice === "Command") {
        const action = await selectOption(ctx, "Command", [
          opt("View", command.run),
          opt("Edit", "Edit command string"),
          opt("Back", "Return to previous menu"),
        ]);
        if (action === "View") {
          ctx.ui.notify(command.run, "info");
          continue;
        }
        if (action === "Edit") {
          const run = await promptRequiredInput(ctx, "New command string");
          if (!run) continue;
          const scope = await pickScope(ctx, orchestrator);
          if (!scope) continue;
          const list = getEditableCommandList(orchestrator, scope, "afterImplement") as AfterImplementCommand[];
          if (!list[index]) continue;
          list[index] = { run };
          writeCommandList(orchestrator, scope, "afterImplement", list);
        }
        continue;
      }
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const list = getEditableCommandList(orchestrator, scope, "afterImplement") as AfterImplementCommand[];
      if (!list[index]) continue;
      list.splice(index, 1);
      writeCommandList(orchestrator, scope, "afterImplement", list);
      break;
    }
  }
}

async function showCommandsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const afterEditInfo = getConfigSourceInfo(orchestrator, ["commands", "afterEdit"]);
    const afterImplementInfo = getConfigSourceInfo(orchestrator, ["commands", "afterImplement"]);
    const choice = await selectOption(ctx, "Commands", [
      opt(
        `After file edit: ${orchestrator.config.commands.afterEdit.length} commands ${formatSourceTags(orchestrator.config.commands.afterEdit, afterEditInfo)}`.trim(),
        `${orchestrator.config.commands.afterEdit.length} commands`,
      ),
      opt(
        `After implementation: ${orchestrator.config.commands.afterImplement.length} commands ${formatSourceTags(orchestrator.config.commands.afterImplement, afterImplementInfo)}`.trim(),
        `${orchestrator.config.commands.afterImplement.length} commands`,
      ),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("After file edit:")) {
      await showAfterEditCommands(orchestrator, ctx);
      continue;
    }
    await showAfterImplementCommands(orchestrator, ctx);
  }
}

async function showTimeoutsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const timeoutKeys = Object.keys(orchestrator.config.timeouts) as TimeoutKey[];
    const options: OptionInput[] = timeoutKeys.map((key) => {
      const value = orchestrator.config.timeouts[key];
      const info = getConfigSourceInfo(orchestrator, ["timeouts", key]);
      return opt(`${TIMEOUT_LABELS[key]}: ${withTags(formatDuration(value), formatSourceTags(value, info))}`, "Edit timeout");
    });
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Timeouts", options);
    if (!choice || choice === "Back") return BACK;
    const key = timeoutKeys.find((item) => choice.startsWith(`${TIMEOUT_LABELS[item]}:`));
    if (!key) continue;
    while (true) {
      const value = orchestrator.config.timeouts[key];
      const action = await selectOption(ctx, `${TIMEOUT_LABELS[key]}: ${formatDuration(value)}`, [
        opt("Edit", "Set timeout value"),
        ...buildResetOptions(orchestrator, ["timeouts", key]),
        opt("Back", "Return to the previous menu"),
      ]);
      if (!action || action === "Back") break;
      if (action === "Edit") {
        const input = await promptRequiredInput(ctx, "New value (e.g. 30s, 5m, 1h, or raw milliseconds)");
        if (!input) continue;
        const parsed = parseDuration(input);
        if (parsed === null) {
          ctx.ui.notify("Invalid duration format.", "warning");
          continue;
        }
        applyScopeChoice(orchestrator, ["timeouts", key], parsed, await pickScope(ctx, orchestrator));
        continue;
      }
      maybeHandleResetChoice(orchestrator, action, ["timeouts", key]);
    }
  }
}

async function showPerformanceSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "Performance", [
      opt("Timeouts", "Timeout configuration"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    await showTimeoutsSettings(orchestrator, ctx);
  }
}

async function showBooleanSetting(
  orchestrator: Orchestrator,
  ctx: any,
  title: string,
  keyPath: string[],
): Promise<void> {
  while (true) {
    const info = getConfigSourceInfo(orchestrator, keyPath);
    const yesTitle = withTags("Yes", formatSourceTags(true, info));
    const noTitle = withTags("No", formatSourceTags(false, info));
    const choice = await selectOption(ctx, title, [
      yesTitle,
      noTitle,
      ...buildResetOptions(orchestrator, keyPath),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return;
    if (choice === yesTitle) {
      applyScopeChoice(orchestrator, keyPath, true, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === noTitle) {
      applyScopeChoice(orchestrator, keyPath, false, await pickScope(ctx, orchestrator));
      continue;
    }
    maybeHandleResetChoice(orchestrator, choice, keyPath);
  }
}

async function showLogLevelSetting(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const levels: Array<{ value: PiPiConfig["logLevel"]; label: string }> = [
    { value: "debug", label: "Debug" },
    { value: "info", label: "Info" },
    { value: "warn", label: "Warning" },
    { value: "error", label: "Error" },
  ];
  while (true) {
    const info = getConfigSourceInfo(orchestrator, ["logLevel"]);
    const options: OptionInput[] = levels.map((entry) => withTags(entry.label, formatSourceTags(entry.value, info)));
    options.push(...buildResetOptions(orchestrator, ["logLevel"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Log level", options);
    if (!choice || choice === "Back") return;
    const picked = levels.find((entry) => choice.startsWith(entry.label));
    if (picked) {
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      applyConfigChange(orchestrator, scope, ["logLevel"], picked.value);
      setLogLevel(orchestrator.config.logLevel);
      continue;
    }
    maybeHandleResetChoice(orchestrator, choice, ["logLevel"]);
    setLogLevel(orchestrator.config.logLevel);
  }
}

async function showGeneralSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const autoInfo = getConfigSourceInfo(orchestrator, ["autoCommit"]);
    const ignoreInfo = getConfigSourceInfo(orchestrator, ["ignoreExtraRepoConfigs"]);
    const logInfo = getConfigSourceInfo(orchestrator, ["logLevel"]);
    const choice = await selectOption(ctx, "General", [
      opt(`Commit automatically: ${withTags(orchestrator.config.autoCommit ? "Yes" : "No", formatSourceTags(orchestrator.config.autoCommit, autoInfo))}`, "Enable or disable auto commits"),
      opt(`Ignore configs from other repos: ${withTags(orchestrator.config.ignoreExtraRepoConfigs ? "Yes" : "No", formatSourceTags(orchestrator.config.ignoreExtraRepoConfigs, ignoreInfo))}`, "Load only root repo config"),
      opt(`Log level: ${withTags(logLevelLabel(orchestrator.config.logLevel), formatSourceTags(orchestrator.config.logLevel, logInfo))}`, "Logging verbosity"),
      opt("Flant AI Infrastructure", "Configure corporate AI model provider"),
      opt("Repos", "Registered repositories and base branches"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Commit automatically:")) {
      await showBooleanSetting(orchestrator, ctx, "Commit automatically", ["autoCommit"]);
      continue;
    }
    if (choice.startsWith("Ignore configs from other repos:")) {
      await showBooleanSetting(orchestrator, ctx, "Ignore configs from other repos", ["ignoreExtraRepoConfigs"]);
      continue;
    }
    if (choice.startsWith("Log level:")) {
      await showLogLevelSetting(orchestrator, ctx);
      continue;
    }
    if (choice === "Flant AI Infrastructure") {
      await showFlantInfraMenu(orchestrator, ctx);
      continue;
    }
    await showReposSettings(orchestrator, ctx);
  }
}

async function showAgentsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "Agents", [
      opt("Orchestrators", "Orchestrator and subagent configuration"),
      opt("Subagents", "Simple subagents and preset groups"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Orchestrators") {
      await showOrchestratorsSettings(orchestrator, ctx);
      continue;
    }
    await showSubagentSettings(orchestrator, ctx);
  }
}

async function showReposSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    if (!orchestrator.active) {
      ctx.ui.notify("No active task. Start a task first.", "info");
      return BACK;
    }

    const repos = orchestrator.active.state.repos ?? [];
    if (repos.length === 0) {
      ctx.ui.notify("No repos registered yet. The agent will register repos when it starts working.", "info");
      return BACK;
    }

    const options: OptionInput[] = repos.map((repo) => ({
      title: repo.path,
      description: `base: ${repo.baseBranch ?? "(not set)"}${repo.isRoot ? " (root)" : ""}`,
    }));
    options.push(opt("Back", "Return to Settings"));

    const choice = await selectOption(ctx, "Repos", options);
    if (!choice || choice === "Back") return BACK;

    const repo = repos.find((item) => item.path === choice);
    if (!repo) continue;

    const repoOptions: OptionInput[] = [
      opt("Change base branch", `currently: ${repo.baseBranch ?? "(not set)"}`),
      opt("Back", "Return to repo list"),
    ];
    const repoChoice = await selectOption(ctx, `${repo.path}${repo.isRoot ? " (root)" : ""}`, repoOptions);
    if (!repoChoice || repoChoice === "Back") continue;

    if (repoChoice === "Change base branch") {
      const value = await ctx.ui.input("Base branch (e.g. origin/main):");
      if (value === undefined || value === null) continue;
      repo.baseBranch = String(value).trim() || undefined;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      unregisterAgentDefinitions(orchestrator.pi);
      orchestrator.registerAgents();
      ctx.ui.notify(`Base branch set to: ${repo.baseBranch ?? "(cleared)"}`, "info");
    }
  }
}

async function showSettingsMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = [
      opt("General", "Commit, log level, Flant AI, repos"),
      opt("Agents", "Orchestrator and subagent configuration"),
      opt("Commands", "After file edit and after implementation"),
      opt("Performance", "Timeout configuration"),
      opt("Back", "Return to the previous menu"),
    ];

    const choice = await selectOption(ctx, "Settings", options);
    if (!choice || choice === "Back") return BACK;

    if (choice === "General") await showGeneralSettings(orchestrator, ctx);
    else if (choice === "Agents") await showAgentsSettings(orchestrator, ctx);
    else if (choice === "Commands") await showCommandsSettings(orchestrator, ctx);
    else if (choice === "Performance") await showPerformanceSettings(orchestrator, ctx);
  }
}

function autonomousPhasesForTask(type: TaskType, includeFirstPhase: boolean): string[] {
  if (type === "implement") return includeFirstPhase ? ["brainstorm", "plan", "implement"] : ["plan", "implement"];
  if (type === "debug") return includeFirstPhase ? ["debug", "plan", "implement"] : ["plan", "implement"];
  if (type === "review") return includeFirstPhase ? ["review", "plan", "implement"] : ["plan", "implement"];
  return [];
}

function defaultAutonomousReviewPreset(type: TaskType, phase: string): string {
  if (type === "review" && phase === "review") return "deep";
  return "regular";
}

function buildDefaultAutonomousConfig(type: TaskType, includeFirstPhase: boolean): AutonomousConfig {
  const phases = autonomousPhasesForTask(type, includeFirstPhase);
  const out: AutonomousConfig = { phases: {} };
  for (const phase of phases) {
    out.phases[phase] = {
      reviewPreset: defaultAutonomousReviewPreset(type, phase),
      maxReviewPasses: 3,
      ...(phase === "plan" ? { plannerPreset: "regular" } : {}),
    };
  }
  return out;
}

async function showTaskModePicker(ctx: any): Promise<TaskMode | "back"> {
  const mode = await selectOption(ctx, "Mode", [
    opt("Guided", "User gates at every phase transition"),
    opt("Autonomous", "Full pipeline with automatic phase transitions"),
    opt("Back", "Return to the previous menu"),
  ]);
  if (!mode || mode === "Back") return "back";
  return mode === "Autonomous" ? "autonomous" : "guided";
}

async function pickMaxReviewPasses(ctx: any, current: number): Promise<number | null> {
  const currentLabel = current >= 999 ? "No limit" : String(current);
  while (true) {
    const choice = await selectOption(ctx, `Max review passes (${currentLabel})`, [
      opt("1", "Single pass"),
      opt("3", "Default"),
      opt("5", "Extended"),
      opt("No limit", "Allow as many passes as needed"),
      opt("Custom...", "Enter a custom positive integer"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return null;
    if (choice === "1") return 1;
    if (choice === "3") return 3;
    if (choice === "5") return 5;
    if (choice === "No limit") return 999;

    const input = await ctx.ui.input("Enter max review passes (positive integer)");
    if (input === undefined || input === null) continue;
    const parsed = Number.parseInt(String(input).trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.ui.notify("Please enter a positive integer.", "warning");
      continue;
    }
    return parsed;
  }
}

async function showAutonomousPhaseSettings(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  phase: string,
  config: AutonomousConfig,
): Promise<void> {
  const phaseConfig = config.phases[phase] ?? {
    reviewPreset: defaultAutonomousReviewPreset(type, phase),
    maxReviewPasses: 3,
    ...(phase === "plan" ? { plannerPreset: "regular" } : {}),
  };
  config.phases[phase] = phaseConfig;

  while (true) {
    const reviewPreset = phaseConfig.reviewPreset ?? defaultAutonomousReviewPreset(type, phase);
    const maxReview = phaseConfig.maxReviewPasses >= 999 ? "No limit" : String(phaseConfig.maxReviewPasses);
    const options: OptionInput[] = [
      opt(`Review preset: ${reviewPreset}`, "Select review preset"),
    ];
    if (phase === "plan") {
      options.push(opt(`Planner preset: ${phaseConfig.plannerPreset ?? "regular"}`, "Select planner preset"));
    }
    options.push(opt(`Max review passes: ${maxReview}`, "Safety cap for autonomous review loops"));
    options.push(opt("Back", "Return to autonomous settings"));

    const choice = await selectOption(ctx, `${phase.charAt(0).toUpperCase()}${phase.slice(1)} phase`, options);
    if (!choice || choice === "Back") return;

    if (choice.startsWith("Review preset:")) {
      const group = getReviewPresetGroup(phase);
      const picked = await pickPreset(ctx, orchestrator, group, "Review preset");
      if (picked) phaseConfig.reviewPreset = picked;
      continue;
    }

    if (choice.startsWith("Planner preset:")) {
      const picked = await pickPreset(ctx, orchestrator, "planners", "Planner preset");
      if (picked) phaseConfig.plannerPreset = picked;
      continue;
    }

    const pickedMax = await pickMaxReviewPasses(ctx, phaseConfig.maxReviewPasses);
    if (pickedMax !== null) phaseConfig.maxReviewPasses = pickedMax;
  }
}

async function showAutonomousSettings(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  includeFirstPhase: boolean,
): Promise<AutonomousConfig | null> {
  const config = buildDefaultAutonomousConfig(type, includeFirstPhase);
  const phases = autonomousPhasesForTask(type, includeFirstPhase);

  while (true) {
    const options: OptionInput[] = [
      opt("Start", "Begin with current autonomous settings"),
      ...phases.map((phase) => opt(`${phase.charAt(0).toUpperCase()}${phase.slice(1)} phase`, "Configure presets and review passes")),
      opt("Back", "Return to mode selection"),
    ];
    const choice = await selectOption(ctx, "Autonomous", options);
    if (!choice || choice === "Back") return null;
    if (choice === "Start") return config;

    const phase = choice.replace(/ phase$/, "").toLowerCase();
    if (!phases.includes(phase)) continue;
    await showAutonomousPhaseSettings(orchestrator, ctx, type, phase, config);
  }
}

async function pickModeForTaskStart(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  includeFirstPhase: boolean,
): Promise<{ mode: TaskMode; autonomousConfig?: AutonomousConfig } | null> {
  while (true) {
    const mode = await showTaskModePicker(ctx);
    if (mode === "back") return null;
    if (mode === "guided") return { mode: "guided" };
    const autonomousConfig = await showAutonomousSettings(orchestrator, ctx, type, includeFirstPhase);
    if (!autonomousConfig) continue;
    return { mode: "autonomous", autonomousConfig };
  }
}

function resumeOptionTitle(t: TaskInfo): string {
  return taskName(t.dir);
}

function resumeOptionDescription(t: TaskInfo): string {
  const age = taskAge(t.state);
  const phase = t.state.phase === t.type ? t.type : `${t.type}/${t.state.phase}`;
  return `${phase}, ${age}`;
}

async function showResumeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType | undefined,
  emptyMessage: string,
): Promise<typeof BACK | "started"> {
  while (true) {
    const tasks = listTasks(orchestrator.cwd, type);
    if (tasks.length === 0) {
      ctx.ui.notify(emptyMessage, "info");
      return BACK;
    }

    const options: OptionInput[] = tasks.map((t) => ({
      title: resumeOptionTitle(t),
      description: resumeOptionDescription(t),
    }));
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Resume", options);
    if (!choice || choice === "Back") return BACK;

    const task = tasks.find((t) => resumeOptionTitle(t) === choice);
    if (!task) continue;
    const result = await resumeTask(orchestrator, ctx, task);
    if (result.ok) return "started";
  }
}

function fromOptionTitle(t: TaskInfo): string {
  return taskName(t.dir);
}

function fromOptionDescription(t: TaskInfo, cwd: string): string {
  const age = taskAge(t.state);
  const rel = relative(join(cwd, ".pp", "state"), t.dir);
  return `${t.type}, ${age} — ${rel}`;
}

async function showFromMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const tasks = listCompletedFromTasks(orchestrator.cwd);
    if (tasks.length === 0) {
      ctx.ui.notify("No completed brainstorm/debug/review tasks with artifacts found.", "info");
      return BACK;
    }

    const options: OptionInput[] = tasks.map((t) => ({
      title: fromOptionTitle(t),
      description: fromOptionDescription(t, orchestrator.cwd),
    }));
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "From", options);
    if (!choice || choice === "Back") return BACK;

    const selected = tasks.find((t) => fromOptionTitle(t) === choice);
    if (!selected) continue;

    const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement", false);
    if (!modeSelection) continue;
    await orchestrator.startTask(ctx, "implement", "implement", selected.dir, true, modeSelection.mode);
    if (orchestrator.active) {
      orchestrator.active.state.autonomousConfig = modeSelection.autonomousConfig;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    return "started";
  }
}

async function showImplementMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Implement", [
      { title: "New", description: "Start a new implementation from scratch" },
      { title: "From", description: "Continue from a completed brainstorm or debug task" },
      { title: "Resume", description: "Resume a paused implementation" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement", true);
      if (!modeSelection) continue;
      await orchestrator.startTask(ctx, "implement", "implement", undefined, undefined, modeSelection.mode);
      if (orchestrator.active) {
        orchestrator.active.state.autonomousConfig = modeSelection.autonomousConfig;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
      return "started";
    }

    if (choice === "From") {
      const result = await showFromMenu(orchestrator, ctx);
      if (result === "started") return result;
      continue;
    }

    const result = await showResumeMenu(orchestrator, ctx, "implement", "No paused implement tasks found.");
    if (result === "started") return result;
  }
}

function buildPrContext(parsed: any): { prUrl: string | null; prContext: string | null } {
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : "";
  const commentsRaw = Array.isArray(parsed?.comments)
    ? parsed.comments
    : Array.isArray(parsed?.comments?.nodes)
    ? parsed.comments.nodes
    : [];
  const comments: string[] = commentsRaw
    .map((comment: any) => {
      const text = typeof comment?.body === "string"
        ? comment.body.trim()
        : typeof comment?.bodyText === "string"
        ? comment.bodyText.trim()
        : "";
      return text;
    })
    .filter((text: string): text is string => text.length > 0);

  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (body) parts.push(`Body:\n${body}`);
  if (comments.length > 0) {
    parts.push(`Comments:\n${comments.map((comment, index) => `${index + 1}. ${comment}`).join("\n\n")}`);
  }

  const prUrl = typeof parsed?.url === "string" && parsed.url.trim().length > 0 ? parsed.url.trim() : null;
  return { prUrl, prContext: parts.length > 0 ? parts.join("\n\n") : null };
}

async function detectCurrentPrContext(orchestrator: Orchestrator, repos: RepoInfo[]): Promise<RepoPrContext[]> {
  const results: RepoPrContext[] = [];
  for (const repo of repos) {
    try {
      const prResult = await orchestrator.pi.exec("gh", ["pr", "view", "--json", "url,title,body,comments"], {
        cwd: repo.path,
        timeout: 10000,
      });
      if (prResult.code !== 0) continue;
      const parsed = JSON.parse(prResult.stdout);
      const pr = buildPrContext(parsed);
      if (pr.prUrl || pr.prContext) {
        results.push({ repoPath: repo.path, prUrl: pr.prUrl, prContext: pr.prContext });
      }
    } catch {}
  }
  return results;
}

async function openCodeReviewInPlannotator(
  orchestrator: Orchestrator,
  payload: { cwd: string; diffType?: string; defaultBranch?: string },
): Promise<{ status: "approved" | "needs_changes" | "error"; feedback?: string; error?: string }> {
  const requestPayload: Record<string, unknown> = { cwd: payload.cwd };
  if (payload.diffType) requestPayload.diffType = payload.diffType;
  if (payload.defaultBranch) requestPayload.defaultBranch = payload.defaultBranch;

  return await new Promise((resolve) => {
    let handled = false;
    orchestrator.pi.events.emit("plannotator:request", {
      requestId: crypto.randomUUID(),
      action: "code-review",
      payload: requestPayload,
      respond: (response: any) => {
        handled = true;
        if (response?.status !== "handled") {
          resolve({ status: "error", error: response?.error || "Plannotator is not available." });
          return;
        }
        const approved = !!response?.result?.approved;
        const feedback = typeof response?.result?.feedback === "string" && response.result.feedback.trim().length > 0
          ? response.result.feedback
          : undefined;
        resolve({ status: approved ? "approved" : "needs_changes", feedback });
      },
    });
    setTimeout(() => {
      if (!handled) resolve({ status: "error", error: "Plannotator is not available." });
    }, 30000);
  });
}

async function startReviewTask(
  orchestrator: Orchestrator,
  ctx: any,
  userRequestContent: string,
  researchContent: string | null,
  description: string,
  mode?: TaskMode,
  autonomousConfig?: AutonomousConfig,
): Promise<"started" | typeof BACK> {
  await orchestrator.startTask(ctx, "review", description, undefined, undefined, mode);
  if (!orchestrator.active || orchestrator.active.type !== "review") return BACK;
  orchestrator.active.state.autonomousConfig = autonomousConfig;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  const repos = getRegisteredRepos(orchestrator);
  const userRequestWithRepos = appendRepoContext(userRequestContent, repos);
  writeFileSync(join(orchestrator.active.dir, "USER_REQUEST.md"), userRequestWithRepos, "utf-8");
  if (researchContent) {
    writeFileSync(join(orchestrator.active.dir, "RESEARCH.md"), researchContent, "utf-8");
  }
  return "started";
}

async function showReviewMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const options: OptionInput[] = [
      { title: "Current branch", description: "Review changes on current branch vs base" },
      { title: "Last commit", description: "Review changes in the most recent commit" },
      { title: "Since commit", description: "Review all changes since a specific commit" },
      { title: "Uncommitted changes", description: "Review working directory changes" },
      { title: "Describe", description: "Describe what to review and let the agent figure it out" },
      { title: "Resume", description: "Resume a previously unfinished review" },
      { title: "Back", description: "Return to the previous menu" },
    ];
    const choice = await selectOption(ctx, "Review", options);
    if (!choice || choice === "Back") return BACK;

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, "review", "No paused review tasks found.");
      if (result === "started") return result;
      continue;
    }

    if (choice === "Current branch") {
      const repos = getRegisteredRepos(orchestrator);
      const repoRanges = await Promise.all(
        repos.map(async (repo) => `- ${formatRepoLabel(repo)}: ${await detectDefaultBranch(orchestrator, repos, repo.path)}..HEAD`),
      );
      const prContexts = await detectCurrentPrContext(orchestrator, repos);

      const urLines = [
        "# User Request",
        "Review current branch changes across registered repositories.",
        "",
        "Diff ranges:",
        ...repoRanges,
      ];
      const prUrls = prContexts
        .filter((pr) => pr.prUrl)
        .map((pr) => `- ${pr.repoPath}: ${pr.prUrl}`);
      if (prUrls.length > 0) {
        urLines.push("", "Open PRs:", ...prUrls);
      }
      urLines.push("", "## Problem", "Review and identify issues in the code changes.", "", "## Constraints", "Focus on correctness, edge cases, style, missing tests, potential bugs.");
      const urContent = urLines.join("\n") + "\n";

      let resContent = [
        "## Affected Code",
        "(to be filled during review)",
        "",
        "## Architecture Context",
        "(to be filled during review)",
        "",
        "## Constraints & Edge Cases",
        "- MUST: Review all changed code across the registered repositories",
        "- RISK: Issues can span repository boundaries",
      ].join("\n") + "\n";
      if (prContexts.length > 0) {
        const prContextBlocks = prContexts
          .map((pr) => {
            const lines = [`${pr.repoPath}`];
            if (pr.prUrl) lines.push(`URL: ${pr.prUrl}`);
            if (pr.prContext) lines.push(pr.prContext);
            return lines.join("\n");
          })
          .join("\n\n");
        resContent = appendResearchOpenQuestions(resContent, `PR context:\n${prContextBlocks}`);
      }

      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review", true);
      if (!modeSelection) continue;
      const description = "review-current-branch";
      return startReviewTask(orchestrator, ctx, urContent, resContent, description, modeSelection.mode, modeSelection.autonomousConfig);
    }

    if (choice === "Last commit") {
      const repos = getRegisteredRepos(orchestrator);
      const urContent = [
        "# User Request",
        "Review last commit changes across registered repositories",
        "",
        "## Problem",
        "Review and identify issues in the most recent commit.",
        "",
        "## Constraints",
        "Focus on correctness, edge cases, style, missing tests, potential bugs.",
        "",
      ].join("\n");
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review", true);
      if (!modeSelection) continue;
      return startReviewTask(orchestrator, ctx, urContent, null, "review-last-commit", modeSelection.mode, modeSelection.autonomousConfig);
    }

    if (choice === "Since commit") {
      const repos = getRegisteredRepos(orchestrator);
      const repoOptions: OptionInput[] = repos.map((repo) => ({
        title: formatRepoLabel(repo),
        description: "Choose repository for commit range",
      }));
      repoOptions.push({ title: "Back", description: "Return to the previous menu" });
      const repoChoice = await selectOption(ctx, "Select repository", repoOptions);
      if (!repoChoice || repoChoice === "Back") continue;
      const selectedRepo = repos.find((repo) => formatRepoLabel(repo) === repoChoice);
      if (!selectedRepo) continue;
      const pickedHash = await pickCommitForRepo(orchestrator, ctx, selectedRepo);
      if (!pickedHash) continue;

      const urContent = [
        "# User Request",
        `Review changes in ${selectedRepo.path} since commit ${pickedHash}`,
        "",
        "## Problem",
        `Review and identify issues in all changes in ${selectedRepo.path} since ${pickedHash}.`,
        "",
        "## Constraints",
        "Focus on correctness, edge cases, style, missing tests, potential bugs.",
        "",
      ].join("\n");
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review", true);
      if (!modeSelection) continue;
      return startReviewTask(orchestrator, ctx, urContent, null, "review-since-commit", modeSelection.mode, modeSelection.autonomousConfig);
    }

    if (choice === "Uncommitted changes") {
      const repos = getRegisteredRepos(orchestrator);
      const urContent = [
        "# User Request",
        "Review uncommitted changes across registered repositories",
        "",
        "## Problem",
        "Review and identify issues in uncommitted working directory changes.",
        "",
        "## Constraints",
        "Focus on correctness, edge cases, style, missing tests, potential bugs.",
        "",
      ].join("\n");
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review", true);
      if (!modeSelection) continue;
      return startReviewTask(orchestrator, ctx, urContent, null, "review-uncommitted", modeSelection.mode, modeSelection.autonomousConfig);
    }

    const input = await ctx.ui.input("Describe what to review");
    if (input === undefined || input === null) continue;
    const trimmed = String(input).trim();
    const description = trimmed || "review";

    const urContent = `# User Request\n${description}\n\n## Problem\n${description}\n\n## Constraints\nFocus on correctness, edge cases, style, missing tests, potential bugs.\n`;
    const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review", true);
    if (!modeSelection) continue;
    return startReviewTask(orchestrator, ctx, urContent, null, description, modeSelection.mode, modeSelection.autonomousConfig);
  }
}

async function showTaskTypeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, type.charAt(0).toUpperCase() + type.slice(1), [
      { title: "New", description: "Start a new session" },
      { title: "Resume", description: "Resume a paused session" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      let mode: TaskMode | undefined;
      let autonomousConfig: AutonomousConfig | undefined;
      if (type === "debug") {
        const modeSelection = await pickModeForTaskStart(orchestrator, ctx, type, true);
        if (!modeSelection) continue;
        mode = modeSelection.mode;
        autonomousConfig = modeSelection.autonomousConfig;
      }
      await orchestrator.startTask(ctx, type, type, undefined, undefined, mode);
      if (orchestrator.active) {
        orchestrator.active.state.autonomousConfig = autonomousConfig;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
      return "started";
    }

    const result = await showResumeMenu(orchestrator, ctx, type, `No paused ${type} tasks found.`);
    if (result === "started") return result;
  }
}

async function showTaskMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Task", [
      { title: "Implement", description: "Want to make some changes? Research any topic or a codebase, brainstorm solutions and implement the chosen one" },
      { title: "Debug", description: "Something is broken? Investigate it. If there is an issue — brainstorm solutions and fix it" },
      { title: "Brainstorm", description: "No idea where to start? Research any topic or a codebase. If there is a problem to solve — brainstorm solutions and solve it" },
      { title: "Review", description: "Want to ensure that some commits or a GitHub PR are good to go? Review it. Even fix it yourself, if you want" },
      { title: "Quick", description: "Quick freeform task — no phases, no reviews, just work" },
      { title: "Resume", description: "Resume a previously unfinished task" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "Debug") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "debug");
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Brainstorm") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "brainstorm");
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Implement") {
      const result = await showImplementMenu(orchestrator, ctx);
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Review") {
      const result = await showReviewMenu(orchestrator, ctx);
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Quick") {
      await orchestrator.startTask(ctx, "quick", "quick");
      return "started";
    }

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, undefined, "No paused tasks found.");
      if (result === "started") return "started";
      continue;
    }
  }
}

async function showNoActiveMenu(orchestrator: Orchestrator, ctx: any): Promise<string | undefined> {
  while (true) {
    const choice = await selectOption(ctx, "/pp", [
      { title: "Task", description: "Start a new task or resume a paused one" },
      { title: "Info", description: "Subagents, LSP, usage, and task status" },
      { title: "Settings", description: "Flant AI and other configuration" },
      { title: "Back", description: "Close this menu" },
    ]);
    if (!choice || choice === "Back") return undefined;

    if (choice === "Task") {
      const result = await showTaskMenu(orchestrator, ctx);
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Info") {
      await showInfoMenu(orchestrator, ctx);
      continue;
    }

    await showSettingsMenu(orchestrator, ctx);
  }
}

function getReviewLabels(orchestrator: Orchestrator): { autoLabel: string } {
  const byKind = orchestrator.active?.state.reviewPassByKind ?? {};
  const autoCount = byKind["auto"] ?? 0;
  const autoLabel = autoCount > 0 ? `Auto review (pass ${autoCount + 1})` : "Auto review";
  return { autoLabel };
}

function hasEnabledReviewers(orchestrator: Orchestrator, presetName?: string): boolean {
  if (!orchestrator.active) return false;
  const phase = orchestrator.active.state.phase;
  const group = getReviewPresetGroup(phase);
  const reviewers = resolvePreset(orchestrator.config, group, presetName);
  return Object.values(reviewers).some((v) => v.enabled);
}

function handleReviewResult(ctx: any, text: string): { continueLoop: boolean; text?: string } {
  if (text.includes("Choose another option.") || text === "Plannotator approved the plan. Choose next action.") {
    ctx.ui.notify(text, "info");
    return { continueLoop: true };
  }
  return { continueLoop: false, text };
}

async function showQuickTaskMenu(
  orchestrator: Orchestrator,
  ctx: any,
  summary: string,
  mode: MenuMode,
): Promise<string> {
  while (true) {
    if (!orchestrator.active) return "No active task.";
    const task = orchestrator.active;
    const headerLines = [`/pp\n\nTask: ${task.type}\nPhase: ${task.state.phase}`];
    if (summary !== "/pp") headerLines.push(`\n\n${summary}`);
    const menuTitle = headerLines.join("");

    const choice = await selectOption(ctx, menuTitle, [
      opt("Complete", "Mark task as done and clean up"),
      opt("Pause", "Suspend task to resume later"),
      opt("Info", "Subagents, LSP, usage, and task status"),
      opt("Settings", "Flant AI and other configuration"),
      opt("Back", "Return to the prompt and keep working"),
    ]);
    if (!choice || choice === "Back") return "";
    if (choice === "Info") {
      await showInfoMenu(orchestrator, ctx);
      continue;
    }
    if (choice === "Settings") {
      await showSettingsMenu(orchestrator, ctx);
      continue;
    }
    if (choice === "Pause") {
      const text = await pauseTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }
    const text = await finishTask(orchestrator, ctx);
    return mode === "tool" ? text : "";
  }
}

export async function showActiveTaskMenu(
  orchestrator: Orchestrator,
  ctx: any,
  summary: string,
  mode: MenuMode = "command",
): Promise<string> {
  const continueMessage = "User wants to continue. Run /pp when ready to advance.";

  while (true) {
    if (!orchestrator.active) return "No active task.";

    const task = orchestrator.active;
    if (task.type === "quick") {
      return showQuickTaskMenu(orchestrator, ctx, summary, mode);
    }
    const phase = task.state.phase;
    const step = task.state.step;
    const effectiveMode = getEffectiveMode(task.state);

    const waiting = step === "await_planners" || step === "await_reviewers";
    const { autoLabel } = getReviewLabels(orchestrator);
    const isReviewPhase = phase === "review";
    const hasPlannotator = phase === "plan" || phase === "implement" || isReviewPhase;

    const opt = (title: string, description: string): OptionInput => ({ title, description });

    if (effectiveMode === "autonomous") {
      const autoChoice = await selectOption(ctx, `/pp\n\nTask: ${task.type}\nPhase: ${phase}${summary !== "/pp" ? `\n\n${summary}` : ""}`, [
        opt("Switch to Guided", "Return to gated phase transitions"),
        opt("Stop task", "Suspend task to resume later"),
        opt("Info", "Subagents, LSP, usage, and task status"),
        opt("Settings", "Flant AI and other configuration"),
        opt("Back", "Return to the prompt and keep working"),
      ]);
      if (!autoChoice || autoChoice === "Back") return "";
      if (autoChoice === "Info") {
        await showInfoMenu(orchestrator, ctx);
        continue;
      }
      if (autoChoice === "Settings") {
        await showSettingsMenu(orchestrator, ctx);
        continue;
      }
      if (autoChoice === "Switch to Guided") {
        task.state.effectiveMode = "guided";
        saveTask(task.dir, task.state);
        continue;
      }
      const text = await pauseTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }

    const options: OptionInput[] = [];
    options.push(opt("Next", "Complete, pause, or continue to next phase"));
    if (!waiting) {
      options.push(opt("Review", "Auto review, Plannotator, or manual review"));
    }
    if (task.state.autonomousConfig) {
      options.push(opt("Switch to Autonomous", "Run with automatic phase transitions"));
    }
    options.push(opt("Info", "Subagents, LSP, usage, and task status"));
    options.push(opt("Settings", "Flant AI and other configuration"));
    options.push(opt("Back", "Return to the prompt and keep working"));

    const headerLines = [`/pp\n\nTask: ${task.type}\nPhase: ${phase}`];
    if (summary !== "/pp") headerLines.push(`\n\n${summary}`);
    const menuTitle = headerLines.join("");
    const choice = await selectOption(ctx, menuTitle, options);
    if (!choice || choice === "Back") {
      return "";
    }

    if (choice === "Info") {
      await showInfoMenu(orchestrator, ctx);
      continue;
    }
    if (choice === "Settings") {
      await showSettingsMenu(orchestrator, ctx);
      continue;
    }
    if (choice === "Switch to Autonomous") {
      task.state.effectiveMode = "autonomous";
      saveTask(task.dir, task.state);
      continue;
    }

    if (mode === "command") {
      await abortCurrentWork(orchestrator, ctx);
    }

    if (choice === "Next") {
      const canContinue = phase !== "implement" && !waiting;
      const continueLabel = phase === "plan" ? "Continue to implement" : "Continue to plan & implement";
      const finishOptions: OptionInput[] = [];
      if (canContinue) {
        finishOptions.push(opt(continueLabel, "Approve and advance to the next phase"));
      }
      finishOptions.push(opt("Complete", "Mark task as done and clean up"));
      finishOptions.push(opt("Pause", "Suspend task to resume later"));
      finishOptions.push(opt("Back", "Return to the previous menu"));

      const finishChoice = await selectOption(ctx, "Next", finishOptions);
      if (!finishChoice || finishChoice === "Back") continue;
      if (finishChoice === "Pause") {
        const text = await pauseTask(orchestrator, ctx);
        return mode === "tool" ? text : "";
      }
      if (finishChoice === "Complete") {
        const text = await finishTask(orchestrator, ctx);
        return mode === "tool" ? text : "";
      }
      const next = nextPhase(task.type, phase);

      if (
        next === "plan" &&
        task.type === "brainstorm"
      ) {
        const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement", false);
        if (!modeSelection) continue;
        task.state.mode = modeSelection.mode;
        task.state.effectiveMode = undefined;
        task.state.autonomousConfig = modeSelection.autonomousConfig;
        saveTask(task.dir, task.state);
      }

      let plannerPreset: string | undefined;
      if (next === "plan") {
        if (getEffectiveMode(task.state) !== "autonomous") {
          const pickedPlannerPreset = await pickPreset(ctx, orchestrator, "planners", "Planner preset");
          if (!pickedPlannerPreset) continue;
          plannerPreset = pickedPlannerPreset;
        }
      }
      finalizeReviewCycle(task);
      const result = await orchestrator.transitionToNextPhase(ctx, plannerPreset);
      if (!result.ok) return `Transition blocked: ${result.error}`;
      if (orchestrator.phaseCompactionPending || orchestrator.taskDoneCompactionPending) return "";
      const curStep = orchestrator.active?.state.step;
      if (curStep === "await_planners" || curStep === "await_reviewers") return "";
      return "";
    }

    if (choice === "Review") {
      const reviewOptions: OptionInput[] = [
        opt(autoLabel, "Run automated review with configured reviewers"),
      ];
      if (hasPlannotator) {
        reviewOptions.push(opt("Review in Plannotator", phase === "plan" ? "Open plan review in browser" : "Open code diff review in browser"));
      }
      reviewOptions.push(opt("Review on my own", "Review manually, then continue"));
      reviewOptions.push(opt("Back", "Return to the previous menu"));

      const reviewChoice = await selectOption(ctx, "Review", reviewOptions);
      if (!reviewChoice || reviewChoice === "Back") continue;

      if (reviewChoice === "Review in Plannotator") {
        if (phase === "plan") {
          finalizeReviewCycle(task);
          const text = await enterReviewCycle(orchestrator, ctx, "plannotator");
          const curStep = orchestrator.active?.state.step;
          if (curStep === "await_reviewers") return "";
          const handled = handleReviewResult(ctx, text);
          if (handled.continueLoop) continue;
          return handled.text ?? text;
        }
        const repos = getRegisteredRepos(orchestrator);
        const summaries: string[] = [];
        let stopReviewing = false;

        for (const repo of repos) {
          if (stopReviewing) break;

          while (true) {
            const diffChoice = await selectOption(ctx, `Review: ${formatRepoLabel(repo)}`, [
              opt("All branch changes", "Committed changes vs base branch"),
              opt("Last commit", "Changes in the most recent commit"),
              opt("Since commit", "Review all changes since a specific commit"),
              opt("Uncommitted changes", "Working directory changes"),
              opt("Skip this repo", "Move to the next repository"),
              opt("Done (stop reviewing)", "Stop iterating repositories"),
            ]);

            if (!diffChoice || diffChoice === "Done (stop reviewing)") {
              stopReviewing = true;
              break;
            }
            if (diffChoice === "Skip this repo") {
              summaries.push(`${formatRepoLabel(repo)}: SKIPPED`);
              break;
            }

            let diffType: string | undefined;
            let defaultBranch: string | undefined;

            if (diffChoice === "All branch changes") {
              diffType = "branch";
              defaultBranch = await detectDefaultBranch(orchestrator, repos, repo.path);
            } else if (diffChoice === "Last commit") {
              diffType = "last-commit";
            } else if (diffChoice === "Since commit") {
              const pickedHash = await pickCommitForRepo(orchestrator, ctx, repo);
              if (!pickedHash) continue;
              diffType = "branch";
              defaultBranch = pickedHash;
            } else {
              diffType = "uncommitted";
            }

            const result = await openCodeReviewInPlannotator(orchestrator, {
              cwd: repo.path,
              diffType,
              defaultBranch,
            });
            if (result.status === "error") {
              summaries.push(`${formatRepoLabel(repo)}: ERROR${result.error ? ` — ${result.error}` : ""}`);
            } else if (result.status === "approved") {
              summaries.push(`${formatRepoLabel(repo)}: APPROVED`);
            } else {
              summaries.push(`${formatRepoLabel(repo)}: NEEDS_CHANGES${result.feedback ? `\nFeedback: ${result.feedback}` : ""}`);
            }
            break;
          }
        }

        if (summaries.length > 0) {
          ctx.ui.notify(`Plannotator review summary:\n\n${summaries.join("\n\n")}`, "info");
        } else {
          ctx.ui.notify("No repositories were reviewed in Plannotator.", "info");
        }
        continue;
      }

      if (reviewChoice === "Review on my own") {
        if (phase === "plan") {
          setStep(orchestrator, "synthesize");
        } else {
          setStep(orchestrator, "llm_work");
        }
        return continueMessage;
      }

      const reviewPreset = await pickPreset(ctx, orchestrator, getReviewPresetGroup(phase), "Review preset");
      if (!reviewPreset) continue;
      finalizeReviewCycle(task);
      if (!hasEnabledReviewers(orchestrator, reviewPreset)) {
        const label = phase === "brainstorm" ? "brainstorm" : phase === "plan" ? "plan" : "code";
        ctx.ui.notify(`No ${label} reviewers enabled.`, "info");
        continue;
      }
      const text = await enterReviewCycle(orchestrator, ctx, reviewPreset);
      const curStep = orchestrator.active?.state.step;
      if (curStep === "await_reviewers") return "";
      const handled = handleReviewResult(ctx, text);
      if (handled.continueLoop) continue;
      return handled.text ?? text;
    }
  }
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any, mode: MenuMode = "command"): Promise<string | undefined> {
  if (!orchestrator.active) {
    return showNoActiveMenu(orchestrator, ctx);
  }
  const text = await showActiveTaskMenu(orchestrator, ctx, "/pp", mode);
  return text || undefined;
}
