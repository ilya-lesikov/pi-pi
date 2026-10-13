import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NormalizedPiPiConfig, PoolEntry, PoolKey } from "./config.js";
import { configureRouting, describeRef, describeSpec, isPaused, resolveRef, resolveSpec, routePauseKey, type ModelDescription } from "./routing.js";
import { setProbeRoutePolicy } from "./flant-infra.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";
import { createAdvisorAgent } from "./agents/advisor.js";
import { createReviewerAgent } from "./agents/reviewer.js";
import { createDeepDebuggerAgent } from "./agents/deep-debugger.js";
import { encodePoolVariant, registerAgentDefinitions, unregisterAgentDefinitions } from "./agents/registry.js";
import { publishAcpState } from "./acp.js";
import type { PromptGuard } from "./promptcap/guard.js";
import { getLogger } from "./log.js";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

export class Orchestrator {
  private _config!: NormalizedPiPiConfig;

  /** Setting the config also re-arms routing, which reads providers/models from it. */
  get config(): NormalizedPiPiConfig {
    return this._config;
  }

  set config(next: NormalizedPiPiConfig) {
    this._config = next;
    if (!next?.providers || !next?.models) return;
    configureRouting(next);
    setProbeRoutePolicy(next.providers["claude-sub"].route, (route) => isPaused(routePauseKey(route)));
  }
  configError: string | null = null;
  duplicateExtensionError = false;
  cwd = "";
  lastCtx: any = null;
  spawnedAgentIds = new Set<string>();
  /** Workers already put back to work on a new provider tier, retried at most once. */
  retriedSubagentIds = new Set<string>();
  /** Retries in flight; they bypass the manager's queue, so they cap themselves. */
  retryingSubagentIds = new Set<string>();
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
  /**
   * Refusals since the last turn that produced anything. The count decides
   * whether the request is resent as it was or the session leaves the vendor,
   * so it survives a user turn: the content being refused does too.
   */
  refusalCount = 0;
  pendingContinuations = new Map<string, { invisible: boolean }>();
  /** Messages of the most recent LLM call, replayed by the continuation check. */
  lastContextMessages: any[] = [];
  /** Set once the session registers one; the footer and the menu read its sizing. */
  promptGuard: PromptGuard | null = null;
  /**
   * Model switches pi-pi decided on while a request was still streaming, held
   * until a turn boundary. Switching providers mid-run resends the whole
   * conversation on a cold prompt cache from inside a tool-call chain.
   *
   * A queue, not a slot: the rate-limit machinery parks from several timers,
   * and a second one replacing the first would drop, among others, the
   * subscription probe's restore — the only code that lifts the fallback latch,
   * leaving the session pinned to the fallback tier for the rest of its life.
   */
  pendingModelSwitches: Array<() => Promise<void>> = [];
  modelSwitchPollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set while a parked switch is being carried out. Holds continuations back so
   * the resumed request runs on the model the switch lands on.
   */
  modelSwitchInFlight = false;
  idlePollTimer: ReturnType<typeof setTimeout> | null = null;
  /** The subscription model the account-pause probe sends its check to. */
  subProbeSpec: string | null = null;
  /**
   * Main-session moves a pause made, keyed by the pause, so its expiry can undo
   * exactly that: whether pi-pi owned the session's model, and whether the
   * request was left waiting rather than moved.
   */
  pausedMainRoutes = new Map<string, { from: string; to: string; owned: boolean; resume: boolean; generation: number }>();
  /**
   * The spec pi-pi last routed the root session onto. A live model still equal
   * to it is one pi-pi chose, so re-routing it is safe; anything else is the
   * user's own /model pick and must be left alone.
   */
  routedMainSpec: string | null = null;
  private agentRegistrationSignature = "";
  subSwitchBackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Expiry timers of the timed routing pauses, keyed by pause. */
  pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    // Several polling chains can be alive for one text (a redelivery does not
    // cancel the chain it overlaps), so the queue entry is the claim: whoever
    // takes it sends, the rest find it gone and stop.
    const pending = this.pendingContinuations.get(text);
    if (!pending) return;
    if (!this.modelSwitchInFlight && (typeof ctx.isIdle !== "function" || ctx.isIdle())) {
      this.pendingContinuations.delete(text);
      // Put the claim back if the host refused it, so a later redelivery can
      // still get the message out instead of losing it silently.
      if (!this.deliverContinuation(text, pending.invisible)) this.pendingContinuations.set(text, pending);
      return;
    }
    if (attempt >= 120) {
      // Give up polling, but leave the text queued: whatever was blocking it
      // redelivers on the way out.
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

  /** Whether a model switch can be carried out right now. */
  private canSwitchModelNow(ctx: any): boolean {
    if (this.modelSwitchInFlight) return false;
    return !ctx || typeof ctx.isIdle !== "function" || ctx.isIdle();
  }

  /**
   * Carry out a model switch pi-pi owns, but never from inside a live request:
   * a streaming session parks it for the next turn boundary instead.
   */
  async runModelSwitchBetweenTurns(action: () => Promise<void>): Promise<void> {
    if (!this.canSwitchModelNow(this.lastCtx)) {
      this.pendingModelSwitches.push(action);
      this.pollPendingModelSwitch();
      return;
    }
    await this.runSwitchAction(action);
  }

  /**
   * Carry out one switch under the in-flight flag, whichever path reached it.
   * The flag is what holds continuations back until the session is on the model
   * the switch lands on, and what keeps a second path from switching underneath
   * this one while it awaits.
   */
  async runSwitchAction(action: () => Promise<void>): Promise<void> {
    this.modelSwitchInFlight = true;
    try {
      await action();
    } catch (error: any) {
      getLogger().error({ s: "model", err: error?.message }, "a model switch failed");
    } finally {
      this.modelSwitchInFlight = false;
      this.redeliverPendingContinuations();
    }
  }

  /**
   * Backstop for a switch parked with no turn boundary left to drain it: a
   * probe that lands after the last turn_end of a request would otherwise stay
   * parked until some later request happened to end, running that one on the
   * model the switch was supposed to leave behind.
   */
  pollPendingModelSwitch(): void {
    if (this.modelSwitchPollTimer || this.pendingModelSwitches.length === 0) return;
    this.modelSwitchPollTimer = setTimeout(() => {
      this.modelSwitchPollTimer = null;
      if (this.pendingModelSwitches.length === 0) return;
      if (!this.canSwitchModelNow(this.lastCtx)) {
        this.pollPendingModelSwitch();
        return;
      }
      const action = this.pendingModelSwitches.shift()!;
      void this.runSwitchAction(action).finally(() => this.pollPendingModelSwitch());
    }, 1000);
    this.modelSwitchPollTimer.unref?.();
  }

  /**
   * Put the root session on `spec`, an exact registered model. The thinking
   * level is clamped by pi to what the model supports.
   */
  async switchModel(ctx: ExtensionContext, spec: string, thinking: string): Promise<boolean> {
    const separator = spec.indexOf("/");
    if (separator < 1) return false;
    const provider = spec.slice(0, separator);
    const id = spec.slice(separator + 1);
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
   * Re-route the root session onto what the configured main model resolves to
   * now, when that changed: a provider came back, a credential appeared, or the
   * user reordered providers or changed an override. Only a session still on
   * the model pi-pi last routed it to is moved; anything else is the user's
   * own /model pick.
   */
  async restoreMainRouting(ctx: ExtensionContext): Promise<void> {
    const main = this.config?.agents?.main;
    if (!main || !this.routedMainSpec) return;
    const live = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (live !== this.routedMainSpec) return;
    const target = resolveSpec(main.model);
    if (!target || target === live) return;
    try {
      if (await this.switchModel(ctx, target, main.thinking)) {
        this.routedMainSpec = target;
        for (const [key, moved] of this.pausedMainRoutes) if (moved.to === live) this.pausedMainRoutes.delete(key);
        getLogger().info({ s: "model", from: live, to: target }, "re-routed the main model");
        (ctx as any).ui?.notify?.(`Routing changed; switched to ${target}.`, "info");
      }
    } catch {}
  }

  updateStatus(ctx: any): void {
    this.lastCtx = ctx;
    publishAcpState(this);
    ctx?.ui?.requestRender?.();
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

  /**
   * (Re)register every agent definition from the current config, so a routing
   * change reaches the NEXT spawn: a definition carries the model it was built
   * with, and pi-subagents lets that model outrank the spawning tool call's own
   * argument — a definition left behind by a provider-tier move therefore keeps
   * sending workers to the tier that just failed.
   *
   * Idempotent, so routing paths can call it unconditionally; `force` re-emits
   * regardless, for a config reload that may have changed a prompt the signature
   * below does not cover.
   */
  registerAgents(force = false): void {
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
        add(factory.type, factory.create(entry), encodePoolVariant(entry.model, entry.thinking));
      }
    }
    const signature = definitions
      .map((d) => `${d.type}_${d.variant ?? ""}:${d.frontmatter.model}:${d.frontmatter.thinking}:${d.frontmatter.max_turns ?? ""}`)
      .join("|");
    if (!force && signature === this.agentRegistrationSignature) return;
    this.agentRegistrationSignature = signature;
    unregisterAgentDefinitions(this.pi);
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
    const resolution = resolveRef(main.model);
    if (!resolution.spec) {
      getLogger().warn({ s: "model", ref: main.model, steps: resolution.steps }, "the main model resolves to nothing");
      return false;
    }
    try {
      if (!await this.switchModel(ctx, resolution.spec, main.thinking)) return false;
      // Recorded ONLY here and by re-routing: these are the places pi-pi routes
      // the session from the configured main model. Recording it for every
      // switch would also claim a pause's restore of a model the user picked by
      // hand, and re-resolving would then overwrite that choice.
      this.routedMainSpec = resolution.spec;
      return true;
    } catch {
      return false;
    }
  }

  /** What the root session runs on: the live model, or the configured one before any is live. */
  mainModelInfo(ctx?: any): ModelDescription {
    const live = ctx?.model?.provider && ctx?.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (!live) return describeRef(this.config.agents.main.model);
    return this.routedMainSpec === live ? describeRef(this.config.agents.main.model) : describeSpec(live);
  }
}
