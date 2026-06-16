import { existsSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { askUser } from "../../3p/pi-ask-user/index.js";
import { unregisterAgentDefinitions } from "./agents/registry.js";
import { loadConfig, type PiPiConfig } from "./config.js";
import {
  loadBrainstormReviewOutputs,
  loadCodeReviewOutputs,
  loadPlanReviewOutputs,
} from "./context.js";
import { detectDefaultBranch, enterReviewCycle, finalizeReviewCycle } from "./event-handlers.js";
import { Orchestrator, deepReviewConfig } from "./orchestrator.js";
import { cancelPendingPlannotatorWait } from "./plannotator.js";
import { spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { spawnBrainstormReviewers } from "./phases/brainstorm.js";

import {
  listTasks,
  loadTask,
  lockTask,
  saveTask,
  taskAge,
  taskName,
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

  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.updateStatus(ctx);
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
  if (phase === "plan") return loadPlanReviewOutputs(taskDir);
  return loadCodeReviewOutputs(taskDir, pass);
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
    const enabledVariants = Object.entries(orchestrator.config.planners).filter(([, v]) => v.enabled);
    const planFiles = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
      : [];
    if (planFiles.length >= enabledVariants.length) {
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    } else {
      const completedVariants = new Set(planFiles.map((f) => f.replace(/^\d+_/, "").replace(/\.md$/, "")));
      const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));
      if (missingVariants.length > 0) {
        const missingConfig: Record<string, any> = {};
        for (const [name, cfg] of missingVariants) missingConfig[name] = cfg;
        const partialConfig = { ...orchestrator.config, planners: missingConfig };
        orchestrator.pendingSubagentSpawns = missingVariants.length;
        orchestrator.failedPlannerVariants = [];
        spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, partialConfig).then((result) => {
          orchestrator.failedPlannerVariants = result.failedVariants;
          if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
          for (const id of result.agentIds ?? []) {
            orchestrator.spawnedAgentIds.delete(id);
          }
          orchestrator.pendingSubagentSpawns = 0;
        }).catch((err: any) => {
          orchestrator.pendingSubagentSpawns = 0;
          console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
        });
      } else {
        orchestrator.active.state.step = "synthesize";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
    }
  }

  if (orchestrator.active.state.reviewCycle) {
    const cycle = orchestrator.active.state.reviewCycle;
    const reviewConfig = cycle.kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
    const phase = orchestrator.active.state.phase;
    const reviewers = phase === "brainstorm"
      ? reviewConfig.brainstormReviewers
      : phase === "plan"
      ? reviewConfig.planReviewers
      : reviewConfig.codeReviewers;
    const reviewerCount = Object.values(reviewers).filter((v) => v.enabled).length;

    if ((cycle.kind === "auto" || cycle.kind === "auto-deep") && (cycle.step === "spawn_reviewers" || cycle.step === "await_reviewers")) {
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
          const missingReviewerConfig: Record<string, any> = {};
          for (const [name, cfg] of missingVariants) missingReviewerConfig[name] = cfg;
          const partialConfig = phase === "brainstorm"
            ? { ...reviewConfig, brainstormReviewers: missingReviewerConfig }
            : phase === "plan"
            ? { ...reviewConfig, planReviewers: missingReviewerConfig }
            : { ...reviewConfig, codeReviewers: missingReviewerConfig };
          orchestrator.pendingSubagentSpawns = missingVariants.length;
          const spawnFn = phase === "brainstorm"
            ? () => spawnBrainstormReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig, cycle.pass)
            : phase === "plan"
            ? () => spawnPlanReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig)
            : () => spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig, cycle.pass);
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
            console.error(`[pi-pi] spawn reviewers failed: ${err.message}`);
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
    pi.sendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Read reviewer outputs and apply feedback.`);
  } else {
    pi.sendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Continue working.`);
  }

  return { ok: true };
}

function listCompletedFromTasks(cwd: string): TaskInfo[] {
  const paused = new Set<string>([
    ...listTasks(cwd, "brainstorm").map((t) => t.dir),
    ...listTasks(cwd, "debug").map((t) => t.dir),
  ]);
  const results: TaskInfo[] = [];

  for (const type of ["brainstorm", "debug"] as TaskType[]) {
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

  for (const [name, variant] of Object.entries(config.planners ?? {})) {
    if (variant.enabled) add(`planners.${name}`, variant.model);
  }
  for (const [name, variant] of Object.entries(config.planReviewers ?? {})) {
    if (variant.enabled) add(`planReviewers.${name}`, variant.model);
  }
  for (const [name, variant] of Object.entries(config.codeReviewers ?? {})) {
    if (variant.enabled) add(`codeReviewers.${name}`, variant.model);
  }
  for (const [name, variant] of Object.entries(config.brainstormReviewers ?? {})) {
    if (variant.enabled) add(`brainstormReviewers.${name}`, variant.model);
  }

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

function formatDuration(ms: number): string {
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
        getPerModelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number }>;
        getSubagentList(): Array<{ description: string; modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number; durationMs: number; toolUses: number }>;
      }
    | undefined;

  if (!tracker) {
    ctx.ui.notify("No usage data available.", "info");
    return;
  }

  const mainInput = tracker.getTotalInputTokens();
  const mainOutput = tracker.getTotalOutputTokens();
  const mainCacheRead = tracker.getTotalCacheReadTokens();
  const mainCacheWrite = tracker.getTotalCacheWriteTokens();
  const mainCost = tracker.getTotalCost();
  const models = tracker.getPerModelUsage();
  const subagents = tracker.getSubagentList();

  let saInput = 0, saOutput = 0, saCacheRead = 0, saCacheWrite = 0, saCost = 0;
  for (const sa of subagents) {
    saInput += sa.inputTokens;
    saOutput += sa.outputTokens;
    saCacheRead += sa.cacheReadTokens;
    saCacheWrite += sa.cacheWriteTokens;
    saCost += sa.cost;
  }

  const totalInput = mainInput + saInput;
  const totalOutput = mainOutput + saOutput;
  const totalCacheRead = mainCacheRead + saCacheRead;
  const totalCost = mainCost + saCost;
  const totalCacheRate = (totalCacheRead + totalInput) > 0
    ? totalCacheRead / (totalCacheRead + totalInput)
    : 0;

  const byModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
  for (const [modelId, usage] of Object.entries(models)) {
    byModel.set(modelId, {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, cost: 0,
    });
  }
  if (mainCost > 0 && Object.keys(models).length === 1) {
    const entry = byModel.values().next().value;
    if (entry) entry.cost = mainCost;
  }
  for (const sa of subagents) {
    const key = sa.modelId !== "unknown" ? sa.modelId : sa.description;
    const existing = byModel.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      existing.cost += sa.cost;
    } else {
      byModel.set(key, {
        input: sa.inputTokens, output: sa.outputTokens,
        cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens, cost: sa.cost,
      });
    }
  }

  const lines: string[] = ["Session usage (total):"];
  lines.push(`  Input: ${formatTokenCount(totalInput)} tokens`);
  lines.push(`  Output: ${formatTokenCount(totalOutput)} tokens`);
  if (totalCacheRead > 0) lines.push(`  Cache: ⚡${Math.round(totalCacheRate * 100)}% hit rate`);
  if (totalCost > 0) lines.push(`  Cost: $${totalCost.toFixed(3)}`);

  if (byModel.size > 0) {
    lines.push("");
    lines.push("By model:");
    for (const [modelId, m] of byModel) {
      const cr = (m.cacheRead + m.input) > 0 ? Math.round(m.cacheRead / (m.cacheRead + m.input) * 100) : 0;
      const parts = [`↑${formatTokenCount(m.input)}`, `↓${formatTokenCount(m.output)}`];
      if (cr > 0) parts.push(`⚡${cr}%`);
      if (m.cost > 0) parts.push(`$${m.cost.toFixed(3)}`);
      lines.push(`  ${modelId}: ${parts.join("  ")}`);
    }
  }

  lines.push("");
  lines.push("By agent:");
  const mainModelEntries = Object.entries(models);
  if (mainModelEntries.length > 0) {
    const mainParts = [`↑${formatTokenCount(mainInput)}`, `↓${formatTokenCount(mainOutput)}`];
    const mainCR = (mainCacheRead + mainInput) > 0 ? Math.round(mainCacheRead / (mainCacheRead + mainInput) * 100) : 0;
    if (mainCR > 0) mainParts.push(`⚡${mainCR}%`);
    if (mainCost > 0) mainParts.push(`$${mainCost.toFixed(3)}`);
    const mainModel = mainModelEntries.map(([id]) => id).join(", ");
    lines.push(`  Main (${mainModel}): ${mainParts.join("  ")}`);
  }
  for (const sa of subagents) {
    const saCR = (sa.cacheReadTokens + sa.inputTokens) > 0
      ? Math.round(sa.cacheReadTokens / (sa.cacheReadTokens + sa.inputTokens) * 100) : 0;
    const parts = [`↑${formatTokenCount(sa.inputTokens)}`, `↓${formatTokenCount(sa.outputTokens)}`];
    if (saCR > 0) parts.push(`⚡${saCR}%`);
    if (sa.cost > 0) parts.push(`$${sa.cost.toFixed(3)}`);
    if (sa.durationMs > 0) parts.push(formatDuration(sa.durationMs));
    if (sa.toolUses > 0) parts.push(`${sa.toolUses} tools`);
    lines.push(`  ${sa.description}: ${parts.join("  ")}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function showSettingsMenu(orchestrator: Orchestrator, ctx: any, showFlant = true): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = [
      { title: "Usage", description: "Show session token usage and cost breakdown" },
      { title: "LSP", description: "Language server status and controls" },
    ];
    if (showFlant) {
      options.push({ title: "Flant AI Infrastructure", description: "Configure corporate AI model provider" });
    }
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Settings", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Usage") {
      showUsage(ctx);
      continue;
    }
    if (choice === "LSP") {
      await showLspMenu(ctx);
      continue;
    }
    await showFlantInfraMenu(orchestrator, ctx);
  }
}

async function promptDescription(ctx: any, prompt: string, fallback: string): Promise<string | undefined> {
  const value = await ctx.ui.input(prompt);
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || fallback;
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
      ctx.ui.notify("No completed brainstorm/debug tasks with artifacts found.", "info");
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

    const description = await promptDescription(ctx, "Describe the task", "implement");
    if (!description) continue;

    await orchestrator.startTask(ctx, "implement", description, selected.dir, true);
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
      const description = await promptDescription(ctx, "Describe the task", "implement");
      if (!description) continue;
      await orchestrator.startTask(ctx, "implement", description);
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

async function detectCurrentPrContext(orchestrator: Orchestrator): Promise<{ prUrl: string | null; prContext: string | null }> {
  try {
    const prResult = await orchestrator.pi.exec("gh", ["pr", "view", "--json", "url,title,body,comments"], {
      cwd: orchestrator.cwd,
      timeout: 10000,
    });
    if (prResult.code !== 0) return { prUrl: null, prContext: null };
    const parsed = JSON.parse(prResult.stdout);
    return buildPrContext(parsed);
  } catch {
    return { prUrl: null, prContext: null };
  }
}

async function openReviewTaskInPlannotator(orchestrator: Orchestrator): Promise<string> {
  if (!orchestrator.active) return "No active task.";
  const payload: Record<string, unknown> = { cwd: orchestrator.cwd };

  return await new Promise((resolve) => {
    let handled = false;
    orchestrator.pi.events.emit("plannotator:request", {
      requestId: crypto.randomUUID(),
      action: "code-review",
      payload,
      respond: (response: any) => {
        handled = true;
        if (response?.status !== "handled") {
          resolve(`Plannotator is not available${response?.error ? `: ${response.error}` : "."}`);
          return;
        }
        const approved = !!response?.result?.approved;
        const feedback = typeof response?.result?.feedback === "string" && response.result.feedback.trim().length > 0
          ? `\n\nFeedback:\n${response.result.feedback}`
          : "";
        resolve(approved ? "Plannotator approved the review." : `Plannotator requested changes.${feedback}`);
      },
    });
    setTimeout(() => {
      if (!handled) resolve("Plannotator is not available.");
    }, 30000);
  });
}

async function startReviewTask(
  orchestrator: Orchestrator,
  ctx: any,
  userRequestContent: string,
  researchContent: string | null,
  description: string,
): Promise<"started" | typeof BACK> {
  await orchestrator.startTask(ctx, "review", description);
  if (!orchestrator.active || orchestrator.active.type !== "review") return BACK;
  writeFileSync(join(orchestrator.active.dir, "USER_REQUEST.md"), userRequestContent, "utf-8");
  if (researchContent) {
    writeFileSync(join(orchestrator.active.dir, "RESEARCH.md"), researchContent, "utf-8");
  }
  return "started";
}

async function showReviewMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Review", [
      { title: "Current branch", description: "Review changes on current branch vs base" },
      { title: "Uncommitted changes", description: "Review working directory changes" },
      { title: "Describe", description: "Describe what to review and let the agent figure it out" },
      { title: "Resume", description: "Resume a previously unfinished review" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, "review", "No paused review tasks found.");
      if (result === "started") return result;
      continue;
    }

    if (choice === "Current branch") {
      const base = await detectDefaultBranch(orchestrator.pi, orchestrator.cwd, orchestrator.config);
      const pr = await detectCurrentPrContext(orchestrator);

      const urLines = [`# User Request\nReview current branch changes (${base}..HEAD)`];
      if (pr.prUrl) urLines.push(`PR: ${pr.prUrl}`);
      urLines.push("", "## Problem", "Review and identify issues in the code changes.", "", "## Constraints", "Focus on correctness, edge cases, style, missing tests, potential bugs.");
      const urContent = urLines.join("\n") + "\n";

      let resContent: string | null = null;
      if (pr.prContext) {
        resContent = ["## PR Context", pr.prContext, "", "## Affected Code", "(to be filled during review)", "", "## Architecture Context", "(to be filled during review)"].join("\n") + "\n";
      }

      const description = await promptDescription(ctx, "Describe the review (optional)", "review");
      if (!description) continue;
      return startReviewTask(orchestrator, ctx, urContent, resContent, description);
    }

    if (choice === "Uncommitted changes") {
      const urContent = "# User Request\nReview uncommitted changes\n\n## Problem\nReview and identify issues in uncommitted working directory changes.\n\n## Constraints\nFocus on correctness, edge cases, style, missing tests, potential bugs.\n";
      const description = await promptDescription(ctx, "Describe the review (optional)", "review");
      if (!description) continue;
      return startReviewTask(orchestrator, ctx, urContent, null, description);
    }

    const input = await ctx.ui.input("Describe what to review");
    if (input === undefined || input === null) continue;
    const trimmed = String(input).trim();
    if (!trimmed) continue;

    const urContent = `# User Request\n${trimmed}\n\n## Problem\n${trimmed}\n\n## Constraints\nFocus on correctness, edge cases, style, missing tests, potential bugs.\n`;
    return startReviewTask(orchestrator, ctx, urContent, null, trimmed);
  }
}

async function showTaskTypeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  inputPrompt: string,
): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, type.charAt(0).toUpperCase() + type.slice(1), [
      { title: "New", description: "Start a new session" },
      { title: "Resume", description: "Resume a paused session" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const description = await promptDescription(ctx, inputPrompt, type);
      if (!description) continue;
      await orchestrator.startTask(ctx, type, description);
      return "started";
    }

    const result = await showResumeMenu(orchestrator, ctx, type, `No paused ${type} tasks found.`);
    if (result === "started") return result;
  }
}

async function showNoActiveMenu(orchestrator: Orchestrator, ctx: any): Promise<string | undefined> {
  while (true) {
    const choice = await selectOption(ctx, "/pp", [
      { title: "Debug", description: "Diagnose an issue. Then (optionally) fix it" },
      { title: "Brainstorm", description: "Explore and brainstorm. Then (optionally) plan and implement" },
      { title: "Implement", description: "Brainstorm, plan and implement" },
      { title: "Review", description: "Review code changes, diffs, or pull requests" },
      { title: "Resume", description: "Resume a previously unfinished task" },
      { title: "Subagents", description: "Manage running agents" },
      { title: "Settings", description: "LSP, Flant AI, and other configuration" },
      { title: "Back", description: "Close this menu" },
    ]);
    if (!choice || choice === "Back") return undefined;

    if (choice === "Debug") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "debug", "Describe the task");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Brainstorm") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "brainstorm", "Describe the task");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Implement") {
      const result = await showImplementMenu(orchestrator, ctx);
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Review") {
      const result = await showReviewMenu(orchestrator, ctx);
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, undefined, "No paused tasks found.");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }

    await showSettingsMenu(orchestrator, ctx, true);
  }
}

function getReviewLabels(orchestrator: Orchestrator): { autoLabel: string; deepLabel: string } {
  const byKind = orchestrator.active?.state.reviewPassByKind ?? {};
  const autoCount = byKind["auto"] ?? 0;
  const deepCount = byKind["auto-deep"] ?? 0;
  const autoLabel = autoCount > 0 ? `Auto review (pass ${autoCount + 1})` : "Auto review";
  const deepLabel = deepCount > 0 ? `Auto deep review (pass ${deepCount + 1})` : "Auto deep review";
  return { autoLabel, deepLabel };
}

function hasEnabledReviewers(orchestrator: Orchestrator, kind: "auto" | "auto-deep"): boolean {
  if (!orchestrator.active) return false;
  const phase = orchestrator.active.state.phase;
  const config = kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
  const reviewers = phase === "brainstorm"
    ? config.brainstormReviewers
    : phase === "plan"
    ? config.planReviewers
    : config.codeReviewers;
  return Object.values(reviewers).some((v) => v.enabled);
}

function handleReviewResult(ctx: any, text: string): { continueLoop: boolean; text?: string } {
  if (text.includes("Choose another option.") || text === "Plannotator approved the plan. Choose next action.") {
    ctx.ui.notify(text, "info");
    return { continueLoop: true };
  }
  return { continueLoop: false, text };
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
    const phase = task.state.phase;
    const step = task.state.step;

    const waiting = step === "await_planners" || step === "await_reviewers";
    const { autoLabel, deepLabel } = getReviewLabels(orchestrator);
    const isReviewPhase = phase === "review";
    const hasPlannotator = phase === "plan" || phase === "implement" || isReviewPhase;

    const opt = (title: string, description: string): OptionInput => ({ title, description });

    const options: OptionInput[] = [];
    options.push(opt("Finish", "Complete, pause, or continue to next phase"));
    if (!waiting) {
      options.push(opt(autoLabel, "Run automated review with configured reviewers"));
      options.push(opt(deepLabel, "Run automated review with higher thinking level"));
      if (hasPlannotator) {
        if (isReviewPhase) {
          options.push(opt("Review in Plannotator", "Open visual diff review in browser"));
        } else {
          options.push(opt("Review in Plannotator", "Open visual review in browser"));
        }
        if (!isReviewPhase) {
          options.push(opt("Review on my own", "Review manually, then continue"));
        }
      }
    }
    options.push(opt("Subagents", "Manage running agents"));
    options.push(opt("Status", "Show current task phase, step, and timing"));
    options.push(opt("Settings", "LSP and other configuration"));
    options.push(opt("Back", "Return to the prompt and keep working"));

    const choice = await selectOption(ctx, summary, options);
    if (!choice || choice === "Back") {
      return "";
    }

    if (choice === "Status") {
      showStatus(orchestrator, ctx);
      continue;
    }
    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }
    if (choice === "Settings") {
      await showSettingsMenu(orchestrator, ctx, false);
      continue;
    }

    if (mode === "command") {
      await abortCurrentWork(orchestrator, ctx);
    }

    if (choice === "Finish") {
      const canContinue = phase !== "implement" && !waiting;
      const continueLabel = phase === "plan" ? "Continue to implement" : "Continue to plan & implement";
      const finishOptions: OptionInput[] = [];
      if (canContinue) {
        finishOptions.push(opt(continueLabel, "Approve and advance to the next phase"));
      }
      finishOptions.push(opt("Complete", "Mark task as done and clean up"));
      finishOptions.push(opt("Pause", "Suspend task to resume later"));
      finishOptions.push(opt("Back", "Return to the previous menu"));

      const finishChoice = await selectOption(ctx, "Finish", finishOptions);
      if (!finishChoice || finishChoice === "Back") continue;
      if (finishChoice === "Pause") {
        const text = await pauseTask(orchestrator, ctx);
        return mode === "tool" ? text : "";
      }
      if (finishChoice === "Complete") {
        const text = await finishTask(orchestrator, ctx);
        return mode === "tool" ? text : "";
      }
      finalizeReviewCycle(task);
      const result = await orchestrator.transitionToNextPhase(ctx);
      if (!result.ok) return `Transition blocked: ${result.error}`;
      if (orchestrator.phaseCompactionPending || orchestrator.taskDoneCompactionPending) return "";
      const curStep = orchestrator.active?.state.step;
      if (curStep === "await_planners" || curStep === "await_reviewers") return "";
      return "";
    }

    if (choice === "Review in Plannotator" && isReviewPhase) {
      const text = await openReviewTaskInPlannotator(orchestrator);
      ctx.ui.notify(text, "info");
      continue;
    }

    finalizeReviewCycle(task);

    if (choice === autoLabel || choice === deepLabel || choice === "Review in Plannotator") {
      const kind = choice === autoLabel ? "auto" as const : choice === deepLabel ? "auto-deep" as const : "plannotator" as const;
      if (kind !== "plannotator" && !hasEnabledReviewers(orchestrator, kind)) {
        const label = phase === "brainstorm" ? "brainstorm" : phase === "plan" ? "plan" : "code";
        ctx.ui.notify(`No ${label} reviewers enabled.`, "info");
        continue;
      }
      const text = await enterReviewCycle(orchestrator, ctx, kind);
      const curStep = orchestrator.active?.state.step;
      if (curStep === "await_reviewers") return "";
      const handled = handleReviewResult(ctx, text);
      if (handled.continueLoop) continue;
      return handled.text ?? text;
    }

    if (choice === "Review on my own") {
      if (phase === "plan") {
        setStep(orchestrator, "synthesize");
      } else {
        setStep(orchestrator, "llm_work");
      }
      return continueMessage;
    }
  }
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any, mode: MenuMode = "command"): Promise<string | undefined> {
  if (!orchestrator.active) {
    return showNoActiveMenu(orchestrator, ctx);
  }
  const text = await showActiveTaskMenu(orchestrator, ctx, "Choose next action", mode);
  return text || undefined;
}
