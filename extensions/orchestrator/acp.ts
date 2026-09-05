import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";
import { formatModeIndicator } from "./state.js";
import { getLogger } from "./log.js";

export const PP_ACP_STATE_TYPE = "pp:state";

export type AcpRunStatus =
  "idle" | "running" | "waiting" | "completed" | "failed";
export type AcpSubagentStatus =
  "pending" | "in_progress" | "completed" | "failed";

export interface AcpSubagent {
  id: string;
  label: string;
  status: AcpSubagentStatus;
}

export interface AcpState {
  phase?: string;
  mode?: string;
  status: AcpRunStatus;
  subagents: AcpSubagent[];
}

export function isAcpMode(): boolean {
  return process.env.PI_ACP === "1";
}

interface SubagentRecordView {
  id?: unknown;
  type?: unknown;
  description?: unknown;
  status?: unknown;
}

function toSubagentStatus(status: unknown): AcpSubagentStatus {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
    case "steered":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return "failed";
  }
}

function listSubagents(): AcpSubagent[] {
  const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  const records: unknown = mgr?.listAgents?.();
  if (!Array.isArray(records)) return [];
  const subagents: AcpSubagent[] = [];
  for (const raw of records as SubagentRecordView[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!id) continue;
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const type = typeof raw.type === "string" ? raw.type : "";
    subagents.push({
      id,
      label: description || type || id,
      status: toSubagentStatus(raw.status),
    });
  }
  return subagents;
}

export function buildAcpState(orchestrator: Orchestrator): AcpState {
  const subagents = listSubagents();
  if (orchestrator.configError || orchestrator.duplicateExtensionError) {
    return { status: "failed", subagents };
  }
  const active = orchestrator.active;
  if (!active)
    return {
      status: orchestrator.interactivePromptOpen ? "waiting" : "idle",
      subagents,
    };

  const mode = formatModeIndicator(active.state, active.type);
  const status: AcpRunStatus =
    active.state.phase === "done"
      ? "completed"
      : orchestrator.interactivePromptOpen
        ? "waiting"
        : "running";

  return {
    phase: active.state.phase,
    ...(mode ? { mode } : {}),
    status,
    subagents,
  };
}

let lastPayload: string | null = null;

export function resetAcpStateCache(): void {
  lastPayload = null;
}

export function publishAcpState(
  orchestrator: Orchestrator,
  pi: ExtensionAPI = orchestrator.pi,
): void {
  if (!isAcpMode()) return;
  const state = buildAcpState(orchestrator);
  const payload = JSON.stringify(state);
  if (payload === lastPayload) return;
  lastPayload = payload;
  try {
    pi.appendEntry(PP_ACP_STATE_TYPE, state);
  } catch (err: any) {
    lastPayload = null;
    getLogger().debug(
      { s: "acp", err: err?.message },
      "failed to append pp:state entry",
    );
  }
}
