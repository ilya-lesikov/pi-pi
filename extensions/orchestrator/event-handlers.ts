import { isAbsolute, relative, resolve, sep } from "path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { getLogger, initSessionLogger, setLogLevel, flushLogs } from "./log.js";
import { initTracer, finalizeTracer, getTracer } from "./tracer.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { registerBillingHook } from "./billing-spoof.js";
import { OMISSION_INSTRUCTION, registerRecallTools } from "./promptcap/recall.js";
import { PromptGuard, registerPromptGuard } from "./promptcap/guard.js";
import { collectContextFiles, renderContextInjection, summarizeContextInjectionSize } from "./context-injection.js";
import { enabledSkillLayers, listLayeredSkills, loadLayeredSkill } from "./skills-manifest.js";
import { identityBlock, principlesBlock, toolsBlock, delegationBlock } from "./agents/tool-routing.js";
import { buildPoolRoster, getAgentConfigSnapshot, registeredAgentNames, setExtensionOnlyMode } from "./agents/registry.js";
import { getModelInfo, resolveModel, setSubscriptionFallbackActive, updateRegistryFromAvailableModels } from "./model-registry.js";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, isSubscriptionRouted, loadUsageSummary, type UsageTracker } from "./usage-tracker.js";
import { publishAcpState, resetAcpStateCache } from "./acp.js";
import { runAfterEdit } from "./commands.js";
import { checkDuplicateExtensions } from "./duplicate-extension-guard.js";
import { demoteUnusableSubscription, handleMainAuthFailure, handleMainRateLimit, handleSubagentAuthFailure, handleSubagentRateLimit, isAuthError, isPolicyBlockError, isRateLimitError } from "./rate-limit-fallback.js";
import { adjudicateCheckIn, adjudicateContinuation } from "./continuation-adjudicator.js";
import { loadFlantSettings, noteSubscriptionCredentialAccepted, refreshCopilotOAuthToken, refreshSubProvider, reviveSubscriptionCredential, setModelRegistry, syncProviderTiers } from "./flant-infra.js";
import type { Orchestrator } from "./orchestrator.js";

const USAGE_TRACKER_KEY = Symbol.for("pi-pi:usage-tracker");
const HOST_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MAX_CONTINUATIONS = 3;
const MAX_OBJECTIVE_CONTINUATIONS = 5;
const CONTINUE_TRUNCATED = "[PI-PI] The previous response was truncated. Continue exactly where you stopped and complete the request.";
const CONTINUE_EMPTY = "[PI-PI] The previous turn ended without a result. Continue with the next action and complete the request.";
const CONTINUE_UNFINISHED = "[PI-PI] Continue where you left off and finish the request. Do not re-explain what you already did.";
const CONTINUE_CHECK_IN = "[PI-PI] The question you ended on was put to your own model out of band, and came back as one you did not need answered — so the rule about leaving an unanswered question standing does not apply to it. Settle it under the safest reversible reading, carry on, and record the assumption in your final report. If the decision really is the user's, ask it with ask_user: prose does not hold the turn open.";
const CONTINUE_STALLED = "[PI-PI] The previous turn stalled without completing. Continue where you left off and complete the request.";
const CONTINUE_POLICY_BLOCKED = "[PI-PI] The provider refused that request under its usage policy and returned nothing. Retrying it unchanged will be refused again — the content it objected to is still in the conversation. Carry on with the request by another route: do not reproduce, quote or reconstruct the payload it refused, and if the objectionable part was incidental to what you were doing, do the rest without it. If the whole task genuinely cannot proceed without it, say so and stop.";
const CONTINUE_COMPACTED = "[PI-PI] Context was compacted mid-task, which cut the tool loop short. Continue exactly where you left off; do not restart the work or re-report what is already done.";

export type ContinuationDecision = "none" | "objective" | "adjudicate" | "check-in";

export interface RequestActivity {
  hadTools: boolean;
  toolCallCount: number;
  hadFileMutation: boolean;
  /** A write of this session's own, which no amount of research implies. */
  hadEdit: boolean;
}

// Trivial informational exchanges (a couple of read-only tool calls followed by
// a prose answer) must not reach the continuation check: replaying the turn to
// its model is only worth it when the request actually changed something or did
// enough work that an unfinished objective is plausible.
const ADJUDICATE_TOOL_THRESHOLD = 4;

// A turn whose last words are a question handed control back. Once the request
// has written something it is under way, and such a question is as often a
// check-in the user already approved past as a decision they own, so it is
// worth a look. Anything lighter is left alone: research and delegation are
// what clarification is made of, and nudging a genuine hand-back makes the
// agent act on its own approval.
function endsWithQuestion(parts: any[]): boolean {
  const texts = parts.filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
  const last = texts[texts.length - 1]?.text ?? "";
  const lines = last.trimEnd().split("\n");
  return (lines[lines.length - 1] ?? "").trimEnd().endsWith("?");
}

export function classifyContinuation(message: any, activity: RequestActivity): ContinuationDecision {
  if (message?.stopReason === "aborted" || message?.stopReason === "error") return "none";
  if (message?.stopReason === "length") return "objective";
  const parts = Array.isArray(message?.content) ? message.content : [];
  const hasText = parts.some((part: any) => part?.type === "text" && part.text?.trim());
  const hasToolCall = parts.some((part: any) => part?.type === "toolCall");
  if (!hasText && !hasToolCall) return "objective";
  const substantial = activity.hadFileMutation || activity.toolCallCount >= ADJUDICATE_TOOL_THRESHOLD;
  const worked = message?.stopReason === "stop" && hasText && activity.hadTools;
  if (hasText && endsWithQuestion(parts)) return worked && activity.hadEdit ? "check-in" : "none";
  return worked && substantial ? "adjudicate" : "none";
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
  orchestrator.requestHadEdit = false;
}

function selectedSkills(orchestrator: Orchestrator) {
  return listLayeredSkills(orchestrator.cwd, enabledSkillLayers(orchestrator.config.skills));
}

// Front-load everything that needs the user, so they are present for
// clarification and design and absent for execution. The gate has to be an
// ask_user call: prose only ends the turn, leaving the proposal to compete with
// the report of a finished one, while the call visibly holds it open.
function requestPhasesBlock(canAsk: boolean): string {
  const ask = canAsk
    ? "Put both in ONE ask_user call and WAIT for the answer — never a prose message: a proposal in prose just ends the turn and reads as a report, while the call holds it open until the user decides. Several decisions go in that call's questions array, which presents them one at a time, so asking sequentially costs no extra round trip. If an answer changes the shape of the solution, propose in a second call once you have it — that is a continuation of this phase, not a check-in."
    : "State both and stop; you have no ask_user tool, so you cannot hold the turn open — do not start implementing on an unanswered question.";
  const raise = canAsk
    ? "When a decision is genuinely the user's, put it in an ask_user call."
    : "When a decision is genuinely the user's, state it and stop.";
  return [
    "<request_phases>",
    "Every request runs in three phases. The user is present for 1 and 2 and absent for 3, so everything that needs them belongs in the first two.",
    "",
    "1. Clarify. Before touching anything, answer every question the request contains and resolve what would change the work: read the code, run the probes, delegate the lookups. Answer from evidence, never from assumption. A question the user asked is not a step on the way to the work — it is a stop. The turn in which you answer it ENDS on that answer: they react to it before implementation starts, however many other things the same message asked for. Do not answer and carry on in the same turn; do not answer and announce that you are starting; do not bury the answer in a report of work already done. If a genuine choice remains — required information you cannot obtain, or plausible options that differ in user-visible behavior, compatibility, security, cost, or reversibility — ask it in the same turn, together with the answers you already have. Do not trickle questions out across separate turns as they occur to you: everything that needs the user leaves in one turn, as early as you can get it there.",
    `2. Propose. State how you will solve it: the approach, what you will change, and anything you deliberately are not doing. ${ask}`,
    `3. Implement. Once approved, carry the whole thing out autonomously without further check-ins, and report at the end. Never end a turn with a question you would proceed without an answer to — a progress check, an offer to reorder your own queue, or permission for something the approval already covers costs a round trip and buys nothing. ${raise} Otherwise decide it under the safest reversible reading, keep going, and record the assumption in your final report.`,
    "",
    "Never answer your own question, and never act on your own answer to theirs. Once you have decided something needs the user, that decision stands: do not talk yourself into a default, and do not treat a prompt to continue as the answer. If you asked and have no answer yet, you are blocked — stop, and leave the question standing, unless pi-pi tells you the question itself was adjudicated as one you did not need answered. The same holds for a question they asked you: having answered it, you are waiting on their reaction, not free to proceed because the answer happened to come out the way you expected.",
    "Collapse the phases only when the request is genuinely trivial (a lookup, a one-line fix, a question with no work attached) or the user told you to skip ahead. A request that spans several items is never trivial.",
    "Return to phase 1 mid-implementation only when you discover something that invalidates the approved approach — not for a detail you can decide yourself under the safest reversible reading.",
    "</request_phases>",
  ].join("\n");
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
    "Detailed operating guidance lives in skills, loaded via load_skill. Each entry below is the skill's own description and states WHEN it applies — a hard trigger: load the skill BEFORE starting matching work. Skill documents are stateless and reloadable.",
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
      "- For multi-step work keep a lightweight checklist with the task tools (TaskCreate/TaskUpdate). Do not create plan documents.",
      "- When reporting finished work: what was done (not why), assumptions you made that the user should know about, and anything unresolved. Quote raw output only to explain a failure.",
      "</constraints>",
    ].join("\n"),
    requestPhasesBlock(toolNames.includes("ask_user")),
    principlesBlock(),
    skillManifest,
    toolsBlock(toolNames),
    delegationBlock(info.family, {
      advisors: buildPoolRoster(orchestrator.config, "advisors"),
      reviewers: buildPoolRoster(orchestrator.config, "reviewers"),
      deepDebuggers: buildPoolRoster(orchestrator.config, "deepDebuggers"),
    }),
    // Explained once here rather than beside every notice: a long session folds
    // hundreds of calls, and repeating it would cost thousands of tokens out of
    // the recent tool history the folding exists to protect.
    orchestrator.config.promptcap.enabled && toolNames.includes("recall_tool_output") ? OMISSION_INSTRUCTION : "",
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
  registerRecallTools(pi);
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
    if (data?.tokens && isSubscriptionRouted(data?.modelId)) noteSubscriptionCredentialAccepted();
    settle(data);
  });
  pi.events.on("subagents:failed", (data: any) => {
    settle(data);
    if (isRateLimitError(data?.error)) void handleSubagentRateLimit(orchestrator, orchestrator.lastCtx, data?.modelId);
    else if (isAuthError(data?.error)) void handleSubagentAuthFailure(orchestrator, orchestrator.lastCtx, data?.modelId);
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
    if (event?.toolName === "edit" || event?.toolName === "write") orchestrator.requestHadEdit = true;
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
  // The exact messages the turn ran with, so a continuation check can replay it
  // against the same prompt prefix instead of a reconstruction.
  pi.on("context", (event: any) => {
    if (Array.isArray(event?.messages)) orchestrator.lastContextMessages = event.messages.slice();
  });
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

type PromptcapState = Pick<Orchestrator, "pi" | "config" | "lastCtx" | "promptGuard">;

/**
 * Carry out a switch parked by an earlier mid-request decision, now that the
 * turn has ended. Parked rather than taken mid-run because switching providers
 * inside a tool loop resends the whole conversation on a cold prompt cache.
 */
async function drainPendingModelSwitch(orchestrator: Orchestrator): Promise<void> {
  const action = orchestrator.pendingModelSwitch;
  if (!action || orchestrator.modelSwitchInFlight) return;
  orchestrator.pendingModelSwitch = null;
  orchestrator.modelSwitchInFlight = true;
  try {
    await action();
  } catch (error: any) {
    getLogger().error({ s: "model", err: error?.message }, "a parked model switch failed");
  } finally {
    orchestrator.modelSwitchInFlight = false;
    orchestrator.redeliverPendingContinuations();
  }
}

/**
 * Bounds the prompt by folding old tool traffic out of the copy on its way to
 * the provider. Nothing is cut from the session: every byte stays in the store,
 * which is what the transcript and the recall tools read.
 */
function registerPromptcap(orchestrator: PromptcapState): void {
  const guard = new PromptGuard({
    settings: () => orchestrator.config.promptcap,
    notify: (message, level) => orchestrator.lastCtx?.ui?.notify?.(message, level),
    log: (event, message) => getLogger().debug(event, message),
  });
  orchestrator.promptGuard = guard;
  registerPromptGuard(orchestrator.pi, guard);
}

export function registerSubagentPromptcap(pi: ExtensionAPI, config: Orchestrator["config"]): void {
  const state: PromptcapState = { pi, config, lastCtx: null, promptGuard: null };
  registerPromptcap(state);
  pi.on("turn_end", (_event: any, ctx: any) => { state.lastCtx = ctx; });
}

// Confirm the stored subscription credential still works before the session
// sends anything real. Deliberately not awaited by session_start: it is a
// network round trip, and every other startup step (and the user's first
// prompt) must not wait on it. Because it outlives its own turn, everything it
// observed is re-checked before it acts: the session may have been replaced by
// a /new or /resume, and the user may have picked another model meanwhile.
async function verifySubscriptionCredential(orchestrator: Orchestrator, ctx: any, sessionId: string): Promise<void> {
  const spec = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
  if (!isSubscriptionRouted(spec, ctx.model?.provider)) return;
  try {
    // Only a hard failure justifies routing away at startup; a throttled
    // rotation means one just happened and the first real request will show
    // whether it took.
    if (await reviveSubscriptionCredential(spec, orchestrator.pi) !== "failed") return;
    if (ctx.sessionManager?.getSessionId?.() !== sessionId) return;
    const live = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (live !== spec) return;
    await demoteUnusableSubscription(orchestrator, ctx, spec);
  } catch (error: any) {
    getLogger().debug({ s: "flant", err: error?.message }, "the startup subscription credential check failed");
  }
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  registerTracing(pi);
  registerBillingHook(pi);
  registerLifecycle(orchestrator);
  registerPromptcap(orchestrator);

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.lastCtx = ctx;
    orchestrator.cwd = ctx.cwd;
    orchestrator.interactivePromptOpen = false;
    // A replaced conversation is not the one whose folds were recorded: its
    // calls would inherit tiers by id collision, or hold old ones folded.
    orchestrator.promptGuard?.reset();
    orchestrator.pendingModelSwitch = null;
    orchestrator.modelSwitchInFlight = false;
    if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
    orchestrator.modelSwitchPollTimer = null;
    loadedSkills.clear();
    orchestrator.resetContinuation();
    orchestrator.lastContextMessages = [];
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
    if (sessionId) void verifySubscriptionCredential(orchestrator, ctx, sessionId);
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
      hadEdit: orchestrator.requestHadEdit,
    };
    const usage = tracker();
    if (usage && message?.usage) {
      usage.recordTurn(message.model ?? ctx.model?.id ?? "unknown", message.provider ?? ctx.model?.provider ?? "unknown", message.usage.input ?? 0, message.usage.output ?? 0, message.usage.cacheRead ?? 0, message.usage.cacheWrite ?? 0, message.usage.cost?.total ?? 0, typeof message.usage.cacheRead === "number" || typeof message.usage.cacheWrite === "number");
    }
    // A turn that produced usage on the subscription proves the credential
    // works, which re-arms the one-rotation-per-rejection guard for the next
    // genuine revocation.
    if (message?.usage && isSubscriptionRouted(message?.model ?? ctx.model?.id, message?.provider ?? ctx.model?.provider)) {
      noteSubscriptionCredentialAccepted();
    }
    publishAcpState(orchestrator);
    // A switch parked mid-request is carried out here, between two LLM calls.
    // Only a turn that ran to completion is drained: a truncated, empty or
    // failed one has recovery of its own below, and an error may route the
    // session itself — switching first would undo that.
    const drainable = message?.stopReason === "toolUse" || message?.stopReason === "stop";
    if (drainable) await drainPendingModelSwitch(orchestrator);
    // A mid-loop turn is never a continuation candidate.
    if (message?.stopReason === "toolUse") return;
    // Between requests only: switching providers mid-run would resend the
    // whole conversation on a cold cache from inside a tool-call chain.
    await orchestrator.restoreMainRouting(ctx);
    if (message?.stopReason === "error" && isRateLimitError(message?.errorMessage)) {
      await handleMainRateLimit(orchestrator, ctx, message?.model ?? ctx.model?.id, message?.provider ?? ctx.model?.provider);
      return;
    }
    if (message?.stopReason === "error" && isAuthError(message?.errorMessage)) {
      await handleMainAuthFailure(orchestrator, ctx, message?.model ?? ctx.model?.id, message?.provider ?? ctx.model?.provider);
      return;
    }
    // A refused payload is not a routing problem: switching models sends the
    // same content to a filter that objects to it too. The turn is nudged on
    // instead, once — a second refusal means the route around it is not there.
    if (message?.stopReason === "error" && isPolicyBlockError(message?.errorMessage)) {
      ctx.ui?.notify?.("The provider refused that request under its usage policy. Continuing without the content it objected to.", "warning");
      getLogger().warn({ s: "policy", err: message?.errorMessage }, "the provider blocked a request under its usage policy");
      if (!orchestrator.continuationHalted && orchestrator.objectiveContinuationCount < MAX_OBJECTIVE_CONTINUATIONS) {
        orchestrator.objectiveContinuationCount++;
        orchestrator.queueContinuation(CONTINUE_POLICY_BLOCKED, true);
      }
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
      ctx.ui?.notify?.("Automatic continuation paused after repeated automatic resumes.", "warning");
      return;
    }
    // Both stops are replayed to their own model rather than nudged on
    // suspicion: a prose stop after real work is as often a finished report as
    // an abandoned one, a closing question as often a decision the user owns as
    // a courtesy check-in, and only the model that ran the turn can tell.
    const generation = orchestrator.continuationGeneration;
    const nudge = decision === "check-in"
      ? await adjudicateCheckIn(pi, ctx, orchestrator.lastContextMessages, message) && CONTINUE_CHECK_IN
      : await adjudicateContinuation(pi, ctx, orchestrator.lastContextMessages, message) && CONTINUE_UNFINISHED;
    if (!nudge || generation !== orchestrator.continuationGeneration || orchestrator.continuationHalted) return;
    orchestrator.continuationCount++;
    resetRequestActivity(orchestrator);
    orchestrator.queueContinuation(nudge, true);
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
      if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
      orchestrator.mainTurnTimer = null;
      orchestrator.staleAgentTimer = null;
      orchestrator.subSwitchBackTimer = null;
      orchestrator.idlePollTimer = null;
      orchestrator.tokenRefreshTimer = null;
      orchestrator.modelSwitchPollTimer = null;
      setSubscriptionFallbackActive(false);
      orchestrator.subFallbackActive = false;
      orchestrator.subFallbackModelId = null;
      orchestrator.subFallbackMainPriorSpec = null;
      orchestrator.routedMainSpec = null;
      orchestrator.pendingModelSwitch = null;
      orchestrator.modelSwitchInFlight = false;
      orchestrator.resetContinuation();
      delete (globalThis as any)[Symbol.for("pi-pi:root-session-source")];
    }
  });
}
