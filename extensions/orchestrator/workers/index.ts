import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDefinition, registeredAgentNames, remapPoolName } from "../agents/registry.js";
import { catalogHas, resolveRef } from "../routing.js";
import { getLogger } from "../log.js";
import { getTracer } from "../tracer.js";
import type { Orchestrator } from "../orchestrator.js";
import { WorkerDelivery, WORKER_MESSAGE_TYPE } from "./delivery.js";
import { WorkerManager } from "./manager.js";
import { createChildSessionFactory } from "./session.js";
import { paseoStatus, registerWorkerTools } from "./tools.js";
import { TranscriptStore } from "./transcripts.js";
import { notice } from "../notices.js";
import type { WorkerEvent, WorkerRecord, WorkerSessionFactory, WorkerSpawnSpec } from "./types.js";

export interface WorkerHooks {
  /** Validates the spawn and returns preloaded skill documents, or a refusal. */
  preloadSkills(requested: unknown): string[] | string;
  /** Refreshes the catalog and definitions, for a model that may have become available. */
  refreshDefinitions(ctx: any): void;
  childExtension(pi: ExtensionAPI): void;
  onSettled(record: WorkerRecord): void;
  /** For a failed worker: moves routing if the provider refused it and resumes it there. Resolves whether it was resumed. */
  onProviderFailure(record: WorkerRecord): Promise<boolean>;
  onChange(): void;
  /** Sends a custom message into the root session. */
  sendMessage?(message: { customType: string; content: string; display: boolean; details: unknown }): void;
}

const RECOVERY_DECISION_MS = 30_000;

/** Failed workers whose provider recovery has not decided yet: neither active nor delivered. */
const recovering = new Set<string>();

export function recoveringWorkers(): number {
  return recovering.size;
}

const RESUME_AFTER_REROUTE = "[PI-PI] The provider that refused your last request has been routed around, and you are now on another one. Everything above is your own work — continue from where you stopped. Do not start over and do not repeat work you already finished.";

/**
 * Builds the worker manager for one root session and its tools. The manager is
 * replaced with the session: workers never outlive the root session that
 * spawned them.
 */
export function createWorkers(orchestrator: Orchestrator, hooks: WorkerHooks, createSession?: WorkerSessionFactory): { manager: WorkerManager; delivery: WorkerDelivery; transcripts: TranscriptStore | null } {
  const config = () => orchestrator.config;
  const ctx = () => orchestrator.lastCtx;
  const sessionId = ctx()?.sessionManager?.getSessionId?.();
  const transcripts = orchestrator.cwd && sessionId ? new TranscriptStore(orchestrator.cwd, sessionId, (message) => notice(ctx(), message, "warning")) : null;
  const manager = new WorkerManager({
    onMessage: (record, message) => transcripts?.append(record.id, message),
    createSession: createSession ?? createChildSessionFactory({
      cwd: orchestrator.cwd,
      modelRegistry: () => ctx()?.modelRegistry,
      systemPrompt: (spec) => systemPromptFor(spec, orchestrator.cwd),
      toolNames: (spec) => getAgentDefinition(spec.type)?.tools ?? [],
      childExtension: (pi) => hooks.childExtension(pi),
      bashTimeoutSec: () => Math.round((config()?.performance?.internals?.workerBashTimeout ?? 0) / 1000),
    }),
    maxConcurrent: () => config()?.agents?.maxConcurrentSubagents ?? 4,
    stallWarnMs: () => config()?.performance?.internals?.workerStallWarn ?? 0,
    startTimeoutMs: () => config()?.performance?.internals?.workerStartTimeout ?? 0,
    modelStaleMs: () => config()?.performance?.internals?.workerModelStale ?? 0,
    questionTimeoutMs: () => config()?.performance?.internals?.workerQuestionTimeout ?? 10 * 60_000,
  });
  const delivery = new WorkerDelivery({
    // mainTurnInFlight spans one turn; between turns and while compacting the
    // host is not idle yet cannot take a steer either, so delivery holds.
    isStreaming: () => orchestrator.mainTurnInFlight || orchestrator.holdingRun,
    // A silent result normally waits for the next prompt, which a run
    // without a UI never gets and an app turn ends before: outside the
    // terminal it goes into the run like any other.
    isHolding: () => orchestrator.holdingRun || (ctx()?.mode !== undefined && ctx()?.mode !== "tui"),
    isBusy: () => !orchestrator.mainTurnInFlight && !orchestrator.holdingRun && ctx()?.isIdle?.() === false,
    canWake: () => {
      const current = ctx();
      if (!current || orchestrator.modelSwitchInFlight || orchestrator.interactivePromptOpen) return false;
      // Outside the terminal a run nobody prompted reaches the host outside
      // any turn: results wait inside a held run, or for the next prompt.
      if (current.mode !== undefined && current.mode !== "tui") return false;
      if (typeof current.isIdle === "function" && !current.isIdle()) return false;
      if (current.hasPendingMessages?.()) return false;
      const draft = current.ui?.getEditorText?.();
      return typeof draft !== "string" || draft.trim() === "";
    },
    send: (message, options) => orchestrator.pi.sendMessage(message as any, options as any),
    now: () => Date.now(),
  });
  manager.subscribe((event) => onWorkerEvent(event, hooks, delivery, transcripts));
  return { manager, delivery, transcripts };
}

/** Running under Paseo: its pi adapter turns these into native sub-agent cards that follow the transcript. */
export function paseoCards(): boolean {
  return !!process.env.PASEO_AGENT_ID;
}

/**
 * Tells Paseo a worker's card changed. Sent only after what the worker wrote
 * so far is on disk: Paseo reads the file once more when a card turns final
 * and then stops following it. Hidden from the transcript and from the model.
 */
function paseoUpdate(record: WorkerRecord, transcripts: TranscriptStore | null, sendMessage: (message: any) => void): void {
  if (!paseoCards()) return;
  const send = () => {
    const status = paseoStatus(record.status);
    const outputFile = transcripts?.fileFor(record.id);
    try {
      sendMessage({
        customType: status === "running" ? "subagent-update" : "subagent-notification",
        content: "",
        display: false,
        details: { id: record.id, status, description: record.spec.description, ...(outputFile ? { outputFile } : {}) },
      });
    } catch {}
  };
  if (!transcripts) send();
  // Paseo reads the file once more on a final status and then stops following
  // it; a drain that timed out sends the status anyway, with the file left out
  // so the card does not claim a complete transcript.
  else void transcripts.drain(record.id).then((complete) => {
    if (!complete) transcripts.abandon(record.id);
    send();
  });
}

function onWorkerEvent(event: WorkerEvent, hooks: WorkerHooks, delivery: WorkerDelivery, transcripts: TranscriptStore | null): void {
  const { record } = event;
  switch (event.type) {
    case "created":
      transcripts?.open(record.id);
      getTracer()?.openSubagent({ subagentId: record.id, type: record.spec.type, description: record.spec.description, parentToolCallId: record.spec.parentToolCallId, depth: 1 });
      break;
    case "started":
      if (record.runs > 1) {
        transcripts?.rotate(record.id);
        paseoUpdate(record, transcripts, hooks.sendMessage ?? (() => {}));
      }
      break;
    case "settled": {
      paseoUpdate(record, transcripts, hooks.sendMessage ?? (() => {}));
      getTracer()?.traceSubagent(record.id, "subagent_settled", {
        status: record.status,
        error: record.error,
        result: record.result,
        tokens: record.runUsage,
        durationMs: (record.settledAt ?? Date.now()) - (record.startedAt ?? record.createdAt),
        toolUses: record.toolUses,
        modelId: record.modelId,
      });
      hooks.onSettled(record);
      const deliver = () => delivery.enqueue({ kind: "settled", record });
      if (record.status !== "failed" || !record.error) {
        deliver();
        break;
      }
      // Held until the routing decision: a worker resumed on another provider
      // has nothing to report yet. Bounded, so a decision that never comes
      // still lets the failure through.
      const decision = hooks.onProviderFailure(record).catch((error: any) => {
        getLogger().error({ s: "agents", id: record.id, err: error?.message }, "worker failure handling failed");
        return false;
      });
      const timeout = new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), RECOVERY_DECISION_MS).unref?.(); });
      recovering.add(record.id);
      void Promise.race([decision, timeout]).then((resumed) => {
        recovering.delete(record.id);
        if (!resumed && record.status === "failed") deliver();
      });
      break;
    }
    case "phase":
      getTracer()?.traceSubagent(record.id, "subagent_phase", { phase: event.phase, modelId: record.modelId });
      getLogger().debug({ s: "agents", id: record.id, model: record.modelId, phase: event.phase }, "worker start phase");
      return;
    case "question":
      delivery.enqueue({ kind: "question", record });
      break;
    case "stall_warning":
      delivery.enqueue({ kind: "stall", record });
      break;
  }
  hooks.onChange();
}

/**
 * Moves a worker that died on a refused provider onto the tier its role now
 * resolves to and resumes it in place, keeping its transcript. Once per worker.
 */
export async function resumeOnNewRouting(manager: WorkerManager, record: WorkerRecord, retried: Set<string>, setModel: (record: WorkerRecord, spec: string) => Promise<boolean>): Promise<boolean> {
  if (retried.has(record.id) || record.status !== "failed") return false;
  const target = getAgentDefinition(record.spec.type)?.model;
  if (!target || target === record.modelId) return false;
  if (!await setModel(record, target)) return false;
  retried.add(record.id);
  getTracer()?.traceSubagent(record.id, "subagent_retried", { from: record.modelId, to: target });
  record.modelId = target;
  record.spec = { ...record.spec, model: target };
  return manager.resume(record.id, RESUME_AFTER_REROUTE);
}

function systemPromptFor(spec: WorkerSpawnSpec, cwd: string): string {
  const definition = getAgentDefinition(spec.type);
  return [
    `<active_agent name="${spec.type}"/>`,
    "",
    "You are a pi-pi worker agent, started by a parent agent to handle one task autonomously.",
    "",
    "# Environment",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    "",
    definition?.systemPrompt ?? "",
    "",
    "<worker_channel>",
    "- Finish by calling submit_result exactly once, then end your turn. Everything the parent needs goes in it; it does not see your other messages.",
    "- report_progress shows a one-line note to the user at milestones of long work; it does not reach the parent.",
    "- ask_parent only for a decision that changes the work and that you cannot settle under the safest reversible reading; it waits for the answer.",
    "- If you are told to stop, call submit_result with status \"partial\" and what you have, immediately.",
    "</worker_channel>",
  ].join("\n");
}

export function registerWorkerToolsFor(orchestrator: Orchestrator, hooks: WorkerHooks): void {
  registerWorkerTools(orchestrator.pi, {
    manager: () => orchestrator.workers,
    transcriptFile: (id) => orchestrator.workerTranscripts?.fileFor(id),
    paseoCards,
    prepareSpawn: (params, toolCallId, ctx) => prepareSpawn(orchestrator, hooks, params, toolCallId, ctx),
    consumed: (records, kind = "settled") => {
      if (kind === "settled") orchestrator.workers?.markDelivered(records);
      orchestrator.workerDelivery?.forget(records.map((record) => record.id), kind);
    },
  });
}

function prepareSpawn(orchestrator: Orchestrator, hooks: WorkerHooks, params: { subagent_type: string; description: string; prompt: string; skills?: string[]; notify?: "wake" | "silent" }, toolCallId: string, ctx: any): WorkerSpawnSpec | string {
  if (!orchestrator.config) return "Workers are unavailable: the configuration did not load.";
  const requested = String(params.subagent_type ?? "").toLowerCase();
  const valid = registeredAgentNames(orchestrator.config);
  const type = valid.includes(requested) ? requested : remapPoolName(orchestrator.config, requested);
  if (!type) return `subagent_type must be one of: ${valid.join(", ")}`;
  let definition = getAgentDefinition(type);
  if (definition?.ref && !catalogHas(definition.model)) {
    hooks.refreshDefinitions(ctx ?? orchestrator.lastCtx);
    definition = getAgentDefinition(type);
  }
  if (!definition) return `${type} is not registered yet; try again in a moment.`;
  if (definition.ref && !catalogHas(definition.model)) {
    return `${type} has no model to run on right now (${definition.ref}):\n${resolveRef(definition.ref).steps.join("\n")}\nPick another subagent, or fix routing in /pp › Settings › Providers.`;
  }
  const preload = hooks.preloadSkills(params.skills);
  if (typeof preload === "string") return preload;
  const prompt = [...preload, String(params.prompt ?? "")].join("\n\n");
  return {
    type,
    description: String(params.description ?? type).slice(0, 120),
    prompt,
    model: definition.model,
    thinking: definition.thinking,
    notify: params.notify === "silent" ? "silent" : "wake",
    ...(type.startsWith("reviewer_") ? { resultSchema: "findings" as const } : {}),
    parentToolCallId: toolCallId,
  };
}

export { WORKER_MESSAGE_TYPE };
