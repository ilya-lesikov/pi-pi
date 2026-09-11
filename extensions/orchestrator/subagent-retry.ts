import { getAgentConfigSnapshot } from "./agents/registry.js";
import { getLogger } from "./log.js";
import { getTracer } from "./tracer.js";
import type { Orchestrator } from "./orchestrator.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

const RESUME_PROMPT = "[PI-PI] The provider that refused your last request was rate limited, and this session has been moved to another one. Everything above is your own work — continue from where you stopped. Do not start over and do not repeat work you already finished.";

/**
 * Put a worker that died on a rate-limited provider back to work on the tier the
 * fallback just moved to, by re-pointing its retained session and resuming it.
 *
 * Resuming rather than respawning is what makes this worth doing: the record
 * keeps its AgentSession after a failure, so the transcript the worker had
 * already built — every file it read, every conclusion it reached — is still
 * there, and a fresh agent with the same prompt would have to buy all of it
 * again. It also keeps a writer from repeating mutations it had already made.
 *
 * Retried at most once per agent: a second failure means the routing move did
 * not help, and the parent is better told than spun.
 */
export async function retrySubagentOnNewRouting(orchestrator: Orchestrator, data: any): Promise<boolean> {
  const id = data?.id;
  if (!id || orchestrator.retriedSubagentIds.has(id)) return false;
  const manager = (globalThis as any)[MANAGER_KEY];
  const record = manager?.getRecord?.(id);
  if (!record?.session || typeof manager.resume !== "function") return false;
  // An abort or a user stop is not a routing problem, and the session of a
  // record that has since been reused must not be commandeered.
  if (record.status !== "error") return false;

  const target = getAgentConfigSnapshot(record.type)?.model;
  // Nothing to retry onto: the fallback either had nowhere to go or had already
  // moved this family before the worker started.
  if (!target || target === data?.modelId) return false;
  const ctx = orchestrator.lastCtx as any;
  const separator = target.indexOf("/");
  if (separator < 1) return false;
  const provider = target.slice(0, separator);
  const modelId = target.slice(separator + 1);
  const model = ctx?.modelRegistry?.find?.(provider, modelId)
    ?? ctx?.modelRegistry?.getAvailable?.().find((entry: any) => entry.provider === provider && entry.id === modelId);
  if (!model) return false;
  // A resumed run bypasses the manager's background queue, so the limit has to
  // be enforced here — and against the workers actually running, not just other
  // retries: the failure freed this agent's slot and the manager will already
  // have drained a queued worker into it. A retry counts as running from the
  // moment `resume` is entered, and `retryingSubagentIds` covers the window
  // before that, so two failures landing together cannot claim one slot.
  const running = (manager.listAgents?.() ?? []).filter((entry: any) => entry.status === "running").length;
  if (running + orchestrator.retryingSubagentIds.size >= orchestrator.config.agents.maxConcurrentSubagents) return false;

  orchestrator.retriedSubagentIds.add(id);
  orchestrator.retryingSubagentIds.add(id);
  // The manager admits fresh background workers against its own counter, which
  // a resume never touches; lowering the ceiling by the number of retries keeps
  // the configured limit honest while they run.
  applyRetryHeadroom(orchestrator, manager);
  // The failure already settled this agent; re-track it so the turn gating and
  // the stale-agent watchdog account for the run that is starting again.
  orchestrator.spawnedAgentIds.add(id);
  orchestrator.agentSpawnTimes.set(id, Date.now());
  orchestrator.agentDescriptions.set(id, record.description ?? record.type ?? id);
  orchestrator.startStaleAgentWatchdog();
  getTracer()?.traceSubagent(id, "subagent_retried", { from: data?.modelId, to: target });

  const untrack = () => {
    orchestrator.spawnedAgentIds.delete(id);
    orchestrator.agentSpawnTimes.delete(id);
    orchestrator.agentDescriptions.delete(id);
  };
  try {
    await record.session.setModel(model);
    // Every lifecycle payload reports this field, so a retry that leaves it
    // behind makes the next failure look like one from the provider that is
    // already demoted — the fallback would then route nowhere and attribute this
    // worker's usage to a tier it no longer runs on.
    record.resolvedModelId = target;
    // Usage accumulates across a record's runs but the completion event reports
    // the total against ONE model id, so the tokens burned on the provider that
    // refused this worker would be billed to the one it moved to. A failed run
    // reports no usage at all, which is where they stay.
    record.lifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    const resumed = manager.resume(id, RESUME_PROMPT, undefined, { emitLifecycle: true });
    // `resume` marks the record running before it awaits anything, so the slot
    // this retry reserved is now held by the manager's own view of the fleet.
    orchestrator.retryingSubagentIds.delete(id);
    // Nothing to resume: a shutdown disposed the record, or something else
    // claimed it while the model was being switched. No lifecycle event will
    // arrive for it, so the tracking has to come off here.
    if (!await resumed) {
      untrack();
      return false;
    }
    return true;
  } catch (error: any) {
    getLogger().error({ s: "agents", id, model: target, err: error?.message }, "failed to resume a rate-limited worker on the new routing");
    untrack();
    return false;
  } finally {
    orchestrator.retryingSubagentIds.delete(id);
    applyRetryHeadroom(orchestrator, manager);
  }
}

function applyRetryHeadroom(orchestrator: Orchestrator, manager: any): void {
  const configured = orchestrator.config.agents.maxConcurrentSubagents;
  manager.setMaxConcurrent?.(Math.max(1, configured - orchestrator.retryingSubagentIds.size));
}
