import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDefinition, registeredAgentNames, remapPoolName } from "../agents/registry.js";
import { catalogHas, resolveRef } from "../routing.js";
import { getLogger } from "../log.js";
import { getTracer } from "../tracer.js";
import type { Orchestrator } from "../orchestrator.js";
import { WorkerDelivery, WORKER_MESSAGE_TYPE } from "./delivery.js";
import { WorkerManager } from "./manager.js";
import { createChildSessionFactory } from "./session.js";
import { registerWorkerTools } from "./tools.js";
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
}

const RECOVERY_DECISION_MS = 30_000;

const RESUME_AFTER_REROUTE = "[PI-PI] The provider that refused your last request has been routed around, and you are now on another one. Everything above is your own work — continue from where you stopped. Do not start over and do not repeat work you already finished.";

/**
 * Builds the worker manager for one root session and its tools. The manager is
 * replaced with the session: workers never outlive the root session that
 * spawned them.
 */
export function createWorkers(orchestrator: Orchestrator, hooks: WorkerHooks, createSession?: WorkerSessionFactory): { manager: WorkerManager; delivery: WorkerDelivery } {
  const config = () => orchestrator.config;
  const ctx = () => orchestrator.lastCtx;
  const manager = new WorkerManager({
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
    stallKillMs: () => config()?.performance?.internals?.workerStallKill ?? 0,
    questionTimeoutMs: () => config()?.performance?.internals?.workerQuestionTimeout ?? 10 * 60_000,
    graceTurns: () => 5,
  });
  const delivery = new WorkerDelivery({
    // The host's idle check also covers compaction, during which a message
    // neither steers nor starts a turn; mainTurnInFlight tracks the run alone.
    isStreaming: () => orchestrator.mainTurnInFlight,
    isBusy: () => !orchestrator.mainTurnInFlight && ctx()?.isIdle?.() === false,
    canWake: () => {
      const current = ctx();
      if (!current || orchestrator.modelSwitchInFlight || orchestrator.interactivePromptOpen) return false;
      if (typeof current.isIdle === "function" && !current.isIdle()) return false;
      if (current.hasPendingMessages?.()) return false;
      const draft = current.ui?.getEditorText?.();
      return typeof draft !== "string" || draft.trim() === "";
    },
    send: (message, options) => orchestrator.pi.sendMessage(message as any, options as any),
    now: () => Date.now(),
  });
  manager.subscribe((event) => onWorkerEvent(event, hooks, delivery));
  return { manager, delivery };
}

function onWorkerEvent(event: WorkerEvent, hooks: WorkerHooks, delivery: WorkerDelivery): void {
  const { record } = event;
  switch (event.type) {
    case "created":
      getTracer()?.openSubagent({ subagentId: record.id, type: record.spec.type, description: record.spec.description, parentToolCallId: record.spec.parentToolCallId, depth: 1 });
      break;
    case "settled": {
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
      void Promise.race([decision, timeout]).then((resumed) => { if (!resumed && record.status === "failed") deliver(); });
      break;
    }
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

export interface WorkersHandle {
  spawn(request: { type: string; description: string; prompt: string; owner: string; maxTurns?: number }): { id: string } | { error: string };
  /** Graceful stop; the worker is killed if it does not wrap up in time. */
  stop(id: string): boolean;
  status(id: string): { status: string; summary?: string; error?: string } | undefined;
  /** Subscribes to settlements; the listener sees every worker, filtered by owner on its side. */
  onSettled(listener: (settled: { id: string; owner?: string; status: string; result?: string; error?: string }) => void): () => void;
}

const WORKERS_HANDLE_KEY = Symbol.for("pi-pi:workers");

/**
 * The typed entry point other bundled extensions (pi-tasks) use to run work on
 * pi-pi's workers. Republished with each orchestrator instance; it always
 * reaches the current session's manager.
 */
export function publishWorkersHandle(orchestrator: Orchestrator, hooks: WorkerHooks): void {
  const listeners = new Set<(settled: Parameters<Parameters<WorkersHandle["onSettled"]>[0]>[0]) => void>();
  let subscribedTo: WorkerManager | null = null;
  const ensureSubscribed = () => {
    const manager = orchestrator.workers;
    if (!manager || manager === subscribedTo) return;
    subscribedTo = manager;
    manager.subscribe((event) => {
      if (event.type !== "settled") return;
      const { record } = event;
      const settled = { id: record.id, owner: record.spec.owner, status: record.status, result: record.result?.body || record.result?.summary, error: record.error };
      for (const listener of listeners) {
        try { listener(settled); } catch {}
      }
    });
  };
  const handle: WorkersHandle = {
    spawn: (request) => {
      const manager = orchestrator.workers;
      if (!manager) return { error: "workers are unavailable: the session is not ready" };
      ensureSubscribed();
      const spec = prepareSpawn(orchestrator, hooks, { subagent_type: request.type, description: request.description, prompt: request.prompt }, "", undefined);
      if (typeof spec === "string") return { error: spec };
      const record = manager.spawn({ ...spec, owner: request.owner, ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}) });
      return { id: record.id };
    },
    stop: (id) => orchestrator.workers?.stop(id) ?? false,
    status: (id) => {
      const record = orchestrator.workers?.get(id);
      return record ? { status: record.status, summary: record.result?.summary, error: record.error } : undefined;
    },
    onSettled: (listener) => {
      ensureSubscribed();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  (globalThis as any)[WORKERS_HANDLE_KEY] = handle;
  orchestrator.onWorkersReplaced = ensureSubscribed;
}

export function registerWorkerToolsFor(orchestrator: Orchestrator, hooks: WorkerHooks): void {
  registerWorkerTools(orchestrator.pi, {
    manager: () => orchestrator.workers,
    prepareSpawn: (params, toolCallId, ctx) => prepareSpawn(orchestrator, hooks, params, toolCallId, ctx),
    consumed: (records, kind = "settled") => {
      if (kind === "settled") orchestrator.workers?.markDelivered(records);
      orchestrator.workerDelivery?.forget(records.map((record) => record.id), kind);
    },
  });
}

function prepareSpawn(orchestrator: Orchestrator, hooks: WorkerHooks, params: { subagent_type: string; description: string; prompt: string; skills?: string[]; timeout_sec?: number; notify?: "wake" | "silent" }, toolCallId: string, ctx: any): WorkerSpawnSpec | string {
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
  const defaultTimeout = orchestrator.config.performance.internals.workerTimeout;
  const timeoutMs = typeof params.timeout_sec === "number" && params.timeout_sec > 0 ? params.timeout_sec * 1000 : defaultTimeout > 0 ? defaultTimeout : undefined;
  return {
    type,
    description: String(params.description ?? type).slice(0, 120),
    prompt,
    model: definition.model,
    thinking: definition.thinking,
    maxTurns: definition.maxTurns,
    timeoutMs,
    notify: params.notify === "silent" ? "silent" : "wake",
    ...(type.startsWith("reviewer_") ? { resultSchema: "findings" as const } : {}),
    parentToolCallId: toolCallId,
  };
}

export { WORKER_MESSAGE_TYPE };
