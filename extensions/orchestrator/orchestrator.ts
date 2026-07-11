import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, basename, relative } from "path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolvePreset, type NormalizedPiPiConfig } from "./config.js";
import {
  createTask,
  loadTask,
  saveTask,
  lockTask,
  validateFromPath,
  getEffectivePhaseMode,
  type TaskType,
  type TaskMode,
  type TaskState,
  type Phase,
} from "./state.js";
import { getContextDirs, loadAllContextFiles, getPhaseArtifacts, getLatestSynthesizedPlan } from "./context.js";
import { brainstormSystemPrompt } from "./phases/brainstorm.js";
import { planningSystemPrompt, spawnPlanners } from "./phases/planning.js";
import { implementationSystemPrompt } from "./phases/implementation.js";
import { reviewSystemPrompt as reviewCycleSystemPrompt } from "./phases/review.js";
import { reviewSystemPrompt as reviewTaskSystemPrompt } from "./phases/review-task.js";
import { registerAgentDefinitions, unregisterAgentDefinitions, encodePoolVariant } from "./agents/registry.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";
import { createAdvisorAgent } from "./agents/advisor.js";
import { createDeepDebuggerAgent } from "./agents/deep-debugger.js";
import { createReviewerAgent } from "./agents/reviewer.js";
import { resolveModel, getModelInfo, findLatestFamilyMatch, setSubscriptionFallbackActive } from "./model-registry.js";
import { buildRepoContext } from "./agents/repo-context.js";
import { getLogger, addTaskDestination, removeTaskDestination, setLogLevel } from "./log.js";
import { handleSpawnResult } from "./spawn-cleanup.js";
import { getTracer } from "./tracer.js";
import { TransitionController, type TransitionHost } from "./transition-controller.js";

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
  // Non-null when loadConfig threw on session_start. While set, only a minimal
  // read-only /pp path is available and `config` holds a rendering-only default
  // fallback (NOT the user's config, which is invalid).
  configError: string | null = null;
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
  // Main-turn stall watchdog (BUG-2). A main turn that starts but never emits a
  // terminal turn_end/error can wedge the session ("Working…" forever). Unlike
  // staleAgentTimer (subagents only), this watches the MAIN session: any main-
  // session stream/tool/turn activity refreshes mainTurnLastActivity; when a turn
  // is in flight with no activity beyond config.performance.internals.mainTurnStale,
  // the watchdog recovers via the idle-gated single-send path.
  mainTurnTimer: ReturnType<typeof setInterval> | null = null;
  mainTurnLastActivity = 0;
  mainTurnInFlight = false;
  mainTurnRecovering = false;
  // Single consecutive-nudge guard (replaces the old multi-tier throttle). Reset
  // to 0 on any productive turn; once it reaches the cap the nudges halt with one
  // user notification.
  consecutiveNudges = 0;
  nudgeHalted = false;
  pendingSubagentSpawns = 0;
  errorRetryCount = 0;
  // Halts the API-error auto-retry once errorRetryCount exceeds its cap, mirroring
  // nudgeHalted. Without this, a benign intervening turn (e.g. the retried turn
  // ends as a text-only "I'll wait") reset errorRetryCount to 0, so the 5-retry
  // cap never accumulated and the "Previous request failed" nudge could fire
  // unbounded (hundreds of times) against transient errors. Cleared only on
  // genuine (non-[PI-PI]) user re-engagement, like nudgeHalted.
  errorNudgeHalted = false;
  commitReminderSent = false;
  phaseStartTime = 0;
  pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Unsubscribe for the direct ESC interrupt armed while pendingRetryTimer is
  // live. pi-pi's own post-error retry is NOT covered by any SDK/interactive ESC
  // binding (the turn already ended in error, the session is not streaming), so
  // without this ESC would not cancel it.
  pendingRetryEscUnsub: (() => void) | null = null;
  activeTaskToken = 0;
  // Side-channel for stale-nudge re-validation. A continuation nudge is delivered
  // as a followUp whose prompt STRING carries no phase/task token, and the SDK
  // queue only surfaces the string in before_agent_start. So at nudge-generation
  // time we record {phase, taskToken} keyed by the exact nudge string; at delivery
  // we re-check both against the live phase/token and drop the nudge on mismatch
  // (a nudge generated for an old phase/task must not drive a turn in the new one).
  // Last-wins per distinct string; a stale entry only ever fails-closed to drop.
  pendingNudges = new Map<string, { phase: Phase; taskToken: number }>();
  // Subscription rate-limit fallback (Issue 5). subFallbackActive mirrors the
  // model-registry override flag; subFallbackDialogPending guards against
  // opening more than one switch dialogue at a time (across main + subagents);
  // subFallbackModelId records the sub model that hit the limit (used by the
  // switch-back probe); subSwitchBackTimer is the fixed-interval probe timer.
  subFallbackActive = false;
  subFallbackDialogPending = false;
  // True while a user-facing dialogue (ask_user / the /pp menu / any interactive
  // selectOption) is open. The main-turn watchdog skips while set so a turn
  // legitimately parked on a human is not aborted. Set on dialogue open, cleared
  // in finally on every exit (resolve, ESC/cancel, error).
  interactivePromptOpen = false;
  // One-shot review-ready instruction (item 9). While a menu/ask turn is live,
  // the review-ready banner must NOT be queued as a followUp (ESC/abort flushes
  // the queue into the editor input — the stray-banner bug). Instead it is
  // stashed here and delivered as a FRESH idle-gated turn once the dialogue
  // closes. Cleared after delivery so it fires exactly once.
  pendingReviewReady: string | null = null;
  // Set SYNCHRONOUSLY the moment a sub-429 is detected (before any async dialog),
  // and cleared once the decision resolves. The autonomous planner/reviewer
  // auto-retry consults this to avoid re-spawning a failed variant on the still-
  // sub-routed model while the fallback decision is in flight.
  subFallbackPendingDecision = false;
  subFallbackModelId: string | null = null;
  subSwitchBackTimer: ReturnType<typeof setTimeout> | null = null;
  userGatePending = false;
  lastCtx: any = null;
  failedPlannerVariants: string[] = [];
  failedReviewerVariants: string[] = [];
  plannerFailureDialogPending = false;
  reviewerFailureDialogPending = false;
  plannotatorReject: ((reason: Error) => void) | null = null;
  plannotatorUnsub: (() => void) | null = null;
  plannotatorTimer: ReturnType<typeof setTimeout> | null = null;
  transitionToNextPhase: (ctx: any, plannerPreset?: string) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: false, error: "not initialized" });
  // Assigned by registerEventHandlers. Wired into planner spawn onSettled as the
  // safety net the deleted 5s poller used to provide: when a spawn settles having
  // produced ZERO agents (zero enabled planners, or all spawns failed before any
  // subagents:completed/failed event), nothing else would advance await_planners.
  // For spawned>0 the lifecycle events drive completion, so onSettled passes the
  // spawned count and this only force-checks the zero case.
  checkPlannerCompletion: () => void = () => {};
  readonly transitionController: TransitionController;

  // The single live instance, so module-level dialogue wrappers (selectOption in
  // event-handlers/pp-menu) can toggle interactivePromptOpen without threading a
  // reference through ~70 call sites.
  static current: Orchestrator | null = null;

  constructor(readonly pi: ExtensionAPI) {
    // The controller calls pi (the main session) directly for sends, and uses the
    // host only for live-ctx-dependent bits (compact/isIdle/currentStep).
    this.transitionController = new TransitionController(this.makeTransitionHost(), this.pi);
    Orchestrator.current = this;
  }

  // Live-session host the TransitionController uses for compaction/idle/step.
  private makeTransitionHost(): TransitionHost {
    return {
      compact: (options) => {
        const compact = this.lastCtx?.compact;
        if (!compact) return false;
        compact(options);
        return true;
      },
      isIdle: () => {
        const idle = this.lastCtx?.isIdle;
        return typeof idle === "function" ? !!idle.call(this.lastCtx) : false;
      },
      currentStep: () => this.active?.state.step ?? null,
    };
  }

  // Arm a direct ESC interrupt for the post-error retry window. Idempotent: a
  // single onTerminalInput handler stays registered until the retry is delivered,
  // cancelled, or the task is reset. While pendingRetryTimer is live, ESC cancels
  // the pending retry (no other binding covers this window).
  armRetryEscInterrupt(ctx: any): void {
    if (this.pendingRetryEscUnsub) return;
    const onTerminalInput = ctx?.ui?.onTerminalInput;
    if (typeof onTerminalInput !== "function") return;
    const unsub = onTerminalInput.call(ctx.ui, (data: string) => {
      if (!this.pendingRetryTimer) return undefined;
      // Match a STANDALONE ESC only. Arrow/function/mouse sequences also start
      // with 0x1b (e.g. "\x1b[A"), so `includes` would misfire on navigation
      // keys and swallow them; a bare ESC is exactly the one-byte string.
      if (data === "\x1b") {
        this.cancelPendingRetry();
        ctx?.ui?.notify?.("Retry cancelled.", "info");
        return { consume: true };
      }
      return undefined;
    });
    this.pendingRetryEscUnsub = typeof unsub === "function" ? unsub : null;
  }

  disarmRetryEscInterrupt(): void {
    if (this.pendingRetryEscUnsub) {
      try {
        this.pendingRetryEscUnsub();
      } catch {
        // ignore unsubscribe failures
      }
      this.pendingRetryEscUnsub = null;
    }
  }

  // Cancel a pending post-error retry (timer + ESC interrupt) and reset the retry
  // counter. Used by the ESC interrupt handler and by abort paths.
  cancelPendingRetry(): void {
    if (this.pendingRetryTimer) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
    this.disarmRetryEscInterrupt();
    this.errorRetryCount = 0;
    this.errorNudgeHalted = false;
  }

  // Deliver a queued message only once the main session is idle. Firing a
  // followUp while the SDK still has an active run triggers an async, runtime-
  // swallowed "Agent is already processing" rejection (surfaces as
  // Extension "<runtime>" error), so we PRE-CHECK idle and DEFER (bounded poll)
  // rather than dropping the nudge. Guarded by activeTaskToken; the poll reuses
  // pendingRetryTimer so ESC/abort cancels it.
  sendUserMessageWhenIdle(text: string, taskToken: number, attempt = 0): void {
    const log = getLogger();
    if (this.activeTaskToken !== taskToken || !this.active) {
      this.disarmRetryEscInterrupt();
      return;
    }
    const idleFn = this.lastCtx?.isIdle;
    const idle = typeof idleFn === "function" ? !!idleFn.call(this.lastCtx) : true;
    if (idle) {
      this.disarmRetryEscInterrupt();
      this.safeSendUserMessage(text);
      return;
    }
    const MAX_ATTEMPTS = 120; // ~2min at 1s poll
    if (attempt >= MAX_ATTEMPTS) {
      log.warn({ s: "orchestrator", attempt }, "sendUserMessageWhenIdle gave up waiting for idle");
      this.disarmRetryEscInterrupt();
      this.lastCtx?.ui?.notify?.(
        "pi-pi stopped waiting for the agent to go idle; auto-continuation was dropped. Send any message to resume.",
        "warning",
      );
      return;
    }
    this.pendingRetryTimer = setTimeout(() => {
      this.pendingRetryTimer = null;
      this.sendUserMessageWhenIdle(text, taskToken, attempt + 1);
    }, 1000);
  }

  safeSendUserMessage(text: string): void {
    const log = getLogger();
    const attempt = (retries: number) => {
      try {
        // Route through the controller's single send path. "instruction" maps to
        // followUp: queues the message and triggers a turn once the current one
        // settles (or runs immediately when idle), so it never throws "Agent is
        // already processing" when called mid-tool (e.g. during a transition).
        this.transitionController.send(text, "instruction");
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

  // Deliver the review-ready instruction WITHOUT leaking it into the editor on
  // ESC/abort (item 9). If a menu/ask dialogue is live, the followUp queue would
  // be dumped into the prompt input by restoreQueuedMessagesToEditor on abort —
  // so stash the message and deliver it as a fresh idle-gated turn once the
  // dialogue closes (flushPendingReviewReady). If nothing is open, deliver now.
  deliverReviewReady(text: string): void {
    if (this.interactivePromptOpen) {
      this.pendingReviewReady = text;
      return;
    }
    this.pendingReviewReady = null;
    this.sendUserMessageWhenIdle(text, this.activeTaskToken);
  }

  // Deliver a stashed review-ready instruction (if any) as a fresh idle-gated
  // turn. One-shot: cleared before sending so it never re-fires on a later idle.
  // Called when a menu/ask dialogue closes (including ESC/abort).
  flushPendingReviewReady(): void {
    const text = this.pendingReviewReady;
    if (!text || !this.active) return;
    this.pendingReviewReady = null;
    this.sendUserMessageWhenIdle(text, this.activeTaskToken);
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
        const allSpecs = allModels.map((m) => `${m.provider}/${m.id}`);
        const familyMatch = findLatestFamilyMatch(spec, allSpecs);
        if (familyMatch) {
          const fmLower = familyMatch.toLowerCase();
          resolved = allModels.find(
            (m) => `${m.provider.toLowerCase()}/${m.id.toLowerCase()}` === fmLower,
          );
        }
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

  // The footer's phase/mode display (line 1) reads orchestrator state directly; this only
  // sets a hidden "pp-phase" status whose value changes per transition so the host repaints
  // the footer. Nothing renders this string (footer line 3 was removed), so it stays terse.
  updateStatus(ctx: ExtensionContext): void {
    if (!this.active || this.active.state.phase === "done") {
      ctx.ui.setStatus("pp-phase", undefined);
      return;
    }
    const s = this.active.state;
    const cycle = s.reviewCycle ? `:${s.reviewCycle.kind}#${s.reviewCycle.pass}` : "";
    ctx.ui.setStatus("pp-phase", `${this.active.type}:${s.phase}:${s.step}:${getEffectivePhaseMode(s)}${cycle}`);
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

    const mode: TaskMode = getEffectivePhaseMode(this.active.state);

    if (this.active.state.reviewCycle?.step === "apply_feedback") {
      const pass = this.active.state.reviewCycle.pass;
      return reviewCycleSystemPrompt(this.active.dir, pass, this.active.state.phase, mode);
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
      // Route new-task compaction through the controller as a "done" target.
      this.lastCtx = ctx;
      await this.transitionController.requestTransition({
        kind: "done",
        discard: true,
        summary: `A new, unrelated ${type} task is starting. The previous task is finished — DISCARD its entire conversation. Do NOT carry forward, reference, or act on any prior task's messages, phase, plan, or aborted turns; treat the new task as a clean slate.`,
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

    // Validate the fork source BEFORE creating the new task so an invalid or
    // escaping path cannot leave a half-created task behind. validateFromPath
    // resolves against .pp/state/, so feed it the stateDir-relative form (the
    // same shape stored in state.from) rather than the absolute dir.
    let validatedFromDir: string | undefined;
    if (fromTaskDir) {
      const fromRel = relative(join(this.cwd, ".pp", "state"), fromTaskDir);
      const validation = validateFromPath(this.cwd, fromRel);
      if (!validation.ok) {
        ctx.ui.notify(validation.reason, "error");
        return;
      }
      validatedFromDir = validation.dir;
    }

    const dir = createTask(this.cwd, type, description, mode);
    const state = loadTask(dir);

    if (validatedFromDir) {
      const srcUr = join(validatedFromDir, "USER_REQUEST.md");
      const srcRes = join(validatedFromDir, "RESEARCH.md");
      const srcArtifacts = join(validatedFromDir, "artifacts");
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
      state.from = relative(join(this.cwd, ".pp", "state"), validatedFromDir);
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
      : type === "quick" ? "quick"
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
          this.transitionController.phaseSend,
          plannerVariants,
          this.active?.state.repos ?? [],
        ),
        { kind: "planner", logScope: "planner", logMessage: "spawnPlanners failed", onSettled: (result) => { if (!result?.spawned) this.checkPlannerCompletion(); } },
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
    this.errorNudgeHalted = false;
    this.commitReminderSent = false;
    this.consecutiveNudges = 0;
    this.nudgeHalted = false;
    this.pendingNudges.clear();
    this.phaseStartTime = 0;
    this.userGatePending = false;
    this.pendingReviewReady = null;
    this.failedPlannerVariants = [];
    this.failedReviewerVariants = [];
    this.plannerFailureDialogPending = false;
    this.reviewerFailureDialogPending = false;
    if (this.pendingRetryTimer) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
    this.disarmRetryEscInterrupt();
    if (this.staleAgentTimer) {
      clearInterval(this.staleAgentTimer);
      this.staleAgentTimer = null;
    }
    if (this.mainTurnTimer) {
      clearInterval(this.mainTurnTimer);
      this.mainTurnTimer = null;
    }
    this.mainTurnInFlight = false;
    this.mainTurnRecovering = false;
    this.clearSubscriptionFallback();
  }

  // Reset the subscription rate-limit fallback: cancel the switch-back probe
  // timer, clear the model-registry override, and reset guards. Called on task
  // reset/cleanup so the sticky override never leaks across tasks.
  clearSubscriptionFallback(): void {
    if (this.subSwitchBackTimer) {
      clearTimeout(this.subSwitchBackTimer);
      this.subSwitchBackTimer = null;
    }
    this.subFallbackActive = false;
    this.subFallbackDialogPending = false;
    this.interactivePromptOpen = false;
    this.subFallbackPendingDecision = false;
    this.subFallbackModelId = null;
    setSubscriptionFallbackActive(false);
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
    const taskAgent = createTaskAgent(this.config);
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
      ...this.buildPoolAgentDefinitions(appendContext),
    ]);
  }

  // Register one model-named subagent per ENABLED entry in each on-demand pool
  // (advisors / reviewers / deep-debuggers). The variant token encodes the
  // model+thinking so the caller can see exactly what each is; the base `type`
  // (advisor/reviewer/deep-debugger) drives context-file lookup. A collision
  // after name sanitization is skipped (do not silently merge two entries).
  private buildPoolAgentDefinitions(
    appendContext: (agentType: string, prompt: string, modelInfo: { vendor: string; family: string; tier: string }) => string,
  ): Array<{ type: string; variant: string; frontmatter: any; prompt: string }> {
    const pools = this.config.agents.subagents.pools;
    const defs: Array<{ type: string; variant: string; frontmatter: any; prompt: string }> = [];
    const seen = new Set<string>();
    const add = (
      baseType: "advisor" | "reviewer" | "deep-debugger",
      entry: { model: string; thinking: string; enabled?: boolean },
      make: (e: { model: string; thinking: string }) => { frontmatter: any; prompt: string },
    ) => {
      if (entry.enabled === false) return;
      const variant = encodePoolVariant(resolveModel(entry.model), entry.thinking);
      const name = `${baseType}_${variant}`;
      if (seen.has(name)) {
        getLogger().warn({ s: "agents", name }, "pool entry collides after sanitization; skipping");
        return;
      }
      seen.add(name);
      const agent = make(entry);
      defs.push({
        type: baseType,
        variant,
        frontmatter: agent.frontmatter,
        prompt: appendContext(baseType, agent.prompt, getModelInfo(resolveModel(entry.model))),
      });
    };
    for (const e of pools.advisors) add("advisor", e, createAdvisorAgent);
    for (const e of pools.reviewers) add("reviewer", e, createReviewerAgent);
    for (const e of pools.deepDebuggers) add("deep-debugger", e, createDeepDebuggerAgent);
    return defs;
  }

  // The orchestrator (main-agent) model config that applies to a phase — the
  // source of truth for the thinking level shown in the main agent's identity
  // block. Mirrors the phase→model selection in injectContextAndArtifacts.
  mainAgentConfigForPhase(phase: Phase | undefined): { model: string; thinking: string } {
    const o = this.config.agents.orchestrators;
    if (phase === "debug" && this.active?.type === "debug") return o.debug;
    if (phase === "brainstorm" && this.active?.type === "brainstorm") return o.brainstorm;
    if (phase === "review" && this.active?.type === "review") return o.review;
    if (phase === "plan") return o.plan;
    return o.implement;
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
      this.transitionController.sendCustom(
        { customType: "pp-context", content: cf.content, display: false },
        "context",
      );
    }
    const artifacts = getPhaseArtifacts(taskDir, phase);
    for (const artifact of artifacts) {
      this.transitionController.sendCustom(
        { customType: "pp-artifact", content: `=== ${artifact.name} ===\n${artifact.content}`, display: false },
        "context",
      );
    }
  }

  compactAndTransition(ctx: ExtensionContext, taskDir: string, phase: Phase, onReady?: () => void, summary?: string): void {
    getLogger().info({ s: "phase", taskDir, phase }, "compact and transition");
    // Ensure the controller's host can reach this live ctx for compact/isIdle.
    this.lastCtx = ctx;
    // Notify-only case: entering plan and immediately awaiting planners. No
    // "Begin working" instruction is sent — the agent waits for onSubagentsDone.
    const notifyOnly = this.active?.state.phase === "plan" && this.active.state.step === "await_planners";
    void this.transitionController.requestTransition({
      kind: "phase",
      summary: summary || "Phase transition — previous phase completed.",
      onResume: async () => {
        this.phaseStartTime = Date.now();
        if (this.active && (phase === "plan" || phase === "implement")) {
          const modelConfig = phase === "plan" ? this.config.agents.orchestrators.plan : this.config.agents.orchestrators.implement;
          await this.switchModel(ctx, modelConfig.model, modelConfig.thinking);
        }
        this.injectContextAndArtifacts(taskDir, phase);
        onReady?.();
        if (notifyOnly) {
          ctx.ui.notify("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
        }
      },
      instruction: notifyOnly ? undefined : `[PI-PI] Entered ${phase} phase. Begin working.`,
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
