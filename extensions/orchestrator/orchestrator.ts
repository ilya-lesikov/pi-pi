import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, basename, relative } from "path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolvePreset, type NormalizedPiPiConfig } from "./config.js";
import {
  createTask,
  loadTask,
  saveTask,
  lockTask,
  getEffectiveMode,
  type TaskType,
  type TaskMode,
  type TaskState,
  type Phase,
} from "./state.js";
import { phasePipeline } from "./phases/machine.js";
import { getContextDirs, loadAllContextFiles, getPhaseArtifacts, getLatestSynthesizedPlan } from "./context.js";
import { brainstormSystemPrompt } from "./phases/brainstorm.js";
import { planningSystemPrompt, spawnPlanners } from "./phases/planning.js";
import { implementationSystemPrompt } from "./phases/implementation.js";
import { reviewSystemPrompt as reviewCycleSystemPrompt } from "./phases/review.js";
import { reviewSystemPrompt as reviewTaskSystemPrompt } from "./phases/review-task.js";
import { registerAgentDefinitions, unregisterAgentDefinitions } from "./agents/registry.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";
import { resolveModel, getModelInfo } from "./model-registry.js";
import { buildRepoContext } from "./agents/repo-context.js";
import { getLogger, addTaskDestination, removeTaskDestination, setLogLevel } from "./log.js";
import { handleSpawnResult } from "./spawn-cleanup.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

const BUNDLED_TOOLS = new Set([
  "Agent", "get_subagent_result", "steer_subagent",
  "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute",
  "ask_user",
]);

export interface ActiveTask {
  dir: string;
  type: TaskType;
  state: TaskState;
  release: (() => Promise<void>) | null;
  taskId: string;
  modifiedFiles: Set<string>;
  reviewPass: number;
  description: string;
}

export class Orchestrator {
  active: ActiveTask | null = null;
  config!: NormalizedPiPiConfig;
  cwd = "";
  spawnedAgentIds = new Set<string>();
  agentDescriptions = new Map<string, string>();
  agentSpawnTimes = new Map<string, number>();
  agentLifecycle = new Map<string, {
    createdAt?: number;
    startedAt?: number;
    firstToolAt?: number;
    firstTurnAt?: number;
    lastEventAt?: number;
    type?: string;
    description?: string;
    phase?: string;
    step?: string;
  }>();
  staleAgentTimer: ReturnType<typeof setInterval> | null = null;
  phaseCompactionPending = false;
  phaseCompactionSummary = "";
  taskDoneCompactionPending = false;
  taskDoneCompactionSummary = "";
  nudgeTimestamps: number[] = [];
  cooldownHits: number[] = [];
  nudgeHalted = false;
  pendingSubagentSpawns = 0;
  errorRetryCount = 0;
  commitReminderSent = false;
  textStopTimestamps: number[] = [];
  phaseStartTime = 0;
  awaitPollTimer: ReturnType<typeof setInterval> | null = null;
  pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  activeTaskToken = 0;
  userGatePending = false;
  reviewTransitionToken = -1;
  lastCtx: any = null;
  failedPlannerVariants: string[] = [];
  failedReviewerVariants: string[] = [];
  plannerFailureDialogPending = false;
  reviewerFailureDialogPending = false;
  plannotatorReject: ((reason: Error) => void) | null = null;
  plannotatorUnsub: (() => void) | null = null;
  plannotatorTimer: ReturnType<typeof setTimeout> | null = null;
  transitionToNextPhase: (ctx: any, plannerPreset?: string) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: false, error: "not initialized" });

  constructor(readonly pi: ExtensionAPI) {}

  safeSendUserMessage(text: string): void {
    const log = getLogger();
    const attempt = (retries: number) => {
      try {
        this.pi.sendUserMessage(text);
        log.debug({ s: "orchestrator", retries, text: text.slice(0, 200) }, "safeSend sent");
      } catch (err: any) {
        if (retries < 30) {
          log.debug({ s: "orchestrator", retries, err: err?.message }, "safeSend retry");
          setTimeout(() => attempt(retries + 1), 1000);
        } else {
          log.error({ s: "orchestrator", retries, err: err?.message ?? String(err), text: text.slice(0, 200) }, "safeSend failed after max retries");
          this.lastCtx?.ui?.notify?.(
            "pi-pi could not deliver a message to the agent; the task may be stalled. See logs.",
            "error",
          );
        }
      }
    };
    attempt(0);
  }

  truncateResult(result: string): string {
    const trimmed = result.trim();
    if (!trimmed) return "";
    const lines = trimmed.split("\n");
    if (lines.length <= 20 && trimmed.length <= 2000) return trimmed;
    const truncated = lines.slice(0, 20).join("\n").slice(0, 2000);
    return truncated + "\n…(truncated)";
  }

  async switchModel(ctx: ExtensionContext, modelSpec: string, thinking: string): Promise<boolean> {
    const log = getLogger();
    const registry = ctx.modelRegistry;
    const allModels = registry.getAvailable();

    const requestedSpecs = [resolveModel(modelSpec), modelSpec].filter((value, index, arr) => arr.indexOf(value) === index);
    log.debug({ s: "model", requestedSpecs, thinking, availableCount: allModels.length }, "switchModel");
    let resolved;
    for (const spec of requestedSpecs) {
      const slashIdx = spec.indexOf("/");
      if (slashIdx !== -1) {
        const provider = spec.substring(0, slashIdx).trim().toLowerCase();
        const modelId = spec.substring(slashIdx + 1).trim().toLowerCase();
        resolved = allModels.find(
          (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
        );
      }
      if (!resolved) {
        const pattern = spec.toLowerCase();
        const matches = allModels.filter(
          (m) => m.id.toLowerCase() === pattern || m.id.toLowerCase().includes(pattern),
        );
        if (matches.length === 1) resolved = matches[0];
      }
      if (resolved) break;
    }

    if (!resolved) {
      log.warn({ s: "model", requestedSpecs }, "model not found");
      return false;
    }

    const ok = await this.pi.setModel(resolved);
    if (!ok) {
      log.warn({ s: "model", resolved: `${resolved.provider}/${resolved.id}` }, "setModel returned false");
      return false;
    }

    const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
    const thinkingLevel = (VALID_THINKING.has(thinking) ? thinking : "high") as
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    this.pi.setThinkingLevel(thinkingLevel);
    log.debug({ s: "model", model: `${resolved.provider}/${resolved.id}`, thinking: thinkingLevel }, "model switched");
    return true;
  }

  updateStatus(ctx: ExtensionContext): void {
    if (!this.active || this.active.state.phase === "done") {
      ctx.ui.setStatus("pp-phase", undefined);
      return;
    }

    const type = this.active.type;
    const phase = this.active.state.phase;
    const step = this.active.state.step;
    const reviewCycle = this.active.state.reviewCycle;
    const effectiveMode = this.active.state.effectiveMode ?? this.active.state.mode;
    const modeLabel = effectiveMode === "autonomous" ? " [autonomous]" : "";

    if (type === "debug" || type === "brainstorm" || type === "quick") {
      const elapsed = this.phaseStartTime > 0 ? this.formatElapsed(this.phaseStartTime) : "";
      const suffix = elapsed ? ` (${elapsed})` : "";
      ctx.ui.setStatus("pp-phase", `pp: ${type}${modeLabel}${suffix}`);
      return;
    }

    const pipeline = phasePipeline(type).filter((p) => p !== "done");
    const currentIdx = pipeline.indexOf(phase as (typeof pipeline)[number]);

    const parts: string[] = [];
    for (let i = 0; i < pipeline.length; i++) {
      const p = pipeline[i];
      if (i < currentIdx) {
        parts.push(`✔ ${p}`);
      } else if (p === phase) {
        let detail = "";
        if (step === "await_planners") detail = "planners";
        else if (step === "await_reviewers") detail = "reviewers";
        else if (step === "synthesize") detail = "synthesize";
        else if (step === "apply_feedback") detail = "feedback";
        else if (step === "user_gate") detail = "review";

        if (reviewCycle) {
          const kind = reviewCycle.kind === "plannotator" ? "plannotator" : "review";
          detail = `${kind} #${reviewCycle.pass}`;
        }

        const elapsed = this.phaseStartTime > 0 ? this.formatElapsed(this.phaseStartTime) : "";
        const sub = [detail, elapsed].filter(Boolean).join(", ");
        parts.push(sub ? `${p} (${sub})` : p);
      } else {
        parts.push(p);
      }
    }

    ctx.ui.setStatus("pp-phase", `pp: ${parts.join(" → ")}${modeLabel}`);
  }

  private formatElapsed(startTime: number): string {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  }

  getPlanStartState(taskDir: string, plannerPresetName?: string): { step: string; shouldSpawnPlanners: boolean } {
    const plansDir = join(taskDir, "plans");
    const presetName = plannerPresetName ?? this.config.agents.subagents.presetGroups.planners.default;
    const plannerVariants = resolvePreset(this.config, "planners", presetName);
    const enabledPlannerVariants = Object.entries(plannerVariants)
      .filter(([, v]) => isEnabled(v))
      .map(([name]) => name);
    const plannerOutputs = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
      : [];
    const completedVariants = new Set(
      plannerOutputs.map((f) => f.replace(/^\d+_/, "").replace(/\.md$/, "")),
    );
    const hasAllEnabledVariants = enabledPlannerVariants.every((name) => completedVariants.has(name));

    if (enabledPlannerVariants.length === 0 || hasAllEnabledVariants || getLatestSynthesizedPlan(taskDir)) {
      return { step: "synthesize", shouldSpawnPlanners: false };
    }

    return { step: "await_planners", shouldSpawnPlanners: true };
  }

  getPhasePrompt(_ctx: ExtensionContext): string {
    if (!this.active) return "";

    const mode: TaskMode = getEffectiveMode(this.active.state) ?? "guided";

    if (this.active.state.reviewCycle?.step === "apply_feedback") {
      const pass = this.active.state.reviewCycle.pass;
      return reviewCycleSystemPrompt(this.active.dir, pass, this.active.state.phase);
    }

    switch (this.active.state.phase) {
      case "brainstorm":
        return brainstormSystemPrompt(this.active.type, this.active.description, this.active.dir, this.cwd);
      case "debug":
        return brainstormSystemPrompt(this.active.type, this.active.description, this.active.dir, this.cwd);
      case "plan":
        return planningSystemPrompt(this.active.dir, mode);
      case "implement":
        return implementationSystemPrompt(this.active.dir, this.cwd);
      case "review":
        return reviewTaskSystemPrompt(this.active.dir, this.cwd);
      case "quick":
        return "Work on the user's request directly. There are no phases, planning, or reviews.";
      default:
        return "";
    }
  }

  taskIdFromDir(dir: string): string {
    const name = basename(dir);
    return name.split("_")[0];
  }

  persistReviewPass(): void {
    if (!this.active) return;
    this.active.state.reviewPass = this.active.reviewPass;
    saveTask(this.active.dir, this.active.state);
  }

  async startTask(
    ctx: ExtensionCommandContext,
    type: TaskType,
    description: string,
    fromTaskDir?: string,
    skipBrainstorm?: boolean,
    mode?: TaskMode,
  ): Promise<void> {
    const log = getLogger();
    log.info({ s: "task", type, description, fromTaskDir: fromTaskDir ?? null, skipBrainstorm: skipBrainstorm ?? false, mode: mode ?? null }, "startTask");
    const hadActive = !!this.active;
    if (this.active) {
      ctx.ui.notify(
        `Pausing previous task "${this.active.description}" (phase: ${this.active.state.phase})…`,
        "info",
      );
      this.abortAllSubagents();
      saveTask(this.active.dir, this.active.state);
      unregisterAgentDefinitions(this.pi);
      await this.cleanupActive();
    }

    if (hadActive) {
      this.taskDoneCompactionPending = true;
      this.taskDoneCompactionSummary = `Starting new ${type} task. Previous conversation discarded.`;
      await new Promise<void>((resolve) => {
        const compact = (ctx as any).compact;
        if (!compact) { this.taskDoneCompactionPending = false; this.taskDoneCompactionSummary = ""; resolve(); return; }
        compact({
          onComplete: () => { this.taskDoneCompactionPending = false; resolve(); },
          onError: () => { this.taskDoneCompactionPending = false; this.taskDoneCompactionSummary = ""; resolve(); },
        });
      });
    }

    try {
      this.config = loadConfig(this.cwd);
    } catch (err: any) {
      ctx.ui.notify(`Config error: ${err.message}`, "error");
      return;
    }

    setLogLevel(this.config.general.logLevel);
    ensureGitignore(this.cwd);

    const dir = createTask(this.cwd, type, description, mode);
    const state = loadTask(dir);

    if (fromTaskDir) {
      const srcUr = join(fromTaskDir, "USER_REQUEST.md");
      const srcRes = join(fromTaskDir, "RESEARCH.md");
      const srcArtifacts = join(fromTaskDir, "artifacts");
      if (existsSync(srcUr)) {
        const originalUr = readFileSync(srcUr, "utf-8");
        const implNote =
          "# IMPLEMENTATION TASK\n\n" +
          "This is now an **implement** task — the previous brainstorm/debug/review task is over.\n" +
          "The user request, research, and artifacts below are carried over as context for implementation.\n" +
          "Your job is to plan and implement actual code changes based on this research.\n" +
          "Any prior instructions in the text below saying \"brainstorm only\", \"review only\",\n" +
          "\"do not implement\", \"no code changes\", or similar DO NOT APPLY — they were for the previous task.\n\n" +
          "---\n\n";
        writeFileSync(join(dir, "USER_REQUEST.md"), implNote + originalUr, "utf-8");
      }
      if (existsSync(srcRes)) copyFileSync(srcRes, join(dir, "RESEARCH.md"));
      if (existsSync(srcArtifacts)) {
        const destArtifacts = join(dir, "artifacts");
        mkdirSync(destArtifacts, { recursive: true });
        for (const f of readdirSync(srcArtifacts).filter((f) => f.endsWith(".md"))) {
          copyFileSync(join(srcArtifacts, f), join(destArtifacts, f));
        }
      }
      state.from = relative(join(this.cwd, ".pp", "state"), fromTaskDir);
      if (skipBrainstorm && type === "implement") {
        state.phase = "plan";
        state.initialPhase = "plan";
        state.activePlannerPreset = this.config.agents.subagents.presetGroups.planners.default;
        state.step = this.getPlanStartState(dir, state.activePlannerPreset).step;
      }
      saveTask(dir, state);
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockTask(dir, this.config.performance.internals);
    } catch (err: any) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        log.warn({ s: "task", dir }, "failed to clean up orphaned task dir");
      }
      ctx.ui.notify(`Failed to lock task: ${err.message}`, "error");
      return;
    }

    this.resetTaskScopedState();
    this.activeTaskToken++;

    this.active = {
      dir,
      type,
      state,
      release,
      taskId: this.taskIdFromDir(dir),
      modifiedFiles: new Set(),
      reviewPass: state.reviewPass,
      description: state.description,
    };

    addTaskDestination(dir);
    log.info({ s: "task", dir, taskId: this.active.taskId, phase: state.phase, step: state.step }, "task activated");

    const modelConfig = this.config.agents.orchestrators[
      type === "debug" ? "debug"
      : type === "brainstorm" ? "brainstorm"
      : type === "review" ? "review"
      : "implement"
    ];
    const modelOk = await this.switchModel(ctx, modelConfig.model, modelConfig.thinking);
    if (!modelOk) {
      ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
    }

    this.registerAgents();
    this.pi.setSessionName(this.active.description.slice(0, 50));
    this.lastCtx = ctx;
    this.updateStatus(ctx);

    this.injectContextAndArtifacts(this.active.dir, this.active.state.phase);

    this.phaseStartTime = Date.now();
    const isGenericDescription = ["implement", "debug", "brainstorm", "review"].includes(this.active.description);
    const isGenericQuickDescription = this.active.description === "quick";
    const hasInheritedTaskContext = Boolean(fromTaskDir && type === "implement");
    const isWaitingForPlanners = this.active.state.phase === "plan" && this.active.state.step === "await_planners";
    if ((isGenericDescription || isGenericQuickDescription) && !hasInheritedTaskContext) {
      ctx.ui.notify("Task created. Describe what you'd like to do.", "info");
    } else if (isWaitingForPlanners) {
      ctx.ui.notify("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
    } else {
      const desc = this.active.description;
      const descSuffix = !isGenericDescription ? `\n\nTask: ${desc}` : "";
      this.safeSendUserMessage(`[PI-PI] Entered ${this.active.state.phase} phase. Begin working.${descSuffix}`);
    }

    if (this.active.state.phase === "plan" && this.active.state.step === "await_planners") {
      const requestedPlannerPresetName = this.active.state.activePlannerPreset ?? this.config.agents.subagents.presetGroups.planners.default;
      const plannerPresetExists = Object.prototype.hasOwnProperty.call(this.config.agents.subagents.presetGroups.planners.presets ?? {}, requestedPlannerPresetName);
      const plannerPresetName = plannerPresetExists
        ? requestedPlannerPresetName
        : (Object.keys(this.config.agents.subagents.presetGroups.planners.presets ?? {})[0] ?? requestedPlannerPresetName);
      if (this.active.state.activePlannerPreset !== plannerPresetName) {
        this.active.state.activePlannerPreset = plannerPresetName;
        saveTask(this.active.dir, this.active.state);
      }
      if (!plannerPresetExists && plannerPresetName !== requestedPlannerPresetName) {
        ctx.ui.notify(
          `Planner preset "${requestedPlannerPresetName}" not found. Falling back to "${plannerPresetName}".`,
          "warning",
        );
      }
      const plannerVariants = resolvePreset(this.config, "planners", plannerPresetName);
      this.pendingSubagentSpawns = Object.values(plannerVariants).filter((v) => isEnabled(v)).length;
      this.failedPlannerVariants = [];
      handleSpawnResult(
        this,
        spawnPlanners(
          this.pi,
          this.cwd,
          this.active.dir,
          this.active.taskId,
          this.config,
          plannerVariants,
          this.active?.state.repos ?? [],
        ),
        { kind: "planner", logScope: "planner", logMessage: "spawnPlanners failed" },
      );
    }
  }

  abortAllSubagents(): void {
    for (const agentId of this.spawnedAgentIds) {
      this.pi.events.emit("subagents:rpc:stop", {
        requestId: crypto.randomUUID(),
        agentId,
      });
    }
    this.spawnedAgentIds.clear();
    this.pendingSubagentSpawns = 0;
  }

  resetTaskScopedState(): void {
    this.spawnedAgentIds.clear();
    this.agentDescriptions.clear();
    this.agentSpawnTimes.clear();
    this.agentLifecycle.clear();
    this.pendingSubagentSpawns = 0;
    this.errorRetryCount = 0;
    this.commitReminderSent = false;
    this.textStopTimestamps = [];
    this.nudgeTimestamps = [];
    this.cooldownHits = [];
    this.nudgeHalted = false;
    this.phaseCompactionPending = false;
    this.phaseCompactionSummary = "";
    this.phaseStartTime = 0;
    this.userGatePending = false;
    this.reviewTransitionToken = -1;
    this.failedPlannerVariants = [];
    this.failedReviewerVariants = [];
    this.plannerFailureDialogPending = false;
    this.reviewerFailureDialogPending = false;
    if (this.awaitPollTimer) {
      clearInterval(this.awaitPollTimer);
      this.awaitPollTimer = null;
    }
    if (this.pendingRetryTimer) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
    if (this.staleAgentTimer) {
      clearInterval(this.staleAgentTimer);
      this.staleAgentTimer = null;
    }
  }

  async cleanupActive(): Promise<void> {
    if (!this.active) return;
    const dir = this.active.dir;
    getLogger().info({ s: "task", dir }, "cleaning up active task");
    removeTaskDestination();
    this.resetTaskScopedState();
    if (this.active.release) {
      try {
        await this.active.release();
      } catch (err: any) {
        getLogger().error({ s: "task", dir, err: err.message }, "failed to release lock");
      }
    }
    this.active = null;
  }

  registerAgents(): void {
    const log = getLogger();
    const explore = createExploreAgent(this.config);
    const librarian = createLibrarianAgent(this.config);
    const taskAgent = createTaskAgent(this.config, "{{subtask}}", { userRequest: "", synthesizedPlan: "" });
    const phase = this.active?.state.phase;
    const repos = this.active?.state.repos ?? [];
    log.debug({ s: "agents", phase, repoCount: repos.length }, "registering agent definitions");
    const contextDirs = getContextDirs(this.cwd, repos, this.config.general.loadExtraRepoConfigs);
    const repoContext = buildRepoContext(repos);

    const appendContext = (agentType: string, prompt: string, modelInfo: { vendor: string; family: string; tier: string }): string => {
      const contextFiles = loadAllContextFiles(contextDirs, agentType as any, "system", phase, modelInfo);
      if (contextFiles.length === 0 && !repoContext) return prompt;
      const parts = [prompt];
      if (repoContext) parts.push(repoContext.trimEnd());
      if (contextFiles.length === 0) return parts.join("\n\n");
      const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
      parts.push("# Project Context\n\n" + contextBlock);
      return parts.join("\n\n");
    };

    registerAgentDefinitions(this.pi, [
      {
        type: "explore",
        variant: null,
        ...explore,
        prompt: appendContext("explore", explore.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.explore.model))),
      },
      {
        type: "librarian",
        variant: null,
        ...librarian,
        prompt: appendContext("librarian", librarian.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.librarian.model))),
      },
      {
        type: "task",
        variant: null,
        ...taskAgent,
        prompt: appendContext("task", taskAgent.prompt, getModelInfo(resolveModel(this.config.agents.subagents.simple.task.model))),
      },
    ]);
  }

  injectContextAndArtifacts(taskDir: string, phase: Phase): void {
    const log = getLogger();
    log.debug({ s: "context", taskDir, phase }, "injecting context and artifacts");
    const modelSpec =
      phase === "debug" && this.active?.type === "debug"
        ? this.config.agents.orchestrators.debug.model
      : phase === "brainstorm" && this.active?.type === "brainstorm"
        ? this.config.agents.orchestrators.brainstorm.model
      : phase === "review" && this.active?.type === "review"
        ? this.config.agents.orchestrators.review.model
      : phase === "plan"
        ? this.config.agents.orchestrators.plan.model
      : this.config.agents.orchestrators.implement.model;
    const activeModelSpec = this.lastCtx?.model
      ? `${this.lastCtx.model.provider}/${this.lastCtx.model.id}`
      : modelSpec;
    const repos = this.active?.state.repos ?? [];
    const contextDirs = getContextDirs(this.cwd, repos, this.config.general.loadExtraRepoConfigs);
    const contextFiles = loadAllContextFiles(
      contextDirs,
      "main",
      "context",
      phase,
      getModelInfo(activeModelSpec),
    );
    for (const cf of contextFiles) {
      this.pi.sendMessage(
        { customType: "pp-context", content: cf.content, display: false },
        { deliverAs: "steer" },
      );
    }
    const artifacts = getPhaseArtifacts(taskDir, phase);
    for (const artifact of artifacts) {
      this.pi.sendMessage(
        { customType: "pp-artifact", content: `=== ${artifact.name} ===\n${artifact.content}`, display: false },
        { deliverAs: "steer" },
      );
    }
  }

  compactAndTransition(ctx: ExtensionContext, taskDir: string, phase: Phase, onReady?: () => void): void {
    getLogger().info({ s: "phase", taskDir, phase }, "compact and transition");
    this.phaseCompactionPending = true;
    const finalize = async () => {
      this.phaseStartTime = Date.now();
      if (this.active && (phase === "plan" || phase === "implement")) {
        const modelConfig = phase === "plan" ? this.config.agents.orchestrators.plan : this.config.agents.orchestrators.implement;
        await this.switchModel(ctx, modelConfig.model, modelConfig.thinking);
      }
      this.injectContextAndArtifacts(taskDir, phase);
      onReady?.();
      if (this.active?.state.phase === "plan" && this.active.state.step === "await_planners") {
        ctx.ui.notify("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
      } else {
        this.safeSendUserMessage(`[PI-PI] Entered ${phase} phase. Begin working.`);
      }
    };
    ctx.compact({
      customInstructions: "Phase transition — discard all prior conversation. Produce a one-line summary: 'Previous phase completed.'",
      onComplete: () => {
        this.phaseCompactionPending = false;
        void finalize();
      },
      onError: () => {
        this.phaseCompactionPending = false;
        void finalize();
      },
    });
  }

  checkForConflictingExtensions(): string[] {
    const allTools = this.pi.getAllTools();
    const seen = new Map<string, number>();
    for (const tool of allTools) {
      if (BUNDLED_TOOLS.has(tool.name)) {
        seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
      }
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  }
}

export function ensureGitignore(cwd: string): void {
  const ppDir = join(cwd, ".pp");
  if (!existsSync(ppDir)) {
    mkdirSync(ppDir, { recursive: true });
  }

  const gitignorePath = join(ppDir, ".gitignore");
  const requiredEntries = ["state/", "config.json", "logs/"];

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, requiredEntries.join("\n") + "\n", "utf-8");
  } else {
    let content = readFileSync(gitignorePath, "utf-8");
    for (const entry of requiredEntries) {
      if (!content.includes(entry)) {
        content = content.trimEnd() + "\n" + entry + "\n";
      }
    }
    writeFileSync(gitignorePath, content, "utf-8");
  }
}
