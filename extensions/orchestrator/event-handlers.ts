import { isAbsolute, relative, resolve, sep } from "path";
import { Type } from "@sinclair/typebox";
import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { getLogger, initSessionLogger, setLogLevel, flushLogs } from "./log.js";
import { initTracer, finalizeTracer } from "./tracer.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { registerBillingHook } from "./billing-spoof.js";
import { registerRecallTool, compile as vccCompile } from "../../3p/pi-vcc/index.js";
import { computeVccMessageRange, buildVccDetails } from "./compaction-dispatch.js";
import { compactionThresholdTokens, shouldFireCompaction, shouldForceCompaction, adaptiveNextThreshold, wouldThrash } from "./compaction-trigger.js";
import { collectContextFiles, renderContextInjection, summarizeContextInjectionSize } from "./context-injection.js";
import { listLayeredSkills, loadLayeredSkill } from "./skills-manifest.js";
import { identityBlock, principlesBlock, toolsBlock, delegationBlock } from "./agents/tool-routing.js";
import { buildPoolRoster, getAgentConfigSnapshot, registeredAgentNames, setExtensionOnlyMode } from "./agents/registry.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive, updateRegistryFromAvailableModels } from "./model-registry.js";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, loadUsageSummary, type UsageTracker } from "./usage-tracker.js";
import { publishAcpState, resetAcpStateCache } from "./acp.js";
import { runAfterEdit } from "./commands.js";
import { checkDuplicateExtensions } from "./duplicate-extension-guard.js";
import { handleMainRateLimit, handleSubagentRateLimit, isRateLimitError } from "./rate-limit-fallback.js";
import { refreshSubProvider } from "./flant-infra.js";
import { SUBAGENT_SESSION_KEY } from "./index.js";
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
  const enabled = orchestrator.config.skills;
  return listLayeredSkills(orchestrator.cwd).filter((skill) =>
    (skill.layer === "bundled" && enabled.loadBundled)
    || (skill.layer === "global" && enabled.loadGlobal)
    || (skill.layer === "project" && enabled.loadProject));
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
    "Specialized guidance is available through load_skill. Load a relevant skill before substantial unfamiliar or consequential work; reload it whenever its details are no longer salient.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.layer})`),
    "</skills>",
  ].join("\n");
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return [
    identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking: orchestrator.config.agents.main.thinking }),
    "<constraints>\nWork directly in this initial, restorable session. There are no task modes, phases, mandatory plans, artifacts, or automatic review loops. Own long-running work here and continue autonomously until the request is actually complete. Minimize user intervention: ask only when unavailable information or user preference controls a consequential decision, primarily during clarification, research, or design. Use specialists only for bounded parallel work, independent judgment, focused retrieval, or isolation. Do not invent domain-specific workflow; let the work determine which skills and capabilities to load.\n</constraints>",
    principlesBlock(),
    toolsBlock(toolNames),
    delegationBlock(info.family, {
      advisors: buildPoolRoster(orchestrator.config, "advisors"),
      reviewers: buildPoolRoster(orchestrator.config, "reviewers"),
      deepDebuggers: buildPoolRoster(orchestrator.config, "deepDebuggers"),
    }),
    projectContext ? `<project_context>\n${projectContext}\n</project_context>` : "",
    skillManifest,
    `<session>\nCurrent month: ${month}. Working directory: ${orchestrator.cwd}. This conversation and its tool activity are durable through native session restore and searchable with vcc_recall. Prefer current observed state and newer explicit user decisions over older recalled material.\n</session>`,
  ].filter(Boolean).join("\n\n");
}

export function registerLoadSkill(pi: ExtensionAPI, cwd: string, getEnabled?: () => Orchestrator["config"]["skills"] | undefined): void {
  const available = () => {
    const enabled = getEnabled?.();
    return listLayeredSkills(cwd).filter((skill) => !enabled
      || (skill.layer === "bundled" && enabled.loadBundled)
      || (skill.layer === "global" && enabled.loadGlobal)
      || (skill.layer === "project" && enabled.loadProject));
  };
  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description: `Load specialized guidance by name. Available: ${available().map((skill) => `${skill.name} — ${skill.description}`).join("; ") || "none"}. Skill documents are stateless, reloadable, and searchable in session history.`,
    parameters: Type.Object({ name: Type.String({ description: "Skill name from the available-skills catalog." }) }),
    async execute(_id, params) {
      try {
        const skill = loadLayeredSkill(params.name, cwd);
        if (!available().some((candidate) => candidate.name === skill.name)) throw new Error(`Skill "${params.name}" is disabled by its source-layer setting.`);
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

function registerLifecycle(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  pi.on("subagents:created" as any, (data: any) => {
    if (data?.id) {
      orchestrator.spawnedAgentIds.add(data.id);
      orchestrator.agentDescriptions.set(data.id, data.description ?? data.type ?? data.id);
      orchestrator.agentSpawnTimes.set(data.id, Date.now());
    }
    publishAcpState(orchestrator);
  });
  const settle = (data: any) => {
    if (data?.id) orchestrator.spawnedAgentIds.delete(data.id);
    publishAcpState(orchestrator);
  };
  pi.on("subagents:completed" as any, settle);
  pi.on("subagents:failed" as any, (data: any) => {
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

function registerCompaction(orchestrator: Orchestrator): void {
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
    if (!prep || !Array.isArray(prep.messagesToSummarize) || prep.messagesToSummarize.length === 0) return;
    const summary = vccCompile({
      messages: prep.messagesToSummarize,
      previousSummary: prep.previousSummary,
      fileOps: prep.fileOps ? { readFiles: [...(prep.fileOps.read ?? [])], modifiedFiles: [...(prep.fileOps.written ?? []), ...(prep.fileOps.edited ?? [])] } : undefined,
    });
    const range = computeVccMessageRange(event.branchEntries ?? [], prep.firstKeptEntryId);
    return { compaction: { summary, details: buildVccDetails(summary, prep.messagesToSummarize.length, !!prep.previousSummary, prep.tokensBefore ?? 0, range), firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore ?? 0 } };
  });
  pi.on("session_compact", (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    if (orchestrator.adaptiveCompaction.inFlight) {
      orchestrator.adaptiveCompaction.inFlight = false;
      orchestrator.adaptiveCompaction.pendingProactiveMeasure = true;
    }
  });
}

async function maybeCompact(orchestrator: Orchestrator, ctx: any): Promise<void> {
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
    if (wouldThrash(input, usage.tokens)) adaptive.disabled = true;
    else adaptive.nextThreshold = Math.max(base, adaptive.nextThreshold ?? 0, adaptiveNextThreshold(input, usage.tokens));
  }
  const forced = usage.tokens == null && orchestrator.lastEstimatedTokens != null && shouldForceCompaction(orchestrator.lastEstimatedTokens, usage.contextWindow);
  const fire = forced || (!adaptive.disabled && shouldFireCompaction(usage.tokens, Math.max(base, adaptive.nextThreshold ?? 0), orchestrator.compactionArm));
  if (!fire) return;
  if (forced) orchestrator.compactionArm.armed = false;
  adaptive.inFlight = true;
  ctx.compact({ onError: () => { orchestrator.adaptiveCompaction.inFlight = false; } });
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerBillingHook(pi);
  registerLifecycle(orchestrator);
  registerCompaction(orchestrator);

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.cwd = ctx.cwd;
    orchestrator.interactivePromptOpen = false;
    orchestrator.resetContinuation();
    resetRequestActivity(orchestrator);
    resetAcpStateCache(ctx.sessionManager?.getSessionId?.());
    (globalThis as any)[Symbol.for("pi-pi:root-session-source")] = {
      getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
      getSessionManager: () => ctx.sessionManager,
    };
    (globalThis as any)[Symbol.for("pi-pi:orchestrator-cwd")] = ctx.cwd;
    initSessionLogger(`${ctx.cwd}/.pp`, "info");
    const available = (ctx as any).modelRegistry?.getAvailable?.();
    if (Array.isArray(available)) updateRegistryFromAvailableModels(available.flatMap((model: any) => model?.provider && model?.id ? [`${model.provider}/${model.id}`] : []));
    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) return;
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
    if ((globalThis as any)[SUBAGENT_SESSION_KEY] || !orchestrator.config) return;
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
    if ((globalThis as any)[SUBAGENT_SESSION_KEY] || !orchestrator.config) return;
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
    await maybeCompact(orchestrator, ctx);
    if (message?.stopReason === "error" && isRateLimitError(message?.errorMessage)) {
      await handleMainRateLimit(orchestrator, ctx, message?.model ?? ctx.model?.id, message?.provider ?? ctx.model?.provider);
      return;
    }
    if ((globalThis as any)[SUBAGENT_SESSION_KEY] || orchestrator.interactivePromptOpen || orchestrator.spawnedAgentIds.size > 0) return;
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
    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) return;
    orchestrator.interactivePromptOpen = false;
    const usage = tracker();
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (usage && sessionId) dumpUsageSummary(usage, sessionId);
    flushLogs();
    finalizeTracer();
    delete (globalThis as any)[USAGE_TRACKER_KEY];
    if (orchestrator.mainTurnTimer) clearInterval(orchestrator.mainTurnTimer);
    if (orchestrator.subSwitchBackTimer) clearTimeout(orchestrator.subSwitchBackTimer);
    if (orchestrator.idlePollTimer) clearTimeout(orchestrator.idlePollTimer);
    if (orchestrator.tokenRefreshTimer) clearInterval(orchestrator.tokenRefreshTimer);
    orchestrator.mainTurnTimer = null;
    orchestrator.subSwitchBackTimer = null;
    orchestrator.idlePollTimer = null;
    orchestrator.tokenRefreshTimer = null;
    setSubscriptionFallbackActive(false);
    orchestrator.subFallbackActive = false;
    orchestrator.subFallbackModelId = null;
    orchestrator.subFallbackMainPriorSpec = null;
    orchestrator.resetContinuation();
    delete (globalThis as any)[Symbol.for("pi-pi:root-session-source")];
  });
}
