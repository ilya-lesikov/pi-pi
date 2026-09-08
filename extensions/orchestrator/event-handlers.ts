import { isAbsolute, relative, resolve, sep } from "path";
import { Type } from "@sinclair/typebox";
import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { getLogger, initSessionLogger, setLogLevel, flushLogs } from "./log.js";
import { initTracer, finalizeTracer, getTracer } from "./tracer.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { registerBillingHook } from "./billing-spoof.js";
import { registerRecallTool, compile as vccCompile } from "../../3p/pi-vcc/index.js";
import { computeVccMessageRange, buildVccDetails } from "./compaction-dispatch.js";
import { compactionThresholdTokens, shouldFireCompaction, shouldForceCompaction, applyBaselineMeasure } from "./compaction-trigger.js";
import { collectContextFiles, renderContextInjection, summarizeContextInjectionSize } from "./context-injection.js";
import { enabledSkillLayers, listLayeredSkills, loadLayeredSkill } from "./skills-manifest.js";
import { identityBlock, principlesBlock, toolsBlock, delegationBlock } from "./agents/tool-routing.js";
import { buildPoolRoster, getAgentConfigSnapshot, registeredAgentNames, setExtensionOnlyMode } from "./agents/registry.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive, updateRegistryFromAvailableModels } from "./model-registry.js";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, loadUsageSummary, type UsageTracker } from "./usage-tracker.js";
import { publishAcpState, resetAcpStateCache } from "./acp.js";
import { runAfterEdit } from "./commands.js";
import { checkDuplicateExtensions } from "./duplicate-extension-guard.js";
import { handleMainRateLimit, handleSubagentRateLimit, isRateLimitError } from "./rate-limit-fallback.js";
import { loadFlantSettings, refreshCopilotOAuthToken, refreshSubProvider, setModelRegistry, syncProviderTiers } from "./flant-infra.js";
import type { Orchestrator } from "./orchestrator.js";

const USAGE_TRACKER_KEY = Symbol.for("pi-pi:usage-tracker");
const HOST_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MAX_CONTINUATIONS = 3;
const MAX_OBJECTIVE_CONTINUATIONS = 5;
const CONTINUE_TRUNCATED = "[PI-PI] The previous response was truncated. Continue exactly where you stopped and complete the request.";
const CONTINUE_EMPTY = "[PI-PI] The previous turn ended without a result. Continue with the next action and complete the request.";
const CONTINUE_AMBIGUOUS = "[PI-PI] You stopped with a prose reply after taking actions. If the user's request is fully complete, state that concisely and stop. Otherwise continue with the next action without re-explaining.";
const CONTINUE_STALLED = "[PI-PI] The previous turn stalled without completing. Continue where you left off and complete the request.";

export type ContinuationDecision = "none" | "objective" | "adjudicate";

export interface RequestActivity {
  hadTools: boolean;
  toolCallCount: number;
  hadFileMutation: boolean;
}

// Trivial informational exchanges (a couple of read-only tool calls followed by
// a prose answer) must not be nudged: adjudication is only worth a model turn
// when the request actually changed something or did enough work that an
// unfinished objective is plausible.
const ADJUDICATE_TOOL_THRESHOLD = 4;

export function classifyContinuation(message: any, activity: RequestActivity): ContinuationDecision {
  if (message?.stopReason === "aborted" || message?.stopReason === "error") return "none";
  if (message?.stopReason === "length") return "objective";
  const parts = Array.isArray(message?.content) ? message.content : [];
  const hasText = parts.some((part: any) => part?.type === "text" && part.text?.trim());
  const hasToolCall = parts.some((part: any) => part?.type === "toolCall");
  if (!hasText && !hasToolCall) return "objective";
  const substantial = activity.hadFileMutation || activity.toolCallCount >= ADJUDICATE_TOOL_THRESHOLD;
  if (message?.stopReason === "stop" && hasText && activity.hadTools && substantial) return "adjudicate";
  return "none";
}

export function isMainTurnStalled(orchestrator: Orchestrator, now = Date.now()): boolean {
  const staleMs = orchestrator.config?.performance?.internals?.mainTurnStale;
  return Number.isFinite(staleMs)
    && staleMs > 0
    && orchestrator.mainTurnInFlight
    && !orchestrator.mainTurnRecovering
    && orchestrator.mainTurnToolInFlight === 0
    && !orchestrator.interactivePromptOpen
    && orchestrator.spawnedAgentIds.size === 0
    && now - orchestrator.mainTurnLastActivity >= staleMs;
}

function tracker(): UsageTracker | undefined {
  return (globalThis as any)[USAGE_TRACKER_KEY];
}

function resetRequestActivity(orchestrator: Orchestrator): void {
  orchestrator.requestHadTools = false;
  orchestrator.requestToolCallCount = 0;
  orchestrator.requestHadFileMutation = false;
}

function selectedSkills(orchestrator: Orchestrator) {
  return listLayeredSkills(orchestrator.cwd, enabledSkillLayers(orchestrator.config.skills));
}

export function renderGenericPrompt(orchestrator: Orchestrator, ctx: any, toolNames: string[]): string {
  const modelSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : orchestrator.config.agents.main.model;
  const info = getModelInfo(modelSpec);
  const contextFiles = collectContextFiles(orchestrator.cwd, orchestrator.config.contextInjection);
  const contextSize = summarizeContextInjectionSize(contextFiles);
  if (contextSize.warning) ctx.ui?.notify?.(contextSize.warning, "warning");
  const projectContext = renderContextInjection(contextFiles);
  const skills = selectedSkills(orchestrator);
  const skillManifest = skills.length === 0 ? "" : [
    "<skills>",
    "Detailed operating guidance lives in skills, loaded via load_skill. Each entry below is the skill's own description and states WHEN it applies — a hard trigger: load the skill BEFORE starting matching work. Re-load it if a compaction dropped its content.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.layer})`),
    "</skills>",
  ].join("\n");
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return [
    identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking: orchestrator.config.agents.main.thinking }),
    [
      "<constraints>",
      "- Own the request end to end. Continue autonomously until the outcome is implemented and proportionately validated, or you are blocked by missing information, permissions, or an external failure you cannot resolve.",
      "- Never report completion while validation relevant to your change fails. Distinguish failures you introduced from verified pre-existing ones.",
      "- After two failed attempts driven by the same hypothesis, stop repeating it: gather new evidence, change strategy, or delegate diagnosis.",
      "- For multi-step work keep a lightweight checklist with the task tools (TaskCreate/TaskUpdate). Do not create plan documents or wait for plan approval unless asked.",
      "- Ask the user only when required information is unavailable or plausible choices differ in user-visible behavior, compatibility, security, cost, or reversibility. For low-risk reversible ambiguity: follow repository precedent, state the assumption in one line, proceed.",
      "- Pause for the user only when proceeding would be destructive, irreversible, or picks between materially different outcomes; otherwise take the safest reversible interpretation and continue.",
      "- When reporting finished work: what was done (not why), assumptions you made that the user should know about, and anything unresolved. Quote raw output only to explain a failure.",
      "</constraints>",
    ].join("\n"),
    principlesBlock(),
    skillManifest,
    toolsBlock(toolNames),
    delegationBlock(info.family, {
      advisors: buildPoolRoster(orchestrator.config, "advisors"),
      reviewers: buildPoolRoster(orchestrator.config, "reviewers"),
      deepDebuggers: buildPoolRoster(orchestrator.config, "deepDebuggers"),
    }),
    projectContext ? `<project_context>\n${projectContext}\n</project_context>` : "",
    `<session>\nCurrent month: ${month}. Working directory: ${orchestrator.cwd}.\n</session>`,
  ].filter(Boolean).join("\n\n");
}

export function registerLoadSkill(
  pi: ExtensionAPI,
  cwd: string,
  getEnabled?: () => Orchestrator["config"]["skills"] | undefined,
  sessionSkills: Map<string, string> = loadedSkills,
): void {
  const layers = () => enabledSkillLayers(getEnabled?.());
  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description: `Load specialized guidance by name. Available: ${listLayeredSkills(cwd, layers()).map((skill) => `${skill.name} — ${skill.description}`).join("; ") || "none"}. Skill documents are stateless, reloadable, and searchable in session history.`,
    parameters: Type.Object({ name: Type.String({ description: "Skill name from the available-skills catalog." }) }),
    async execute(_id, params) {
      try {
        const skill = loadLayeredSkill(params.name, cwd, layers());
        sessionSkills.delete(skill.name);
        sessionSkills.set(skill.name, skill.document);
        return { content: [{ type: "text" as const, text: skill.document }], details: { name: skill.name, source: skill.layer, path: skill.filePath } };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: error?.message ?? String(error) }], details: undefined, isError: true };
      }
    },
  });
}

export function registerFeatureToolsAndAgents(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerCbmTools(pi, orchestrator.cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, orchestrator.cwd);
  registerRecallTool(pi);
  registerLoadSkill(pi, orchestrator.cwd, () => orchestrator.config?.skills);
  setExtensionOnlyMode(pi);
  orchestrator.registerAgents();
}

// Opt-in via config.general.tracing; getTracer() is undefined otherwise, so
// these handlers cost one property read per event when it is off.
function registerTracing(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any) => {
    getTracer()?.traceMain("before_agent_start", { prompt: event.prompt, images: event.images, systemPrompt: event.systemPrompt });
  });
  pi.on("agent_end", async (event: any) => {
    getTracer()?.traceMain("agent_end", { messages: event.messages });
  });
  pi.on("turn_start", async (event: any) => {
    const tracer = getTracer();
    if (!tracer) return;
    tracer.turnIndex = event.turnIndex;
    tracer.traceMain("turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
  });
  pi.on("turn_end", async (event: any) => {
    getTracer()?.traceMain("turn_end", { turnIndex: event.turnIndex, message: event.message, toolResults: event.toolResults });
  });
  pi.on("message_end", async (event: any) => {
    getTracer()?.traceMain("message_end", { message: event.message });
  });
  pi.on("tool_execution_start", async (event: any) => {
    getTracer()?.traceMain("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
  });
  pi.on("tool_execution_end", async (event: any) => {
    getTracer()?.traceMain("tool_execution_end", { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
  });
}

function registerLifecycle(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  // pi-subagents publishes its lifecycle on the shared event bus, not as host
  // lifecycle events, so these must go through pi.events rather than pi.on.
  pi.events.on("subagents:created", (data: any) => {
    if (data?.id) {
      orchestrator.spawnedAgentIds.add(data.id);
      orchestrator.agentDescriptions.set(data.id, data.description ?? data.type ?? data.id);
      orchestrator.agentSpawnTimes.set(data.id, Date.now());
      orchestrator.startStaleAgentWatchdog();
      getTracer()?.openSubagent({ subagentId: data.id, type: data.type, description: data.description, parentToolCallId: data.toolCallId, depth: 1 });
    }
    publishAcpState(orchestrator);
  });
  const settle = (data: any) => {
    if (data?.id) {
      orchestrator.spawnedAgentIds.delete(data.id);
      orchestrator.agentSpawnTimes.delete(data.id);
      orchestrator.agentDescriptions.delete(data.id);
      getTracer()?.traceSubagent(data.id, "subagent_settled", {
        status: data.status,
        error: data.error,
        result: data.result,
        tokens: data.tokens,
        durationMs: data.durationMs,
        toolUses: data.toolUses,
        modelId: data.modelId,
      });
    }
    if (orchestrator.agentSpawnTimes.size === 0) orchestrator.stopStaleAgentWatchdog();
    publishAcpState(orchestrator);
  };
  pi.events.on("subagents:completed", (data: any) => {
    const usage = tracker();
    if (usage && data?.tokens) {
      usage.recordSubagentCompletion(data.tokens, undefined, {
        description: data.description || data.type || data.id || "unknown",
        agentType: data.type || "unknown",
        modelId: data.modelId || "unknown",
        durationMs: data.durationMs,
        toolUses: data.toolUses,
      });
      (orchestrator.lastCtx?.ui as any)?.requestRender?.();
    }
    settle(data);
  });
  pi.events.on("subagents:failed", (data: any) => {
    settle(data);
    if (isRateLimitError(data?.error)) void handleSubagentRateLimit(orchestrator, orchestrator.lastCtx, data?.modelId);
  });
  const startMainTurnWatchdog = () => {
    if (orchestrator.mainTurnTimer) return;
    orchestrator.mainTurnTimer = setInterval(() => {
      if (!isMainTurnStalled(orchestrator)) return;
      if (orchestrator.objectiveContinuationCount >= MAX_OBJECTIVE_CONTINUATIONS) {
        orchestrator.continuationHalted = true;
        orchestrator.lastCtx?.ui?.notify?.("Automatic continuation paused after repeated stalled turns.", "warning");
        return;
      }
      orchestrator.objectiveContinuationCount++;
      orchestrator.mainTurnRecovering = true;
      orchestrator.lastCtx?.ui?.notify?.("Main turn stalled with no activity; recovering.", "warning");
      try { orchestrator.lastCtx?.abort?.(); } catch {}
      orchestrator.mainTurnInFlight = false;
      orchestrator.queueContinuation(CONTINUE_STALLED);
      publishAcpState(orchestrator);
    }, 30000);
  };
  pi.on("turn_start", async (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.mainTurnInFlight = true;
    orchestrator.mainTurnRecovering = false;
    orchestrator.mainTurnToolInFlight = 0;
    orchestrator.mainTurnLastActivity = Date.now();
    startMainTurnWatchdog();
    // Awaited: the request must not race a stale provider registration. Cheap
    // when the token is fresh (a file read + compare); a network refresh only
    // happens near expiry, exactly when waiting is required.
    try { await refreshSubProvider(pi); } catch {}
    try {
      const flant = loadFlantSettings(orchestrator.cwd);
      if (flant.copilotEnabled && !process.env.COPILOT_GITHUB_TOKEN) await refreshCopilotOAuthToken();
      // Unconditional: refreshSubProvider above may have revived a subscription
      // token that was expired when the tiers were last computed.
      syncProviderTiers(flant);
    } catch {}
    publishAcpState(orchestrator);
  });
  pi.on("tool_execution_start", (event: any) => {
    orchestrator.mainTurnToolInFlight++;
    orchestrator.requestHadTools = true;
    orchestrator.requestToolCallCount++;
    if (event?.toolName === "edit" || event?.toolName === "write" || event?.toolName === "Agent") orchestrator.requestHadFileMutation = true;
    orchestrator.mainTurnLastActivity = Date.now();
    if (event?.toolName === "ask_user") orchestrator.interactivePromptOpen = true;
  });
  pi.on("tool_execution_update", () => { orchestrator.mainTurnLastActivity = Date.now(); });
  pi.on("tool_execution_end", (event: any) => {
    orchestrator.mainTurnToolInFlight = Math.max(0, orchestrator.mainTurnToolInFlight - 1);
    orchestrator.mainTurnLastActivity = Date.now();
    if (event?.toolName === "ask_user") orchestrator.interactivePromptOpen = false;
  });
  pi.on("message_update", () => { orchestrator.mainTurnLastActivity = Date.now(); });
}

// Most recent load of each skill, in load order. After a compaction the
// summary alone would silently drop skill guidance the agent believes is
// active, so (like Claude Code) the freshest skills are re-attached to the
// summary within a token budget.
const loadedSkills = new Map<string, string>();
const SKILL_REATTACH_TOKENS_EACH = 5_000;
const SKILL_REATTACH_TOKENS_TOTAL = 25_000;

export function renderSkillReattachment(skills: Map<string, string>): string {
  if (skills.size === 0) return "";
  const parts: string[] = [];
  let budget = SKILL_REATTACH_TOKENS_TOTAL;
  for (const [name, document] of [...skills].reverse()) {
    if (budget <= 0) break;
    const cap = Math.min(SKILL_REATTACH_TOKENS_EACH, budget) * 4;
    // load_skill stores the document already wrapped in its own <skill> tag, so
    // wrapping again would nest it; truncation still has to re-close the tag.
    const tagged = document.trimStart().startsWith("<skill ");
    if (document.length <= cap) {
      parts.push(tagged ? document : `<skill name="${name}">\n${document}\n</skill>`);
      budget -= Math.ceil(document.length / 4);
      continue;
    }
    const body = `${document.slice(0, cap)}\n[… truncated]`;
    parts.push(tagged ? `${body}\n</skill>` : `<skill name="${name}">\n${body}\n</skill>`);
    budget -= Math.ceil(body.length / 4);
  }
  return [
    "",
    "[Loaded Skills]",
    "These skills were loaded before compaction and remain in effect:",
    ...parts.reverse(),
  ].join("\n");
}

// Stands in when a cut discards nothing that survives summarization, so the
// dispatcher can still own the compaction instead of yielding to the host LLM.
const EMPTY_COMPACTION_SUMMARY = "[Session Goal]\n- (nothing summarizable was discarded at this cut; use vcc_recall for earlier context)";

type CompactionState = Pick<Orchestrator,
  "pi" | "config" | "lastCtx" | "lastEstimatedTokens" | "compactionArm" | "adaptiveCompaction" | "manualCompactionUseBuiltin" | "manualCompactionPending" | "resetAdaptiveCompaction" | "redeliverPendingContinuations"
>;

// Switching providers resends the whole conversation with a cold prompt cache,
// so every retained token is billed again at the new provider. The vcc
// summarizer runs locally, so compacting first costs only the detail it folds
// away. Below this size the resend is too cheap to be worth that trade.
const MODEL_SWITCH_COMPACTION_MIN_TOKENS = 40_000;

function compactForModelSwitch(orchestrator: CompactionState, ctx: any): void {
  if (!orchestrator.config?.compaction?.enabled || typeof ctx?.compact !== "function") return;
  // The host runs one compaction at a time; starting a second one over a manual
  // or adaptive pass would have both writing compaction entries for one cut.
  if (orchestrator.adaptiveCompaction.inFlight || orchestrator.manualCompactionPending) return;
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : null;
  const tokens = usage?.tokens ?? orchestrator.lastEstimatedTokens;
  if (typeof tokens !== "number" || tokens < MODEL_SWITCH_COMPACTION_MIN_TOKENS) return;
  orchestrator.adaptiveCompaction.inFlight = true;
  getLogger().debug({ s: "compaction", tokens }, "compacting before a model switch");
  ctx.compact({
    onError: (err: any) => {
      orchestrator.adaptiveCompaction.inFlight = false;
      orchestrator.compactionArm.armed = true;
      getLogger().error({ s: "compaction", err: err?.message }, "model-switch compaction failed");
    },
  });
}

function registerCompaction(orchestrator: CompactionState, sessionSkills: Map<string, string> = loadedSkills): void {
  const pi = orchestrator.pi;
  pi.on("context", (event: any) => {
    const messages = event?.messages;
    if (!Array.isArray(messages)) return;
    orchestrator.lastEstimatedTokens = messages.reduce((sum: number, message: any) => sum + estimateTokens(message), 0);
  });
  pi.on("session_before_compact", async (event: any) => {
    const useBuiltin = orchestrator.manualCompactionUseBuiltin;
    orchestrator.manualCompactionUseBuiltin = false;
    if (useBuiltin) return;
    const prep = event.preparation;
    if (!prep) return;
    // Returning nothing (or throwing) hands the cut to the host's LLM
    // summarizer, which is exactly what this dispatcher exists to replace, so
    // every outcome below still produces a compaction. Nothing to summarize is
    // not a reason to fall back either: the host needs a compaction entry to
    // move the cut point, and would spend a model call producing one.
    let discarded: any[] = [];
    let summary = "";
    let range: [string, string] | undefined;
    let previousSummaryUsed = false;
    let tokensBefore = 0;
    try {
      previousSummaryUsed = !!prep.previousSummary;
      tokensBefore = prep.tokensBefore ?? 0;
      const history = Array.isArray(prep.messagesToSummarize) ? prep.messagesToSummarize : [];
      // On a split turn the host also discards the prefix of the turn it cut
      // through, chronologically after the history it hands over separately.
      // Summarizing only the history would drop those messages entirely.
      const turnPrefix = Array.isArray(prep.turnPrefixMessages) ? prep.turnPrefixMessages : [];
      discarded = [...history, ...turnPrefix];
      summary = vccCompile({
        messages: discarded,
        previousSummary: prep.previousSummary,
        fileOps: prep.fileOps ? { readFiles: [...(prep.fileOps.read ?? [])], modifiedFiles: [...(prep.fileOps.written ?? []), ...(prep.fileOps.edited ?? [])] } : undefined,
      });
      range = computeVccMessageRange(event.branchEntries ?? [], prep.firstKeptEntryId);
    } catch (error: any) {
      getLogger().error({ s: "compaction", err: error?.message }, "vcc summarization failed; emitting a placeholder summary");
    }
    const fullSummary = (summary || EMPTY_COMPACTION_SUMMARY) + renderSkillReattachment(sessionSkills);
    return { compaction: { summary: fullSummary, details: buildVccDetails(fullSummary, discarded.length, previousSummaryUsed, tokensBefore, range), firstKeptEntryId: prep.firstKeptEntryId, tokensBefore } };
  });
  pi.on("session_compact", (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    if (orchestrator.adaptiveCompaction.inFlight) {
      orchestrator.adaptiveCompaction.inFlight = false;
      orchestrator.adaptiveCompaction.pendingProactiveMeasure = true;
    }
    // Continuations hold off while a compaction runs and stop polling after two
    // minutes, so a long one has to hand them back rather than strand them.
    orchestrator.redeliverPendingContinuations();
  });
  pi.on("model_select", (event: any, ctx: any) => {
    if (event?.source === "restore" || !event?.previousModel || !event?.model) return;
    const before = `${event.previousModel.provider}/${event.previousModel.id}`;
    const after = `${event.model.provider}/${event.model.id}`;
    if (before === after) return;
    compactForModelSwitch(orchestrator, ctx ?? orchestrator.lastCtx);
  });
}

async function maybeCompact(orchestrator: CompactionState, ctx: any): Promise<void> {
  const cfg = orchestrator.config?.compaction;
  if (!cfg?.enabled || typeof ctx?.getContextUsage !== "function" || typeof ctx?.compact !== "function") return;
  const usage = ctx.getContextUsage();
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return;
  const modelKey = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model?.id ?? null;
  if (orchestrator.adaptiveCompaction.modelKey !== modelKey || orchestrator.adaptiveCompaction.window !== usage.contextWindow) {
    orchestrator.resetAdaptiveCompaction();
    orchestrator.adaptiveCompaction.modelKey = modelKey;
    orchestrator.adaptiveCompaction.window = usage.contextWindow;
  }
  const input = { contextWindow: usage.contextWindow, modelId: modelKey ?? undefined, config: cfg };
  const base = compactionThresholdTokens(input);
  const adaptive = orchestrator.adaptiveCompaction;
  if (adaptive.pendingProactiveMeasure && typeof usage.tokens === "number") {
    adaptive.pendingProactiveMeasure = false;
    if (applyBaselineMeasure(input, adaptive, usage.tokens).rearm) orchestrator.compactionArm.armed = true;
  }
  const effectiveThreshold = Math.max(base, adaptive.nextThreshold ?? 0);
  // Post-compaction blind window: getContextUsage() reports tokens:null until
  // a SUCCESSFUL assistant response lands after the compaction, so an error
  // storm would otherwise let context coast far past the threshold. Fall back
  // to our own chars/4 estimate against the normal threshold; the arm state
  // still bounds this to one firing until the estimate materially drops.
  const tokens = usage.tokens ?? orchestrator.lastEstimatedTokens;
  const forced = usage.tokens == null && orchestrator.lastEstimatedTokens != null && shouldForceCompaction(orchestrator.lastEstimatedTokens, usage.contextWindow);
  const fire = forced || (!adaptive.disabled && shouldFireCompaction(tokens, effectiveThreshold, orchestrator.compactionArm));
  if (!fire) return;
  if (forced) orchestrator.compactionArm.armed = false;
  adaptive.firedThreshold = effectiveThreshold;
  adaptive.inFlight = true;
  ctx.compact({
    onError: (err: any) => {
      // A failed compaction does not shrink the context, so the arm would
      // never re-arm via the lower band; re-arm here so the next turn retries.
      orchestrator.adaptiveCompaction.inFlight = false;
      orchestrator.compactionArm.armed = true;
      getLogger().error({ s: "compaction", err: err?.message }, "proactive compaction failed");
    },
  });
}

export function registerSubagentCompaction(
  pi: ExtensionAPI,
  config: Orchestrator["config"],
  sessionSkills: Map<string, string> = new Map(),
): void {
  const state: CompactionState = {
    pi,
    config,
    lastCtx: null,
    lastEstimatedTokens: null,
    compactionArm: { armed: true },
    adaptiveCompaction: {
      nextThreshold: null,
      inFlight: false,
      pendingProactiveMeasure: false,
      disabled: false,
      modelKey: null,
      window: null,
      firedThreshold: null,
      contaminatedMeasures: 0,
    },
    manualCompactionUseBuiltin: false,
    manualCompactionPending: false,
    // A worker session has no continuation queue of its own.
    redeliverPendingContinuations() {},
    resetAdaptiveCompaction() {
      state.adaptiveCompaction = {
        nextThreshold: null,
        inFlight: false,
        pendingProactiveMeasure: false,
        disabled: false,
        modelKey: null,
        window: null,
        firedThreshold: null,
        contaminatedMeasures: 0,
      };
      state.compactionArm.armed = true;
    },
  };
  registerCompaction(state, sessionSkills);
  pi.on("turn_end", async (event: any, ctx: any) => {
    state.lastCtx = ctx;
    if (event?.message?.stopReason !== "toolUse") await maybeCompact(state, ctx);
  });
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerTracing(pi);
  registerBillingHook(pi);
  registerLifecycle(orchestrator);
  registerCompaction(orchestrator);

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.cwd = ctx.cwd;
    orchestrator.interactivePromptOpen = false;
    orchestrator.manualCompactionPending = false;
    orchestrator.manualCompactionUseBuiltin = false;
    orchestrator.manualCompactionRequestId++;
    loadedSkills.clear();
    orchestrator.resetContinuation();
    resetRequestActivity(orchestrator);
    resetAcpStateCache(ctx.sessionManager?.getSessionId?.());
    (globalThis as any)[Symbol.for("pi-pi:root-session-source")] = {
      getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
      getSessionManager: () => ctx.sessionManager,
    };
    (globalThis as any)[Symbol.for("pi-pi:orchestrator-cwd")] = ctx.cwd;
    initSessionLogger(`${ctx.cwd}/.pp`, "info");
    setModelRegistry((ctx as any).modelRegistry);
    const available = (ctx as any).modelRegistry?.getAvailable?.();
    if (Array.isArray(available)) updateRegistryFromAvailableModels(available.flatMap((model: any) => model?.provider && model?.id ? [`${model.provider}/${model.id}`] : []));
    try {
      orchestrator.config = loadConfig(ctx.cwd);
      orchestrator.configError = null;
    } catch (error: any) {
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.configError = error?.message ?? String(error);
      ctx.ui?.notify?.(`Config error: ${orchestrator.configError}`, "error");
      return;
    }
    setLogLevel(orchestrator.config.general.logLevel);
    if (checkDuplicateExtensions(pi, ctx)) {
      orchestrator.duplicateExtensionError = true;
      publishAcpState(orchestrator);
      return;
    }
    orchestrator.duplicateExtensionError = false;
    try {
      const { setPI, initFlantOnStartup } = await import("./flant-infra.js");
      setPI(pi);
      await initFlantOnStartup(pi, ctx.cwd);
      orchestrator.config = loadConfig(ctx.cwd);
    } catch (error: any) {
      getLogger().error({ s: "flant", err: error?.message }, "flant initialization failed");
    }
    const usage = createUsageTracker();
    const sessionId = ctx.sessionManager?.getSessionId?.() || "";
    if (orchestrator.config.general.tracing && sessionId) initTracer(`${ctx.cwd}/.pp`, sessionId);
    if (sessionId) {
      const previous = loadUsageSummary(sessionId);
      if (previous) usage.loadFromSummary(previous);
    }
    (globalThis as any)[USAGE_TRACKER_KEY] = usage;
    setFooterContext(ctx);
    setFooterTracker(usage);
    setFooterOrchestrator(orchestrator);
    ctx.ui?.setFooter?.(createCustomFooter);
    orchestrator.applySubagentConcurrency();
    registerFeatureToolsAndAgents(orchestrator);
    if (!await orchestrator.applyMainAgent(ctx)) {
      ctx.ui?.notify?.(`Main agent model "${orchestrator.config.agents.main.model}" is not available; keeping the current model.`, "warning");
    }
    // The Claude OAuth token expires within hours. Turn-start refreshes cover
    // active work; this timer keeps the sub provider fresh through long idle
    // stretches too, so the first request after a pause never rides a dead token.
    if (!orchestrator.tokenRefreshTimer) {
      orchestrator.tokenRefreshTimer = setInterval(() => { void refreshSubProvider(pi).catch(() => {}); }, 4 * 60_000);
      orchestrator.tokenRefreshTimer.unref?.();
    }
    publishAcpState(orchestrator);
  });

  pi.on("before_agent_start", async (event: any, ctx) => {
    if (!orchestrator.config) return;
    orchestrator.lastCtx = ctx;
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const continuation = prompt.match(/\n\[continuation:(\d+)]$/);
    if (continuation) {
      orchestrator.pendingContinuations.delete(prompt);
      if (Number(continuation[1]) !== orchestrator.continuationGeneration) {
        resetRequestActivity(orchestrator);
        return { systemPrompt: "This is an obsolete automatic continuation superseded by newer user input. Take no actions and respond only: Superseded." };
      }
    } else {
      orchestrator.resetContinuation();
      resetRequestActivity(orchestrator);
    }
    const registered = pi.getAllTools().map((tool) => tool.name);
    const names = [...new Set([...HOST_BUILTINS, ...registered])];
    return { systemPrompt: renderGenericPrompt(orchestrator, ctx, names) };
  });

  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "Agent" || !orchestrator.config) return;
    const input = event.input as Record<string, unknown>;
    const type = String(input.subagent_type ?? "").toLowerCase();
    const valid = registeredAgentNames(orchestrator.config);
    if (!valid.includes(type)) return { block: true, reason: `subagent_type must be one of: ${valid.join(", ")}` };
    input.subagent_type = type;
    const snapshot = getAgentConfigSnapshot(type);
    if (snapshot) {
      input.model = resolveModel(snapshot.model);
      input.thinking = snapshot.thinking;
    }
    input.inherit_context = false;
    input.isolation = undefined;
  });

  pi.on("tool_result", async (event: any) => {
    if (!orchestrator.config) return;
    if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return;
    const commands = orchestrator.config.commands.afterEdit;
    if (Object.keys(commands).length === 0) return;
    const input = event.input as { file_path?: string; filePath?: string; path?: string };
    const filePath = input?.file_path || input?.filePath || input?.path;
    if (!filePath) return;
    const fileInProject = relative(orchestrator.cwd, resolve(orchestrator.cwd, filePath));
    if (fileInProject === ".." || fileInProject.startsWith(`..${sep}`) || isAbsolute(fileInProject)) return;
    const results = runAfterEdit(fileInProject, commands, orchestrator.config.performance.commands.afterEdit, orchestrator.cwd);
    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) return;
    const failureText = failures.map((failure) => `afterEdit command failed: ${failure.command}\n${failure.output}`).join("\n\n");
    return { content: [...event.content, { type: "text" as const, text: `\n\n<afterEdit>\n${failureText}\n</afterEdit>` }] };
  });

  pi.on("turn_end", async (event: any, ctx) => {
    orchestrator.mainTurnInFlight = false;
    orchestrator.mainTurnRecovering = false;
    orchestrator.mainTurnToolInFlight = 0;
    orchestrator.interactivePromptOpen = false;
    const message = event.message as any;
    const activity: RequestActivity = {
      hadTools: orchestrator.requestHadTools,
      toolCallCount: orchestrator.requestToolCallCount,
      hadFileMutation: orchestrator.requestHadFileMutation,
    };
    const usage = tracker();
    if (usage && message?.usage) {
      usage.recordTurn(message.model ?? ctx.model?.id ?? "unknown", message.provider ?? ctx.model?.provider ?? "unknown", message.usage.input ?? 0, message.usage.output ?? 0, message.usage.cacheRead ?? 0, message.usage.cacheWrite ?? 0, message.usage.cost?.total ?? 0, typeof message.usage.cacheRead === "number" || typeof message.usage.cacheWrite === "number");
    }
    publishAcpState(orchestrator);
    if (message?.stopReason !== "toolUse") await maybeCompact(orchestrator, ctx);
    if (message?.stopReason === "error" && isRateLimitError(message?.errorMessage)) {
      await handleMainRateLimit(orchestrator, ctx, message?.model ?? ctx.model?.id, message?.provider ?? ctx.model?.provider);
      return;
    }
    if (orchestrator.spawnedAgentIds.size > 0) return;
    const decision = classifyContinuation(message, activity);
    if (decision === "none" || orchestrator.continuationHalted) return;
    if (decision === "objective") {
      if (orchestrator.objectiveContinuationCount >= MAX_OBJECTIVE_CONTINUATIONS) {
        orchestrator.continuationHalted = true;
        ctx.ui?.notify?.("Automatic continuation paused after repeated empty or truncated turns.", "warning");
        return;
      }
      orchestrator.objectiveContinuationCount++;
      orchestrator.queueContinuation(message?.stopReason === "length" ? CONTINUE_TRUNCATED : CONTINUE_EMPTY);
      return;
    }
    if (orchestrator.continuationCount >= MAX_CONTINUATIONS) {
      orchestrator.continuationHalted = true;
      ctx.ui?.notify?.("Automatic continuation paused after repeated prose-only stops.", "warning");
      return;
    }
    orchestrator.continuationCount++;
    resetRequestActivity(orchestrator);
    orchestrator.queueContinuation(CONTINUE_AMBIGUOUS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    orchestrator.interactivePromptOpen = false;
    try {
      const usage = tracker();
      const sessionId = ctx.sessionManager?.getSessionId?.();
      // Persisting the summary writes to disk and can fail; teardown below must
      // still run or a session switch inherits this session's timers and globals.
      if (usage && sessionId) dumpUsageSummary(usage, sessionId);
    } catch (error: any) {
      getLogger().error({ s: "usage", err: error?.message }, "failed to persist the usage summary");
    } finally {
      flushLogs();
      finalizeTracer();
      delete (globalThis as any)[USAGE_TRACKER_KEY];
      if (orchestrator.mainTurnTimer) clearInterval(orchestrator.mainTurnTimer);
      if (orchestrator.staleAgentTimer) clearInterval(orchestrator.staleAgentTimer);
      if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
      if (orchestrator.idlePollTimer) clearTimeout(orchestrator.idlePollTimer);
      if (orchestrator.tokenRefreshTimer) clearInterval(orchestrator.tokenRefreshTimer);
      orchestrator.mainTurnTimer = null;
      orchestrator.staleAgentTimer = null;
      orchestrator.subSwitchBackTimer = null;
      orchestrator.idlePollTimer = null;
      orchestrator.tokenRefreshTimer = null;
      setSubscriptionFallbackActive(false);
      orchestrator.subFallbackActive = false;
      orchestrator.subFallbackModelId = null;
      orchestrator.subFallbackMainPriorSpec = null;
      orchestrator.resetContinuation();
      delete (globalThis as any)[Symbol.for("pi-pi:root-session-source")];
    }
  });
}
