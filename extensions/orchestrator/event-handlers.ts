import { isAbsolute, relative, resolve, sep } from "path";
import { Type } from "@sinclair/typebox";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getDefaultConfig, normalizeConfigDurations, readLspServerLayers } from "./config.js";
import { getLogger, initSessionLogger, setLogLevel, flushLogs } from "./log.js";
import { attachHost, notice, registerNotices } from "./notices.js";
import { initTracer, finalizeTracer, getTracer } from "./tracer.js";
import { forgetMissingCbmBin, registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { registerBillingHook } from "./billing-spoof.js";
import { OMISSION_INSTRUCTION, registerRecallTools } from "./promptcap/recall.js";
import { PromptGuard, registerPromptGuard } from "./promptcap/guard.js";
import { fileRatioStore } from "./promptcap/ratios.js";
import { collectContextFiles, renderContextInjection, summarizeContextInjectionSize } from "./context-injection.js";
import { enabledSkillLayers, listLayeredSkills, loadLayeredSkill } from "./skills-manifest.js";
import { identityBlock, principlesBlock, toolsBlock, delegationBlock } from "./agents/tool-routing.js";
import { buildPoolRoster } from "./agents/registry.js";
import { pinnedRoleSpecs, resolveRef, setCatalog } from "./routing.js";
import { createCustomFooter, setFooterContext, setFooterOrchestrator, setFooterStatus, setFooterTracker } from "./custom-footer.js";
import { createUsageTracker, dumpUsageSummary, isSubscriptionRouted, loadUsageSummary, type UsageTracker } from "./usage-tracker.js";
import { runAfterEdit } from "./commands.js";
import { registerImageShrink } from "./image-shrink.js";
import { checkDuplicateExtensions } from "./duplicate-extension-guard.js";
import { ensureProvisionDirOnPath, ensureServerForFile, provisionEagerTools } from "./provision/session.js";
import { installConsoleGuard } from "./console-guard.js";
import { clearAllPauses, demoteUnusableSubscription, handleMainAuthFailure, handleMainRateLimit, handleMainRefusal, handleSubagentAuthFailure, handleSubagentRateLimit, handleSubscriptionRouteOutage, isAuthError, isModelRefusal, isPolicyBlockError, isRateLimitError } from "./rate-limit-fallback.js";
import { adjudicateCheckIn, adjudicateContinuation } from "./continuation-adjudicator.js";
import { registerTasks } from "./tasks/index.js";
import { bashOwnedElsewhere, keepBashOffWhereItWas, registerBashGuard } from "./bash-guard.js";
import { registerBbBridge } from "./bb-bridge.js";
import { registerAskUser, registerConfirm } from "./ask/index.js";
import { LspManager } from "./lsp/manager.js";
import { editDiagnostics, registerLspTool, registerLspWarmup } from "./lsp/tool.js";
import { createWorkers, registerWorkerToolsFor, resumeOnNewRouting, WORKER_MESSAGE_TYPE, type WorkerHooks, recoveringWorkers } from "./workers/index.js";
import { pruneTranscripts, transcriptRoots } from "./workers/transcripts.js";
import { HOLD_IDLE_MS, unfinishedSummary, type HoldOutcome } from "./workers/hold.js";
import { registerWorkerUi } from "./workers/ui.js";
import type { WorkerRecord } from "./workers/types.js";
import { ensureProviderRetrySettings, patchRetryPredicate } from "./provider-retry.js";
import { loadRoutingSettings, noteSubscriptionCredentialAccepted, refreshCodexOAuthToken, refreshCopilotOAuthToken, refreshSubProvider, reviveSubscriptionCredential, setModelRegistry } from "./flant-infra.js";
import type { Orchestrator } from "./orchestrator.js";

const USAGE_TRACKER_KEY = Symbol.for("pi-pi:usage-tracker");
const BASH_BEFORE_RELOAD_KEY = Symbol.for("pi-pi:bash-before-reload");
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
    && now - orchestrator.mainTurnLastActivity >= staleMs;
}

function tracker(): UsageTracker | undefined {
  return (globalThis as any)[USAGE_TRACKER_KEY];
}

export function captureAvailableModels(ctx: any): void {
  const available = ctx?.modelRegistry?.getAvailable?.();
  // An empty list is a host refresh in flight, not a world without models:
  // adopting it would strip every provider of its catalog.
  if (!Array.isArray(available) || available.length === 0) return;
  setCatalog(available.flatMap((model: any) => model?.provider && model?.id ? [`${model.provider}/${model.id}`] : []));
}

export function mainUnavailableMessage(orchestrator: Orchestrator): string {
  const ref = orchestrator.config.agents.main.model;
  const steps = resolveRef(ref).steps;
  return [`Main model ${ref} has nothing to run on; keeping the current model.`, ...steps.slice(0, 6)].join("\n");
}

/**
 * A provider failing on its own rather than refusing this account: a 5xx, or a
 * connection that never got through, still failing after pi's own retries.
 * Only acted on for the subscription's gateway route, which has a direct route
 * to fall back to. A rejected credential is deliberately not one: it may be the
 * account's token, which rotating fixes and no other route would.
 */
function isProviderOutage(message?: string): boolean {
  return typeof message === "string"
    && /\b(500|502|503|504)\b|bad gateway|service unavailable|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);
}

/**
 * The `provider/id` a main turn ran on. The id alone is ambiguous: the
 * gateway's subscription ids carry their own `sub/` slash.
 */
function mainSpecOf(message: any, ctx: any): string {
  const provider = message?.provider ?? ctx?.model?.provider;
  const id = message?.model ?? ctx?.model?.id;
  return provider && id ? `${provider}/${id}` : "";
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

// Subagents cannot load skills themselves, so the spawn names them and they
// arrive inside the prompt, resolved through the same layers the main agent
// sees. A name that resolves to nothing, or to guidance written for the main
// agent, blocks the spawn: a worker started without the rules it was promised
// would follow none of them and say nothing.
export function preloadSkillsForSpawn(orchestrator: Orchestrator, requested: unknown): string[] | string {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== "string")) return "skills must be an array of skill names.";
  const layers = enabledSkillLayers(orchestrator.config.skills);
  const available = listLayeredSkills(orchestrator.cwd, layers);
  const shareable = available.filter((skill) => skill.audience === "any").map((skill) => skill.name);
  const documents: string[] = [];
  for (const name of [...new Set(requested as string[])]) {
    const skill = available.find((candidate) => candidate.name === name);
    if (!skill) return `Unknown skill "${name}". Skills a subagent can use: ${shareable.join(", ") || "none"}.`;
    if (skill.audience !== "any") return `Skill "${name}" is written for the main agent and cannot be given to a subagent; inline what the subagent needs instead. Skills a subagent can use: ${shareable.join(", ") || "none"}.`;
    documents.push(loadLayeredSkill(name, orchestrator.cwd, layers).document);
  }
  return documents;
}

// Front-load everything that needs the user, so they are present for
// clarification and design and absent for execution. The gate is a written
// proposal AND an ask_user call, never one alone: prose by itself only ends the
// turn, leaving the proposal to compete with the report of a finished one,
// while a bare call arrives as a demand for approval of something unstated —
// its question field is de-emphasized by design and cannot carry the substance.
function requestPhasesBlock(canAsk: boolean): string {
  const ask = canAsk
    ? "Write both out as a message, then put the decision in ONE ask_user call, and WAIT for the answer — the message carries the substance, the call holds the turn open. Always both: a proposal in prose alone just ends the turn and reads as a report, while an ask_user with nothing written above it reaches the user as a bare demand for approval, since its question field is de-emphasized and cannot carry the reasoning. Never move the substance into the question field to avoid writing the message. Several decisions go in that call's questions array, which presents them one at a time, so asking sequentially costs no extra round trip. If an answer changes the shape of the solution, propose in a second call once you have it — that is a continuation of this phase, not a check-in."
    : "State both and stop; you have no ask_user tool, so you cannot hold the turn open — do not start implementing on an unanswered question.";
  const raise = canAsk
    ? "When a decision is genuinely the user's, put it in an ask_user call."
    : "When a decision is genuinely the user's, state it and stop.";
  return [
    "<request_phases>",
    "Every request runs in three phases. The user is present for 1 and 2 and absent for 3, so everything that needs them belongs in the first two. A question is not a request: when nothing in the answer depends on this repository, this machine or this user's data — stable knowledge, a judgment call, an opinion about a design — answer it from what you know and stop. No tools, no phases.",
    "",
    "1. Clarify. Before touching anything, answer every question the request contains and resolve what would change the work: read the code, run the probes, delegate the lookups. Evidence attaches to sentences, not to requests — when a sentence you are about to write names a path, symbol, version, number or behaviour that something in front of you decides, look at that one thing before you write it: one probe per fact you would otherwise be guessing, and none at all to confirm what you already know. Never write a hedge where a single probe would settle it. Investigate only as far as the answer needs — the probe that settles the question, not the work the question is about; an investigation allowed to grow into the implementation is how an answer ends up at the bottom of a report instead of in front of them. A question the user asked is not a step on the way to the work — it is a stop. The turn in which you answer it ENDS on that answer: they react to it before implementation starts, however many other things the same message asked for. Do not answer and carry on in the same turn; do not answer and announce that you are starting; do not bury the answer in a report of work already done. If a genuine choice remains — required information you cannot obtain, or plausible options that differ in user-visible behavior, compatibility, security, cost, or reversibility — ask it in the same turn, together with the answers you already have. Do not trickle questions out across separate turns as they occur to you: everything that needs the user leaves in one turn, as early as you can get it there.",
    `2. Propose. State how you will solve it: the approach, what you will change, and anything you deliberately are not doing. A proposal is owed when the work spans more than one file, when two plausible approaches differ in something the user would see, or when the request leaves what you would change unsettled — and not otherwise: a bounded, reversible fix whose shape the request already fixes is carried out and reported, and that report is the proposal. ${ask}`,
    `3. Implement. Once approved, carry the whole thing out autonomously without further check-ins, and report at the end. Never end a turn with a question you would proceed without an answer to — a progress check, an offer to reorder your own queue, or permission for something the approval already covers costs a round trip and buys nothing. Blocking on a decision you could have taken under the safest reversible reading is the same fault as proceeding past one you could not; both spend the user, and only the second is loud about it. ${raise} Otherwise decide it under the safest reversible reading, keep going, and record the assumption in your final report.`,
    "",
    "Never answer your own question, and never act on your own answer to theirs. Once you have decided something needs the user, that decision stands: do not talk yourself into a default, and do not treat a prompt to continue as the answer. If you asked and have no answer yet, you are blocked — stop, and leave the question standing, unless pi-pi tells you the question itself was adjudicated as one you did not need answered. The same holds for a question they asked you, wherever it reached you — including as the freeform answer to your own ask_user. A question or an objection coming back through the dialogue is not a vote on your options: answer it in a message and end the turn on that answer. Do not re-ask, do not reword the options, and never put the answer in the next question field. Having answered, you are waiting on their reaction, not free to proceed because the answer happened to come out the way you expected.",
    "Collapse the phases whenever the request is a question, a lookup, or a bounded reversible fix whose shape the request already settles — or when the user told you to skip ahead. Several such items in one message are still several such items: what makes a proposal necessary is the size of the decision inside them, never the count.",
    "Return to phase 1 mid-implementation only when you discover something that invalidates the approved approach — not for a detail you can decide yourself under the safest reversible reading.",
    "</request_phases>",
  ].join("\n");
}

export function renderGenericPrompt(orchestrator: Orchestrator, ctx: any, toolNames: string[]): string {
  const info = orchestrator.mainModelInfo(ctx);
  const contextFiles = collectContextFiles(orchestrator.cwd, orchestrator.config.contextInjection);
  const contextSize = summarizeContextInjectionSize(contextFiles);
  if (contextSize.warning) notice(ctx, contextSize.warning, "warning");
  const projectContext = renderContextInjection(contextFiles);
  const skills = selectedSkills(orchestrator);
  const skillManifest = skills.length === 0 ? "" : [
    "<skills>",
    "Detailed operating guidance lives in skills, loaded via load_skill. Each entry below is the skill's own description and states WHEN it applies — a hard trigger: load the skill BEFORE starting matching work. Skill documents are stateless and reloadable.",
    ...(skills.some((skill) => skill.audience === "any") ? ["Subagents cannot load skills. Entries marked \"subagents\" can be handed to one: name them in the Agent call's skills parameter and they are preloaded into its prompt. The rest are written for you alone."] : []),
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.layer}${skill.audience === "any" ? ", subagents" : ""})`),
    "</skills>",
  ].join("\n");
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return [
    identityBlock(info, ctx?.thinkingLevel ?? orchestrator.config.agents.main.thinking),
    [
      "<constraints>",
      "- Own the request end to end. Once the request phases below have cleared, continue autonomously until the outcome is implemented and proportionately validated, or you are blocked by missing information, permissions, or an external failure you cannot resolve.",
      "- Never report completion while validation relevant to your change fails. Distinguish failures you introduced from verified pre-existing ones.",
      "- After two failed attempts driven by the same hypothesis, stop repeating it: gather new evidence, change strategy, or delegate diagnosis.",
      `- For multi-step work keep a lightweight checklist with the ${toolNames.includes("todo") ? "todo tool" : "task tools (TaskCreate/TaskUpdate)"}. Do not create plan documents.`,
      "- When reporting finished work: what was done (not why), assumptions you made that the user should know about, and anything unresolved. Quote raw output only to explain a failure.",
      "</constraints>",
    ].join("\n"),
    requestPhasesBlock(toolNames.includes("ask_user")),
    principlesBlock(),
    skillManifest,
    toolsBlock(toolNames),
    delegationBlock(info, {
      advisors: buildPoolRoster(orchestrator.config, "advisors"),
      reviewers: buildPoolRoster(orchestrator.config, "reviewers"),
      deepDebuggers: buildPoolRoster(orchestrator.config, "deepDebuggers"),
    }, skills.filter((skill) => skill.audience === "any").map((skill) => skill.name)),
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
): void {
  const layers = () => enabledSkillLayers(getEnabled?.());
  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    // Names only. Every description is already in the <skills> block of the
    // prompt, together with the rule that makes them triggers; repeating them
    // here doubled the cost of the catalog for one audience, since load_skill
    // is granted to the main agent alone.
    description: `Load specialized guidance by name. Available: ${listLayeredSkills(cwd, layers()).map((skill) => skill.name).join(", ") || "none"}. Each name's WHEN-to-load description is in the <skills> catalog in your prompt. Skill documents are stateless, reloadable, and searchable in session history.`,
    parameters: Type.Object({ name: Type.String({ description: "Skill name from the available-skills catalog." }) }),
    async execute(_id, params) {
      try {
        const skill = loadLayeredSkill(params.name, cwd, layers());
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

/**
 * Install a language server at the moment something first needs it.
 *
 * An `lsp` call is held until the install settles: letting it through early
 * would answer "no capable server" for a language pi-pi is seconds away from
 * being able to serve, and that answer is what teaches the model to stop
 * asking. Reads only warm the cache in the background — by the time an `lsp`
 * call follows, the server is usually already there.
 */
function registerLazyProvisioning(pi: ExtensionAPI): void {
  const pathOf = (input: Record<string, unknown> | undefined): string | undefined => {
    for (const key of ["filePath", "path", "file_path"]) {
      const value = input?.[key];
      if (typeof value === "string" && value.includes(".")) return value;
    }
    return undefined;
  };

  // Returns nothing on every path: a tool_call handler's result is the call's
  // patched input, and answering with an empty object would shadow a patch
  // another handler made.
  pi.on("tool_call", async (event: any) => {
    const filePath = pathOf(event?.input);
    if (!filePath) return;
    if (event.toolName === "lsp") {
      await ensureServerForFile(filePath);
      return;
    }
    if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
      void ensureServerForFile(filePath);
    }
  });
}

function registerLifecycle(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  const startMainTurnWatchdog = () => {
    if (orchestrator.mainTurnTimer) return;
    orchestrator.mainTurnTimer = setInterval(() => {
      if (!isMainTurnStalled(orchestrator)) return;
      if (orchestrator.objectiveContinuationCount >= MAX_OBJECTIVE_CONTINUATIONS) {
        orchestrator.continuationHalted = true;
        notice(orchestrator.lastCtx, "Automatic continuation paused after repeated stalled turns.", "warning");
        return;
      }
      orchestrator.objectiveContinuationCount++;
      orchestrator.mainTurnRecovering = true;
      notice(orchestrator.lastCtx, "Main turn stalled with no activity; recovering.", "warning");
      try { orchestrator.lastCtx?.abort?.(); } catch {}
      orchestrator.mainTurnInFlight = false;
      orchestrator.queueContinuation(CONTINUE_STALLED);
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
      const settings = loadRoutingSettings(orchestrator.cwd);
      if (settings.providers.copilot.enabled && !process.env.COPILOT_GITHUB_TOKEN) await refreshCopilotOAuthToken();
      if (settings.providers.codex.enabled) await refreshCodexOAuthToken();
      // A /login or an API key appearing between turns adds models after the
      // session-start snapshot was taken, for any provider an override or a pin
      // may name; pi refreshes its own availability, so this copy follows it.
      captureAvailableModels(ctx);
      // A provider that just went up or down changes which model each worker
      // definition names; the guard inside makes this a no-op when it did not.
      orchestrator.registerAgents();
    } catch {}
  });
  pi.on("tool_execution_start", (event: any) => {
    orchestrator.mainTurnToolInFlight++;
    orchestrator.requestHadTools = true;
    orchestrator.requestToolCallCount++;
    if (event?.toolName === "edit" || event?.toolName === "write") orchestrator.requestHadEdit = true;
    if (event?.toolName === "edit" || event?.toolName === "write" || event?.toolName === "Agent") orchestrator.requestHadFileMutation = true;
    orchestrator.mainTurnLastActivity = Date.now();
    if (event?.toolName === "ask_user" || event?.toolName === "confirm") orchestrator.interactivePromptOpen = true;
  });
  pi.on("tool_execution_update", () => { orchestrator.mainTurnLastActivity = Date.now(); });
  pi.on("tool_execution_end", (event: any) => {
    orchestrator.mainTurnToolInFlight = Math.max(0, orchestrator.mainTurnToolInFlight - 1);
    orchestrator.mainTurnLastActivity = Date.now();
    if (event?.toolName === "ask_user" || event?.toolName === "confirm") orchestrator.interactivePromptOpen = false;
  });
  pi.on("message_update", () => { orchestrator.mainTurnLastActivity = Date.now(); });
  // The exact messages the turn ran with, so a continuation check can replay it
  // against the same prompt prefix instead of a reconstruction.
  pi.on("context", (event: any) => {
    if (Array.isArray(event?.messages)) orchestrator.lastContextMessages = event.messages.slice();
  });
}

type PromptcapState = Pick<Orchestrator, "pi" | "config" | "lastCtx" | "promptGuard">;

/**
 * Carry out a switch parked by an earlier mid-request decision, now that the
 * turn has ended. Parked rather than taken mid-run because switching providers
 * inside a tool loop resends the whole conversation on a cold prompt cache.
 */
async function drainPendingModelSwitch(orchestrator: Orchestrator): Promise<void> {
  if (orchestrator.modelSwitchInFlight) return;
  let action = orchestrator.pendingModelSwitches.shift();
  while (action) {
    await orchestrator.runSwitchAction(action);
    action = orchestrator.pendingModelSwitches.shift();
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
    notify: (message, level) => notice(orchestrator.lastCtx, message, level),
    log: (event, message) => getLogger().debug(event, message),
    ratios: fileRatioStore(),
  });
  orchestrator.promptGuard = guard;
  registerPromptGuard(orchestrator.pi, guard);
}

export function registerSubagentPromptcap(pi: ExtensionAPI, config: Orchestrator["config"]): void {
  const state: PromptcapState = { pi, config, lastCtx: null, promptGuard: null };
  registerPromptcap(state);
  pi.on("turn_end", (_event: any, ctx: any) => { state.lastCtx = ctx; });
}

/**
 * What a worker session gets in place of the extensions the root session
 * loads: pi-pi's own tools bound to the root session, the request hooks every
 * provider call needs, and the root's language servers.
 */
export function registerWorkerExtension(orchestrator: Orchestrator, pi: ExtensionAPI): void {
  const cwd = orchestrator.cwd;
  const config = orchestrator.config;
  registerBillingHook(pi);
  registerCbmTools(pi, cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, cwd);
  const rootSession = () => (globalThis as any)[Symbol.for("pi-pi:root-session-source")];
  registerRecallTools(pi, {
    getSessionFile: () => rootSession()?.getSessionFile(),
    getSessionManager: () => rootSession()?.getSessionManager?.(),
  });
  registerLoadSkill(pi, cwd, () => config.skills);
  registerSubagentPromptcap(pi, config);
  registerImageShrink(pi, () => config.images);
  registerLspTool(pi, () => orchestrator.lsp);
  const diagnosticsAfterEdit = () => orchestrator.config?.lsp.diagnosticsAfterEdit ?? false;
  registerLspWarmup(pi, () => orchestrator.lsp, diagnosticsAfterEdit);
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!diagnosticsAfterEdit()) return;
    const diagnostics = await editDiagnostics(orchestrator.lsp, event, ctx?.signal);
    if (diagnostics) return { content: [...event.content, { type: "text" as const, text: `\n\n${diagnostics}` }] };
  });
}

/** Ends the root session's workers; nothing they would still report has a session to go to. */
/**
 * Outside the terminal, keeps a run that ended while workers are busy open
 * until their results are in it, so the host sees one turn and a run without
 * a UI does not exit and kill them. Resolves whether the caller should go on
 * to its continuation check (true: nothing left to hold for).
 */
async function holdForWorkers(orchestrator: Orchestrator, ctx: any, message: any): Promise<boolean> {
  const manager = orchestrator.workers;
  const delivery = orchestrator.workerDelivery;
  const mode = ctx?.mode;
  if (!manager || !delivery || mode === undefined || mode === "tui") return false;
  const toolCalls = Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "toolCall");
  if (message?.stopReason !== "stop" || toolCalls) return false;
  const headless = mode === "json" || mode === "print";
  orchestrator.holdingRun = true;
  let outcome: HoldOutcome;
  try {
    outcome = await orchestrator.workerHold.wait({
      manager,
      delivery,
      signal: ctx.signal,
      hasPendingMessages: () => ctx.hasPendingMessages?.() ?? false,
      recovering: recoveringWorkers,
      idleMs: headless ? HOLD_IDLE_MS.headless : HOLD_IDLE_MS.rpc,
    });
  } finally {
    orchestrator.holdingRun = false;
  }
  getLogger().debug({ s: "workers", outcome }, "held the run for workers");
  if (outcome === "settled") return true;
  if (outcome !== "idle") return false;
  if (!headless) {
    notice(ctx, "Stopped waiting for workers after 30 minutes without activity; their results will arrive with your next message.", "warning");
    return false;
  }
  const unfinished = manager.active();
  for (const record of unfinished) manager.kill(record.id, "killed", "stopped after two hours without activity in a run with no user");
  // The summary below says what they did not finish; their kill notices would only cost another turn.
  manager.markDelivered(unfinished);
  delivery.forget(unfinished.map((record) => record.id), "settled");
  await orchestrator.workerTranscripts?.drainAll().catch(() => {});
  try {
    orchestrator.pi.sendMessage({ customType: "pp-continuation", content: unfinishedSummary(unfinished), display: false }, { deliverAs: "followUp", triggerTurn: true });
  } catch {}
  return false;
}

function stopWorkers(orchestrator: Orchestrator): void {
  orchestrator.workers?.shutdown();
  orchestrator.workerDelivery?.close();
  orchestrator.workers = null;
  orchestrator.workerDelivery = null;
  orchestrator.workerTranscripts = null;
}

/** Gives the root session a fresh worker manager; the previous session's workers are killed. */
export function startWorkers(orchestrator: Orchestrator, ctx: any, hooks: WorkerHooks = createWorkerHooks(orchestrator)): void {
  stopWorkers(orchestrator);
  const workers = createWorkers(orchestrator, hooks, orchestrator.workerSessionFactory);
  orchestrator.workers = workers.manager;
  orchestrator.workerDelivery = workers.delivery;
  orchestrator.workerTranscripts = workers.transcripts;
  if (orchestrator.cwd) void pruneTranscripts(transcriptRoots(orchestrator.cwd));
  orchestrator.workerWidget?.attach(ctx);
}

function createWorkerHooks(orchestrator: Orchestrator): WorkerHooks {
  return {
    preloadSkills: (requested) => preloadSkillsForSpawn(orchestrator, requested),
    refreshDefinitions: (ctx) => {
      captureAvailableModels(ctx);
      orchestrator.registerAgents();
    },
    childExtension: (pi) => registerWorkerExtension(orchestrator, pi),
    onSettled: (record) => {
      const usage = tracker();
      const tokens = record.runUsage;
      if (usage && (tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite)) {
        usage.recordSubagentCompletion({ ...tokens, total: tokens.input + tokens.output }, undefined, {
          description: record.spec.description,
          agentType: record.spec.type,
          modelId: record.modelId,
          durationMs: (record.settledAt ?? Date.now()) - (record.startedAt ?? record.createdAt),
          toolUses: record.toolUses,
        });
        if (isSubscriptionRouted(record.modelId)) noteSubscriptionCredentialAccepted();
        (orchestrator.lastCtx?.ui as any)?.requestRender?.();
      }
    },
    onProviderFailure: (record) => recoverWorkerFromProvider(orchestrator, record),
    onChange: () => {},
    sendMessage: (message) => orchestrator.pi.sendMessage(message as any, { triggerTurn: false }),
  };
}

/**
 * A worker that died on a refused provider: move routing the way a main-turn
 * failure would, then put the worker back to work on the new tier in place.
 */
async function recoverWorkerFromProvider(orchestrator: Orchestrator, record: WorkerRecord): Promise<boolean> {
  const error = record.error;
  const ctx = orchestrator.lastCtx;
  let moved = false;
  if (isRateLimitError(error)) {
    await handleSubagentRateLimit(orchestrator, ctx, record.modelId, error);
    moved = true;
  } else if (isProviderOutage(error)) {
    moved = await handleSubscriptionRouteOutage(orchestrator, ctx, record.modelId, "subagent");
  } else if (isAuthError(error)) {
    await handleSubagentAuthFailure(orchestrator, ctx, record.modelId);
    moved = true;
  }
  const workers = orchestrator.workers;
  if (!moved || !workers) return false;
  return resumeOnNewRouting(workers, record, orchestrator.retriedSubagentIds, async (_record, spec) => {
    const session = workers.sessionOf(record.id);
    return !!session && await session.setModel(spec);
  });
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
  orchestrator.mainStatus.register(pi);
  registerNotices(pi);
  registerTracing(pi);
  registerBillingHook(pi);
  registerLazyProvisioning(pi);
  registerLifecycle(orchestrator);
  registerPromptcap(orchestrator);
  registerImageShrink(pi, () => orchestrator.config?.images);
  const workerHooks = createWorkerHooks(orchestrator);
  registerWorkerToolsFor(orchestrator, workerHooks);
  registerWorkerUi(orchestrator);
  registerBbBridge(orchestrator, registerTasks(pi, () => orchestrator.workerWidget?.restack()));
  registerAskUser(pi);
  registerConfirm(pi);
  registerBashGuard(pi, process.cwd(), {
    timeoutSec: () => Math.round((orchestrator.config?.performance?.internals?.bashTimeout ?? 0) / 1000),
    silenceMs: () => orchestrator.config?.performance?.internals?.bashSilence ?? 0,
  });
  registerLspTool(pi, () => orchestrator.lsp);
  registerLspWarmup(pi, () => orchestrator.lsp, () => orchestrator.config?.lsp.diagnosticsAfterEdit ?? false);
  pi.on("message_end", async (event: any) => {
    const message = event?.message;
    if (message?.role === "custom" && message.customType === WORKER_MESSAGE_TYPE) orchestrator.workerDelivery?.confirm(message.details?.deliveryId);
  });
  // Settled, not agent_end: a retry or a queued continuation after agent_end
  // still injects what is queued, and re-sending it then would duplicate it.
  pi.on("agent_settled", async () => {
    orchestrator.workerDelivery?.requeueUnseen();
  });

  // Whether bash was on when a reload began: the reload keeps it as it was. On
  // globalThis, since a reload loads pi-pi afresh and this closure with it.
  pi.on("session_shutdown", async (event: any) => {
    (globalThis as any)[BASH_BEFORE_RELOAD_KEY] = event?.reason === "reload" ? pi.getActiveTools().includes("bash") : undefined;
  });
  pi.on("session_start", async (event, ctx) => {
    // First, before anything can return early: pi has just turned every extension tool on.
    const bashBeforeReload = (globalThis as any)[BASH_BEFORE_RELOAD_KEY] as boolean | undefined;
    delete (globalThis as any)[BASH_BEFORE_RELOAD_KEY];
    keepBashOffWhereItWas(
      pi,
      process.argv.slice(2),
      SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? false }).getDefaultTools(),
      event.reason === "reload" ? bashBeforeReload : undefined,
    );
    orchestrator.lastCtx = ctx;
    orchestrator.cwd = ctx.cwd;
    attachHost(ctx);
    const bashOwner = bashOwnedElsewhere(pi);
    if (bashOwner) notice(ctx, `bash comes from ${bashOwner}, which loads before pi-pi: its commands get no default timeout or silence limit.`, "warning");
    orchestrator.interactivePromptOpen = false;
    // Before anything resolves a binary: a previous session's downloads are
    // already on disk, and this is what makes them visible to `which`.
    ensureProvisionDirOnPath();
    // A replaced conversation is not the one whose folds were recorded: its
    // calls would inherit tiers by id collision, or hold old ones folded.
    orchestrator.promptGuard?.reset();
    orchestrator.pendingModelSwitches = [];
    orchestrator.modelSwitchInFlight = false;
    if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
    orchestrator.modelSwitchPollTimer = null;
    orchestrator.resetContinuation();
    orchestrator.lastContextMessages = [];
    resetRequestActivity(orchestrator);
    (globalThis as any)[Symbol.for("pi-pi:root-session-source")] = {
      getSessionFile: () => ctx.sessionManager?.getSessionFile?.(),
      getSessionManager: () => ctx.sessionManager,
    };
    initSessionLogger(`${ctx.cwd}/.pp`, "info");
    // pi gives up on a turn after a handful of provider retries, and a burst of
    // connection errors outlasts them. The ceiling lives in pi's settings, out
    // of reach of any extension API, so it is raised where the user has set none.
    ensureProviderRetrySettings();
    // The ceiling is worth nothing to a status pi does not count as retryable.
    patchRetryPredicate();
    setModelRegistry((ctx as any).modelRegistry);
    try {
      orchestrator.config = loadConfig(ctx.cwd);
      orchestrator.configError = null;
    } catch (error: any) {
      orchestrator.config = normalizeConfigDurations(getDefaultConfig());
      orchestrator.configError = error?.message ?? String(error);
      notice(ctx, `Config error: ${orchestrator.configError}`, "error");
      return;
    }
    setLogLevel(orchestrator.config.general.logLevel);
    void orchestrator.lsp?.shutdown();
    orchestrator.lsp = new LspManager(ctx.cwd, () => ({ ...readLspServerLayers(ctx.cwd), trusted: ctx.isProjectTrusted?.() ?? true }));
    // Only once the log has somewhere to go, and only when a TUI owns the
    // terminal: in print and RPC mode console output IS the interface.
    if (ctx.hasUI) installConsoleGuard();
    if (checkDuplicateExtensions(pi, ctx)) {
      orchestrator.duplicateExtensionError = true;
      return;
    }
    orchestrator.duplicateExtensionError = false;
    try {
      const { setPI, initFlantOnStartup } = await import("./flant-infra.js");
      setPI(pi);
      await initFlantOnStartup(pi, ctx.cwd, pinnedRoleSpecs(orchestrator.config));
    } catch (error: any) {
      getLogger().error({ s: "flant", err: error?.message }, "provider initialization failed");
    }
    captureAvailableModels(ctx);
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
    setFooterStatus(orchestrator.mainStatus);
    ctx.ui?.setFooter?.(createCustomFooter);
    // The footer's first line says what the agent is doing; pi's own
    // "Working" row above the editor would say less, twice.
    if (ctx?.mode === undefined || ctx?.mode === "tui") ctx.ui?.setWorkingVisible?.(false);
    startWorkers(orchestrator, ctx, workerHooks);
    registerFeatureToolsAndAgents(orchestrator);
    // Never awaited: a first run downloads tens of megabytes, and a session
    // must not wait on a network to become usable. Tools whose registration
    // gates on a binary are re-offered once one actually arrives.
    void provisionEagerTools().then((installed) => {
      if (installed.length === 0) return;
      forgetMissingCbmBin();
      registerFeatureToolsAndAgents(orchestrator);
    });
    // A model pi was started with wins over the configured main model: an app
    // that picked one (bb's model menu, a script) expects to get it.
    if (!orchestrator.keepCliModel() && !await orchestrator.applyMainAgent(ctx)) {
      notice(ctx, mainUnavailableMessage(orchestrator), "warning");
    }
    // The Claude OAuth token expires within hours. Turn-start refreshes cover
    // active work; this timer keeps the sub provider fresh through long idle
    // stretches too, so the first request after a pause never rides a dead token.
    if (!orchestrator.tokenRefreshTimer) {
      orchestrator.tokenRefreshTimer = setInterval(() => { void refreshSubProvider(pi).catch(() => {}); }, 4 * 60_000);
      orchestrator.tokenRefreshTimer.unref?.();
    }
    if (sessionId) void verifySubscriptionCredential(orchestrator, ctx, sessionId);
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
      orchestrator.workerHold.touch();
    }
    const registered = pi.getAllTools().map((tool) => tool.name);
    const names = [...new Set([...HOST_BUILTINS, ...registered])];
    return { systemPrompt: renderGenericPrompt(orchestrator, ctx, names) };
  });

  // The afterEdit commands run first: a formatter they include rewrites the
  // file, and diagnostics taken before it would describe a version that is gone.
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!orchestrator.config) return;
    if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return;
    const sections: string[] = [];
    const commands = orchestrator.config.commands.afterEdit;
    const input = event.input as { file_path?: string; filePath?: string; path?: string };
    const filePath = input?.file_path || input?.filePath || input?.path;
    if (!filePath) return;
    const fileInProject = relative(orchestrator.cwd, resolve(orchestrator.cwd, filePath));
    const inProject = !(fileInProject === ".." || fileInProject.startsWith(`..${sep}`) || isAbsolute(fileInProject));
    if (inProject && Object.keys(commands).length > 0) {
      const results = runAfterEdit(fileInProject, commands, orchestrator.config.performance.commands.afterEdit, orchestrator.cwd);
      const failures = results.filter((result) => !result.ok);
      if (failures.length > 0) {
        const failureText = failures.map((failure) => `afterEdit command failed: ${failure.command}\n${failure.output}`).join("\n\n");
        sections.push(`<afterEdit>\n${failureText}\n</afterEdit>`);
      }
    }
    if (orchestrator.config.lsp.diagnosticsAfterEdit) {
      const diagnostics = await editDiagnostics(orchestrator.lsp, event, ctx?.signal);
      if (diagnostics) sections.unshift(diagnostics);
    }
    if (sections.length === 0) return;
    return { content: [...event.content, { type: "text" as const, text: `\n\n${sections.join("\n\n")}` }] };
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
    // A switch parked mid-request is carried out here, between two LLM calls.
    // Only a turn that ran to completion is drained: a truncated, empty or
    // failed one has recovery of its own below, and an error may route the
    // session itself — switching first would undo that.
    const drainable = message?.stopReason === "toolUse" || message?.stopReason === "stop";
    if (drainable) {
      // A turn that answered is the only proof the refusal has let go, and it is
      // what re-arms the cheap recovery for the next one.
      orchestrator.refusalCount = 0;
      await drainPendingModelSwitch(orchestrator);
    }
    // A mid-loop turn is never a continuation candidate.
    if (message?.stopReason === "toolUse") return;
    // Between requests only: switching providers mid-run would resend the
    // whole conversation on a cold cache from inside a tool-call chain. Not
    // after a provider failure, which the handlers below route themselves:
    // restoring first could move the session back onto the failed model.
    const providerFailure = message?.stopReason === "error"
      && (isRateLimitError(message?.errorMessage) || isProviderOutage(message?.errorMessage) || isAuthError(message?.errorMessage));
    if (!providerFailure) await orchestrator.restoreMainRouting(ctx);
    if (message?.stopReason === "error" && isRateLimitError(message?.errorMessage)) {
      await handleMainRateLimit(orchestrator, ctx, mainSpecOf(message, ctx), message?.errorMessage);
      return;
    }
    if (message?.stopReason === "error" && isProviderOutage(message?.errorMessage)) {
      const spec = mainSpecOf(message, ctx);
      if (spec && await handleSubscriptionRouteOutage(orchestrator, ctx, spec, "main")) return;
    }
    if (message?.stopReason === "error" && isAuthError(message?.errorMessage)) {
      await handleMainAuthFailure(orchestrator, ctx, mainSpecOf(message, ctx));
      return;
    }
    // Checked before the usage-policy block below, which its wording overlaps:
    // a refusal is the vendor's classifier declining to answer, and unlike a
    // policy block it is worth resending and worth routing around.
    if (message?.stopReason === "error" && isModelRefusal(message?.rawStopReason, message?.errorMessage)) {
      await handleMainRefusal(orchestrator, ctx);
      return;
    }
    // A refused payload is not a routing problem: switching models sends the
    // same content to a filter that objects to it too. The turn is nudged on
    // instead, once — a second refusal means the route around it is not there.
    if (message?.stopReason === "error" && isPolicyBlockError(message?.errorMessage)) {
      getLogger().warn({ s: "policy", err: message?.errorMessage }, "the provider blocked a request under its usage policy");
      const canRetry = !orchestrator.continuationHalted && orchestrator.objectiveContinuationCount < MAX_OBJECTIVE_CONTINUATIONS;
      if (!canRetry) {
        orchestrator.continuationHalted = true;
        notice(ctx, "The provider keeps refusing this request under its usage policy, and going round it is not working. Stopping; rephrase the task or start a new session.", "error");
        return;
      }
      notice(ctx, "The provider refused that request under its usage policy. Continuing without the content it objected to.", "warning");
      orchestrator.objectiveContinuationCount++;
      orchestrator.queueContinuation(CONTINUE_POLICY_BLOCKED, true);
      return;
    }
    const terminal = ctx?.mode === undefined || ctx?.mode === "tui";
    if (orchestrator.hasActiveWorkers() || (!terminal && ((orchestrator.workerDelivery?.pending() ?? 0) > 0 || recoveringWorkers() > 0))) {
      if (!await holdForWorkers(orchestrator, ctx, message)) return;
    }
    const decision = classifyContinuation(message, activity);
    if (decision === "none" || orchestrator.continuationHalted) return;
    if (decision === "objective") {
      if (orchestrator.objectiveContinuationCount >= MAX_OBJECTIVE_CONTINUATIONS) {
        orchestrator.continuationHalted = true;
        notice(ctx, "Automatic continuation paused after repeated empty or truncated turns.", "warning");
        return;
      }
      orchestrator.objectiveContinuationCount++;
      const text = message?.stopReason === "length" ? CONTINUE_TRUNCATED : CONTINUE_EMPTY;
      if (!orchestrator.continueInRun(ctx, text)) orchestrator.queueContinuation(text);
      return;
    }
    if (orchestrator.continuationCount >= MAX_CONTINUATIONS) {
      orchestrator.continuationHalted = true;
      notice(ctx, "Automatic continuation paused after repeated automatic resumes.", "warning");
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
    if (!orchestrator.continueInRun(ctx, nudge, true)) orchestrator.queueContinuation(nudge, true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    orchestrator.interactivePromptOpen = false;
    // A run without a UI exits right after this: what workers wrote must be on disk first.
    await orchestrator.workerTranscripts?.drainAll().catch(() => {});
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
      void orchestrator.lsp?.shutdown();
      orchestrator.lsp = null;
      delete (globalThis as any)[USAGE_TRACKER_KEY];
      if (orchestrator.mainTurnTimer) clearInterval(orchestrator.mainTurnTimer);
      clearAllPauses(orchestrator);
      if (orchestrator.idlePollTimer) clearTimeout(orchestrator.idlePollTimer);
      if (orchestrator.tokenRefreshTimer) clearInterval(orchestrator.tokenRefreshTimer);
      if (orchestrator.modelSwitchPollTimer) clearTimeout(orchestrator.modelSwitchPollTimer);
      orchestrator.mainTurnTimer = null;
      orchestrator.subSwitchBackTimer = null;
      orchestrator.idlePollTimer = null;
      orchestrator.tokenRefreshTimer = null;
      orchestrator.modelSwitchPollTimer = null;
      orchestrator.routedMainSpec = null;
      orchestrator.mainPickedByHand = false;
      // Workers die with the session that spawned them: a replaced session can
      // no longer receive what they would deliver.
      stopWorkers(orchestrator);
      orchestrator.retriedSubagentIds.clear();
      orchestrator.pendingModelSwitches = [];
      orchestrator.modelSwitchInFlight = false;
      orchestrator.resetContinuation();
      delete (globalThis as any)[Symbol.for("pi-pi:root-session-source")];
    }
  });
}
