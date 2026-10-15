import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";
import type { WorkerStatus } from "./workers/types.js";

export const PP_ACP_STATE_TYPE = "pp:state";

export type AcpRunStatus = "idle" | "running" | "waiting" | "failed";
export type AcpSubagentStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpSubagent {
  id: string;
  label: string;
  status: AcpSubagentStatus;
}

export interface AcpState {
  status: AcpRunStatus;
  subagents: AcpSubagent[];
}

export function isAcpMode(): boolean {
  return process.env.PI_ACP === "1";
}

function toSubagentStatus(status: WorkerStatus): AcpSubagentStatus {
  if (status === "queued") return "pending";
  if (status === "running") return "in_progress";
  if (status === "completed") return "completed";
  return "failed";
}

function listSubagents(orchestrator: Orchestrator): AcpSubagent[] {
  return (orchestrator.workers?.list() ?? []).map((record) => ({ id: record.id, label: record.spec.description || record.spec.type, status: toSubagentStatus(record.status) }));
}

export function buildAcpState(orchestrator: Orchestrator): AcpState {
  const subagents = listSubagents(orchestrator);
  if (orchestrator.configError || orchestrator.duplicateExtensionError) return { status: "failed", subagents };
  if (orchestrator.interactivePromptOpen) return { status: "waiting", subagents };
  // Work in flight is not idle, even while the main agent itself has nothing to do.
  return { status: orchestrator.mainTurnInFlight || orchestrator.hasActiveWorkers() ? "running" : "idle", subagents };
}

const lastPayloadBySession = new Map<string, string>();

function sessionKey(orchestrator: Orchestrator): string {
  return orchestrator.lastCtx?.sessionManager?.getSessionId?.() || "default";
}

export function resetAcpStateCache(sessionId?: string): void {
  if (sessionId) lastPayloadBySession.delete(sessionId);
  else lastPayloadBySession.clear();
}

export function publishAcpState(orchestrator: Orchestrator, pi: ExtensionAPI = orchestrator.pi): void {
  if (!isAcpMode()) return;
  const state = buildAcpState(orchestrator);
  const payload = JSON.stringify(state);
  const key = sessionKey(orchestrator);
  if (payload === lastPayloadBySession.get(key)) return;
  lastPayloadBySession.set(key, payload);
  try {
    pi.appendEntry(PP_ACP_STATE_TYPE, state);
  } catch (err: any) {
    lastPayloadBySession.delete(key);
    getLogger().debug({ s: "acp", err: err?.message }, "failed to append pp:state entry");
  }
}
