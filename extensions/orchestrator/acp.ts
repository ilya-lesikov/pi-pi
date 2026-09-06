import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";

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

function toSubagentStatus(status: unknown): AcpSubagentStatus {
  if (status === "queued") return "pending";
  if (status === "running" || status === "steered") return "in_progress";
  if (status === "completed") return "completed";
  return "failed";
}

function listSubagents(): AcpSubagent[] {
  const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  const records: unknown = manager?.listAgents?.();
  if (!Array.isArray(records)) return [];
  return records.flatMap((raw: any) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!id) return [];
    const description = typeof raw.description === "string" ? raw.description : "";
    const type = typeof raw.type === "string" ? raw.type : "";
    return [{ id, label: description || type || id, status: toSubagentStatus(raw.status) }];
  });
}

export function buildAcpState(orchestrator: Orchestrator): AcpState {
  const subagents = listSubagents();
  if (orchestrator.configError || orchestrator.duplicateExtensionError) return { status: "failed", subagents };
  if (orchestrator.interactivePromptOpen) return { status: "waiting", subagents };
  return { status: orchestrator.mainTurnInFlight ? "running" : "idle", subagents };
}

let lastPayload: string | null = null;

export function resetAcpStateCache(): void {
  lastPayload = null;
}

export function publishAcpState(orchestrator: Orchestrator, pi: ExtensionAPI = orchestrator.pi): void {
  if (!isAcpMode()) return;
  const state = buildAcpState(orchestrator);
  const payload = JSON.stringify(state);
  if (payload === lastPayload) return;
  lastPayload = payload;
  try {
    pi.appendEntry(PP_ACP_STATE_TYPE, state);
  } catch (err: any) {
    lastPayload = null;
    getLogger().debug({ s: "acp", err: err?.message }, "failed to append pp:state entry");
  }
}
