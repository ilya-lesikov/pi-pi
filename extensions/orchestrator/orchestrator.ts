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
  continuationGeneration = 0;
  continuationCount = 0;
  objectiveContinuationCount = 0;
  continuationHalted = false;
  pendingContinuations = new Set<string>();
  lastEstimatedTokens: number | null = null;
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
  } = { nextThreshold: null, inFlight: false, pendingProactiveMeasure: false, disabled: false, modelKey: null, window: null, firedThreshold: null, contaminatedMeasures: 0 };
  manualCompactionUseBuiltin = false;
  manualCompactionPending = false;
  manualCompactionRequestId = 0;
  idlePollTimer: ReturnType<typeof setTimeout> | null = null;
  subFallbackActive = false;
  subFallbackModelId: string | null = null;
  subFallbackMainPriorSpec: string | null = null;
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
    if (typeof ctx.isIdle !== "function" || ctx.isIdle()) {
      this.safeSendUserMessage(text);
      return;
    }
    if (attempt >= 120) return;
    this.idlePollTimer = setTimeout(() => {
      this.idlePollTimer = null;
      this.sendUserMessageWhenIdle(text, generation, attempt + 1);
    }, 1000);
  }

  resetContinuation(): void {
    this.continuationGeneration++;
    this.continuationCount = 0;
    this.objectiveContinuationCount = 0;
    this.continuationHalted = false;
    this.pendingContinuations.clear();
  }

  queueContinuation(text: string): void {
    const tagged = `${text}\n[continuation:${this.continuationGeneration}]`;
    this.pendingContinuations.add(tagged);
    this.sendUserMessageWhenIdle(tagged, this.continuationGeneration);
  }

  safeSendUserMessage(text: string): void {
    try {
      this.pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      try {
        this.pi.sendUserMessage(text);
      } catch {}
    }
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
      return await this.switchModel(ctx, main.model, main.thinking);
    } catch {
      return false;
    }
  }

  mainModelInfo(): ReturnType<typeof getModelInfo> {
    return getModelInfo(resolveModel(this.config.agents.main.model));
  }
}
