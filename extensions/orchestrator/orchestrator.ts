import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NormalizedPiPiConfig, PoolEntry, PoolKey } from "./config.js";
import { getModelInfo, resolveModel } from "./model-registry.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";
import { createAdvisorAgent } from "./agents/advisor.js";
import { createReviewerAgent } from "./agents/reviewer.js";
import { createDeepDebuggerAgent } from "./agents/deep-debugger.js";
import { encodePoolVariant, registerAgentDefinitions } from "./agents/registry.js";
import { publishAcpState } from "./acp.js";
import { getLogger } from "./log.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

export class Orchestrator {
  config!: NormalizedPiPiConfig;
  configError: string | null = null;
  duplicateExtensionError = false;
  cwd = "";
  lastCtx: any = null;
  spawnedAgentIds = new Set<string>();
  agentDescriptions = new Map<string, string>();
  agentSpawnTimes = new Map<string, number>();
  staleAgentTimer: ReturnType<typeof setInterval> | null = null;
  mainTurnTimer: ReturnType<typeof setInterval> | null = null;
  mainTurnLastActivity = 0;
  mainTurnInFlight = false;
  mainTurnRecovering = false;
  mainTurnToolInFlight = 0;
  requestHadTools = false;
  requestToolCallCount = 0;
  requestHadFileMutation = false;
  requestHadEdit = false;
  continuationGeneration = 0;
  continuationCount = 0;
  objectiveContinuationCount = 0;
  continuationHalted = false;
  pendingContinuations = new Map<string, { invisible: boolean }>();
  lastEstimatedTokens: number | null = null;
  /** Messages of the most recent LLM call, replayed by the continuation check. */
  lastContextMessages: any[] = [];
  compactionArm = { armed: true };
  adaptiveCompaction: {
    nextThreshold: number | null;
    inFlight: boolean;
    pendingProactiveMeasure: boolean;
    disabled: boolean;
    modelKey: string | null;
    window: number | null;
    firedThreshold: number | null;
    contaminatedMeasures: number;
    failures: number;
  } = { nextThreshold: null, inFlight: false, pendingProactiveMeasure: false, disabled: false, modelKey: null, window: null, firedThreshold: null, contaminatedMeasures: 0, failures: 0 };
  manualCompactionPending = false;
  manualCompactionRequestId = 0;
  /**
   * A model switch pi-pi decided on while a request was still streaming, held
   * until a turn boundary. Switching in place compacts the session, and the
   * host's compaction aborts the run it is called from — which is the request
   * the switch was meant to carry on serving.
   */
  pendingModelSwitch: (() => Promise<void>) | null = null;
  modelSwitchPollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set while a parked switch is being carried out (compaction, then switch).
   * Holds continuations back so the resumed request runs on the model the
   * sequence lands on, and keeps the switch itself from compacting twice.
   */
  modelSwitchInFlight = false;
  /**
   * Set while switching from a point where the request is known to be over.
   * The host only settles a run after its turn_end handlers return, so a switch
   * made from one still looks live and would otherwise be owed a resume.
   */
  switchingBetweenRequests = false;
  /** Set while session_start routes the session back onto the configured main agent. */
  startupModelCorrection = false;
  idlePollTimer: ReturnType<typeof setTimeout> | null = null;
  subFallbackActive = false;
  subFallbackModelId: string | null = null;
  subFallbackMainPriorSpec: string | null = null;
  /**
   * The spec pi-pi last routed the root session onto. A live model still equal
   * to it is one pi-pi chose, so re-routing it is safe; anything else is the
   * user's own /model pick and must be left alone.
   */
  routedMainSpec: string | null = null;
  subSwitchBackTimer: ReturnType<typeof setTimeout> | null = null;
  tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _interactivePromptOpen = false;

  static current: Orchestrator | null = null;

  constructor(readonly pi: ExtensionAPI) {
    Orchestrator.current = this;
  }

  get interactivePromptOpen(): boolean {
    return this._interactivePromptOpen;
  }

  set interactivePromptOpen(open: boolean) {
    if (this._interactivePromptOpen === open) return;
    this._interactivePromptOpen = open;
    publishAcpState(this);
  }

  sendUserMessageWhenIdle(text: string, generation: number, attempt = 0): void {
    const ctx = this.lastCtx;
    if (!ctx || generation !== this.continuationGeneration) return;
    // A compaction rebuilds the context the message would land in, and the host
    // reports idle while one runs — so a continuation queued right after a
    // model switch would race the compaction that switch just started.
    // Several polling chains can be alive for one text (a redelivery does not
    // cancel the chain it overlaps), so the queue entry is the claim: whoever
    // takes it sends, the rest find it gone and stop.
    const pending = this.pendingContinuations.get(text);
    if (!pending) return;
    const compacting = this.adaptiveCompaction.inFlight || this.manualCompactionPending || this.modelSwitchInFlight;
    if (!compacting && (typeof ctx.isIdle !== "function" || ctx.isIdle())) {
      this.pendingContinuations.delete(text);
      // Put the claim back if the host refused it, so a later redelivery can
      // still get the message out instead of losing it silently.
      if (!this.deliverContinuation(text, pending.invisible)) this.pendingContinuations.set(text, pending);
      return;
    }
    if (attempt >= 120) {
      // Give up polling, but leave the text queued: a compaction that outlasted
      // the window still fires session_compact, which redelivers it.
      getLogger().warn({ s: "continuation", attempts: attempt }, "gave up waiting for an idle session");
      return;
    }
    this.idlePollTimer = setTimeout(() => {
      this.idlePollTimer = null;
      this.sendUserMessageWhenIdle(text, generation, attempt + 1);
    }, 1000);
  }

  /** Re-drive continuations still queued after whatever was blocking them cleared. */
  redeliverPendingContinuations(): void {
    for (const text of [...this.pendingContinuations.keys()]) {
      this.sendUserMessageWhenIdle(text, this.continuationGeneration);
    }
  }

  resetContinuation(): void {
    this.continuationGeneration++;
    this.continuationCount = 0;
    this.objectiveContinuationCount = 0;
    this.continuationHalted = false;
    this.pendingContinuations.clear();
  }

  /**
   * Queue a continuation. An invisible one is delivered as a hidden message:
   * it reaches the model but leaves no prompt in the transcript, so recovering
   * from a premature stop does not read as the user asking for one.
   */
  queueContinuation(text: string, invisible = false): void {
    const tagged = invisible ? text : `${text}\n[continuation:${this.continuationGeneration}]`;
    this.pendingContinuations.set(tagged, { invisible });
    this.sendUserMessageWhenIdle(tagged, this.continuationGeneration);
  }

  private deliverContinuation(text: string, invisible: boolean): boolean {
    if (!invisible) return this.safeSendUserMessage(text);
    try {
      this.pi.sendMessage({ customType: "pp-continuation", content: text, display: false }, { deliverAs: "followUp", triggerTurn: true });
      getLogger().debug({ s: "continuation" }, "delivered a hidden continuation");
      return true;
    } catch (error: any) {
      getLogger().debug({ s: "continuation", err: error?.message }, "hidden continuation refused; falling back to a visible one");
      return this.safeSendUserMessage(text);
    }
  }

  safeSendUserMessage(text: string): boolean {
    try {
      this.pi.sendUserMessage(text, { deliverAs: "followUp" });
      return true;
    } catch {
      try {
        this.pi.sendUserMessage(text);
        return true;
      } catch {
        getLogger().error({ s: "continuation" }, "the host refused an automatic continuation");
        return false;
      }
    }
  }

  /**
   * Whether a model switch can be carried out right now. A live request must
   * not be switched under: the compaction a switch triggers aborts the run it
   * is called from. A compaction already running is just as bad — the host
   * reports idle throughout one, and switching would change the model out from
   * under it.
   */
  private canSwitchModelNow(ctx: any): boolean {
    if (this.modelSwitchInFlight || this.adaptiveCompaction.inFlight || this.manualCompactionPending) return false;
    return !ctx || typeof ctx.isIdle !== "function" || ctx.isIdle();
  }

  /**
   * Carry out a model switch pi-pi owns, but never from inside a live request.
   * A streaming session parks the switch instead, and the next turn boundary
   * compacts, switches, and resumes the request it cut short.
   */
  async runModelSwitchBetweenTurns(action: () => Promise<void>): Promise<void> {
    if (!this.canSwitchModelNow(this.lastCtx)) {
      this.pendingModelSwitch = action;
      this.pollPendingModelSwitch();
      return;
    }
    await action();
  }

  /**
   * Backstop for a switch parked with no turn boundary left to drain it: a
   * probe that lands after the last turn_end of a request would otherwise stay
   * parked until some later request happened to end, running that one on the
   * model the switch was supposed to leave behind.
   */
  pollPendingModelSwitch(): void {
    if (this.modelSwitchPollTimer || !this.pendingModelSwitch) return;
    this.modelSwitchPollTimer = setTimeout(() => {
      this.modelSwitchPollTimer = null;
      const action = this.pendingModelSwitch;
      if (!action) return;
      if (!this.canSwitchModelNow(this.lastCtx)) {
        this.pollPendingModelSwitch();
        return;
      }
      this.pendingModelSwitch = null;
      // Between requests, so the compaction this switch triggers cuts nothing
      // short and owes no resume.
      void action().catch((error: any) => {
        getLogger().error({ s: "model", err: error?.message }, "a parked model switch failed");
      });
    }, 1000);
    this.modelSwitchPollTimer.unref?.();
  }

  async switchModel(ctx: ExtensionContext, modelSpec: string, thinking: string): Promise<boolean> {
    const resolved = resolveModel(modelSpec);
    const separator = resolved.indexOf("/");
    if (separator < 1) return false;
    const provider = resolved.slice(0, separator);
    const id = resolved.slice(separator + 1);
    const model = (ctx as any).modelRegistry?.find?.(provider, id)
      ?? (ctx as any).modelRegistry?.getAvailable?.().find((entry: any) => entry.provider === provider && entry.id === id);
    if (!model || typeof (this.pi as any).setModel !== "function") return false;
    await (this.pi as any).setModel(model);
    if (typeof (this.pi as any).setThinkingLevel === "function") {
      await (this.pi as any).setThinkingLevel(thinking);
    }
    return true;
  }

  /**
   * Re-route the root session onto the configured main model when its preferred
   * provider tier became usable again. Without this a session that STARTED
   * while the tier was down (its credential rejected, or the provider missing)
   * stays on the lower tier for its whole life: only the rate-limit switch-back
   * restores a model, and it never ran.
   */
  async restoreMainRouting(ctx: ExtensionContext): Promise<void> {
    const main = this.config?.agents?.main;
    // A live fallback owns the routing until its probe clears; re-resolving
    // under it would just recompute the same demoted spec anyway.
    if (!main || this.subFallbackActive || !this.routedMainSpec) return;
    const live = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (live !== this.routedMainSpec) return;
    const target = resolveModel(main.model);
    if (target === live) return;
    this.switchingBetweenRequests = true;
    try {
      if (await this.switchModel(ctx, target, main.thinking)) {
        this.routedMainSpec = target;
        getLogger().info({ s: "model", from: live, to: target }, "restored the main model after its tier became usable again");
        (ctx as any).ui?.notify?.(`Provider tier recovered; switched back to ${target}.`, "info");
      }
    } catch {} finally {
      this.switchingBetweenRequests = false;
    }
  }

  updateStatus(ctx: any): void {
    this.lastCtx = ctx;
    publishAcpState(this);
    ctx?.ui?.requestRender?.();
  }

  resetAdaptiveCompaction(): void {
    this.adaptiveCompaction = {
      nextThreshold: null,
      inFlight: false,
      pendingProactiveMeasure: false,
      disabled: false,
      modelKey: null,
      window: null,
      firedThreshold: null,
      contaminatedMeasures: 0,
      failures: 0,
    };
    this.compactionArm.armed = true;
  }

  abortAllSubagents(): void {
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    manager?.abortAll?.();
    this.spawnedAgentIds.clear();
    this.agentSpawnTimes.clear();
    this.stopStaleAgentWatchdog();
    publishAcpState(this);
  }

  stopStaleAgentWatchdog(): void {
    if (this.staleAgentTimer) clearInterval(this.staleAgentTimer);
    this.staleAgentTimer = null;
  }

  startStaleAgentWatchdog(): void {
    const staleMs = this.config.performance.internals.subagentStale;
    if (staleMs <= 0 || this.staleAgentTimer) return;
    this.staleAgentTimer = setInterval(() => {
      const currentLimit = this.config.performance.internals.subagentStale;
      if (currentLimit <= 0 || this.agentSpawnTimes.size === 0) {
        this.stopStaleAgentWatchdog();
        return;
      }
      const now = Date.now();
      for (const [id, spawnTime] of this.agentSpawnTimes) {
        if (now - spawnTime <= currentLimit) continue;
        const description = this.agentDescriptions.get(id) ?? id;
        this.pi.events.emit("subagents:rpc:stop", { requestId: crypto.randomUUID(), agentId: id });
        this.spawnedAgentIds.delete(id);
        this.agentSpawnTimes.delete(id);
        this.agentDescriptions.delete(id);
        this.pi.sendMessage({
          customType: "pp-agent-stale",
          content: `Aborted stale agent "${description}" after ${Math.round(currentLimit / 1000)}s.`,
          display: true,
        }, { deliverAs: "steer" });
      }
      if (this.agentSpawnTimes.size === 0) this.stopStaleAgentWatchdog();
      publishAcpState(this);
    }, Math.min(30_000, Math.max(1_000, staleMs)));
  }

  /** Re-evaluate the watchdog after the stale limit changed at runtime. */
  restartStaleAgentWatchdog(): void {
    this.stopStaleAgentWatchdog();
    if (this.agentSpawnTimes.size > 0) this.startStaleAgentWatchdog();
  }

  applySubagentConcurrency(): void {
    this.pi.events.emit("subagents:set-max-concurrent", { maxConcurrent: this.config.agents.maxConcurrentSubagents });
  }

  registerAgents(): void {
    const definitions: Array<{ type: string; variant: string | null; frontmatter: any; prompt: string }> = [];
    const add = (type: string, value: { frontmatter: any; prompt: string }, variant: string | null = null) => {
      definitions.push({ type, variant, frontmatter: value.frontmatter, prompt: value.prompt });
    };
    add("explore", createExploreAgent(this.config));
    add("librarian", createLibrarianAgent(this.config));
    add("task", createTaskAgent(this.config));
    const factories: Record<PoolKey, { type: string; create: (entry: PoolEntry) => { frontmatter: any; prompt: string } }> = {
      advisors: { type: "advisor", create: createAdvisorAgent },
      reviewers: { type: "reviewer", create: createReviewerAgent },
      deepDebuggers: { type: "deep-debugger", create: createDeepDebuggerAgent },
    };
    for (const [pool, factory] of Object.entries(factories) as Array<[PoolKey, typeof factories[PoolKey]]>) {
      for (const entry of this.config.agents.subagents.pools[pool]) {
        if (!isEnabled(entry)) continue;
        add(factory.type, factory.create(entry), encodePoolVariant(resolveModel(entry.model), entry.thinking));
      }
    }
    registerAgentDefinitions(this.pi, definitions);
  }

  mainAgentConfig(): { model: string; thinking: string } {
    return this.config.agents.main;
  }

  /**
   * Route the root session onto the configured main agent model/thinking.
   * Returns false (and leaves the current model alone) when the configured
   * model is not available in the registry.
   */
  async applyMainAgent(ctx: ExtensionContext): Promise<boolean> {
    const main = this.config?.agents?.main;
    if (!main) return false;
    try {
      if (!await this.switchModel(ctx, main.model, main.thinking)) return false;
      // Recorded ONLY here and in restoreMainRouting: these are the two places
      // pi-pi routes the session from the configured main model. Recording it
      // for every switchModel would also claim the rate-limit switch-back's
      // restore of the PRIOR spec — which may be a model the user picked by
      // hand, and re-resolving would then overwrite that choice.
      this.routedMainSpec = resolveModel(main.model);
      return true;
    } catch {
      return false;
    }
  }

  mainModelInfo(): ReturnType<typeof getModelInfo> {
    return getModelInfo(resolveModel(this.config.agents.main.model));
  }
}
