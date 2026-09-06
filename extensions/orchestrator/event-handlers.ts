import { Type } from "@sinclair/typebox";
import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { getLogger, initSessionLogger, setLogLevel, flushLogs } from "./log.js";
import { initTracer, finalizeTracer } from "./tracer.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerBillingHook } from "./billing-spoof.js";
import { registerRecallTool, compile as vccCompile } from "../../3p/pi-vcc/index.js";
import { computeVccMessageRange, buildVccDetails } from "./compaction-dispatch.js";
import { compactionThresholdTokens, shouldFireCompaction, shouldForceCompaction, adaptiveNextThreshold, wouldThrash } from "./compaction-trigger.js";
import { collectContextFiles, renderContextInjection, summarizeContextInjectionSize } from "./context-injection.js";
import { listLayeredSkills, loadLayeredSkill } from "./skills-manifest.js";
import { identityBlock, principlesBlock, toolsBlock, delegationBlock } from "./agents/tool-routing.js";
import { buildPoolRoster, getAgentConfigSnapshot, registeredAgentNames, setExtensionOnlyMode } from "./agents/registry.js";
import { getModelInfo, resolveModel, updateRegistryFromAvailableModels } from "./model-registry.js";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, loadUsageSummary, type UsageTracker } from "./usage-tracker.js";
import { publishAcpState } from "./acp.js";
import { SUBAGENT_SESSION_KEY } from "./index.js";
import type { Orchestrator } from "./orchestrator.js";

const USAGE_TRACKER_KEY = Symbol.for("pi-pi:usage-tracker");
const HOST_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function tracker(): UsageTracker | undefined {
  return (globalThis as any)[USAGE_TRACKER_KEY];
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
    "<constraints>\nWork directly in this initial, restorable session. There are no task modes, phases, mandatory plans, artifacts, or automatic review loops. Own long-running work here. Use specialists only for bounded parallel work, independent judgment, focused retrieval, or isolation. Do not invent domain-specific workflow; load relevant skills and use the capabilities available.\n</constraints>",
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

function registerLoadSkill(orchestrator: Orchestrator): void {
  orchestrator.pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description: "Load specialized guidance by name. Skill documents are stateless, reloadable, and searchable in session history.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name from the available-skills catalog." }) }),
    async execute(_id, params) {
      try {
        const skill = loadLayeredSkill(params.name, orchestrator.cwd);
        if (!selectedSkills(orchestrator).some((candidate) => candidate.name === skill.name)) throw new Error(`Skill "${params.name}" is disabled by its source-layer setting.`);
        return { content: [{ type: "text" as const, text: skill.document }], details: { name: skill.name, source: skill.layer, path: skill.filePath } };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: error?.message ?? String(error) }], details: undefined, isError: true };
      }
    },
  });
}

export function registerFeatureToolsAndAgents(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerCommandHandlers(orchestrator);
  registerCbmTools(pi, orchestrator.cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, orchestrator.cwd);
  registerRecallTool(pi);
  registerLoadSkill(orchestrator);
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
  pi.on("subagents:failed" as any, settle);
  pi.on("turn_start", (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.mainTurnInFlight = true;
    orchestrator.mainTurnToolInFlight = 0;
    orchestrator.mainTurnLastActivity = Date.now();
    publishAcpState(orchestrator);
  });
  pi.on("tool_execution_start", () => {
    orchestrator.mainTurnToolInFlight++;
    orchestrator.mainTurnLastActivity = Date.now();
  });
  pi.on("tool_execution_update", () => { orchestrator.mainTurnLastActivity = Date.now(); });
  pi.on("tool_execution_end", () => {
    orchestrator.mainTurnToolInFlight = Math.max(0, orchestrator.mainTurnToolInFlight - 1);
    orchestrator.mainTurnLastActivity = Date.now();
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
    publishAcpState(orchestrator);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if ((globalThis as any)[SUBAGENT_SESSION_KEY] || !orchestrator.config) return;
    orchestrator.lastCtx = ctx;
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

  pi.on("turn_end", async (event: any, ctx) => {
    orchestrator.mainTurnInFlight = false;
    orchestrator.mainTurnToolInFlight = 0;
    const message = event.message as any;
    const usage = tracker();
    if (usage && message?.usage) {
      usage.recordTurn(message.model ?? ctx.model?.id ?? "unknown", message.provider ?? ctx.model?.provider ?? "unknown", message.usage.input ?? 0, message.usage.output ?? 0, message.usage.cacheRead ?? 0, message.usage.cacheWrite ?? 0, message.usage.cost?.total ?? 0, typeof message.usage.cacheRead === "number" || typeof message.usage.cacheWrite === "number");
    }
    publishAcpState(orchestrator);
    await maybeCompact(orchestrator, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if ((globalThis as any)[SUBAGENT_SESSION_KEY]) return;
    const usage = tracker();
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (usage && sessionId) dumpUsageSummary(usage, sessionId);
    flushLogs();
    finalizeTracer();
    delete (globalThis as any)[USAGE_TRACKER_KEY];
  });
}
