import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";
import { phasePipeline } from "./phases/machine.js";
import {
  formatModeIndicator,
  type Phase,
  type TaskState,
  type TaskType,
} from "./state.js";
import { getLogger } from "./log.js";

export const PP_ACP_STATE_TYPE = "pp:state";

export type AcpRunStatus =
  "idle" | "running" | "waiting" | "completed" | "failed";
export type AcpSubagentStatus =
  "pending" | "in_progress" | "completed" | "failed";
export type AcpPhaseStatus = "pending" | "in_progress" | "completed";

export interface AcpSubagent {
  id: string;
  label: string;
  status: AcpSubagentStatus;
}

export interface AcpPhase {
  id: string;
  label: string;
  status: AcpPhaseStatus;
  detail?: string;
}

export interface AcpState {
  phase?: string;
  phases?: AcpPhase[];
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

const PHASE_LABELS: Record<Phase, string> = {
  brainstorm: "Brainstorm",
  review: "Review",
  plan: "Plan",
  implement: "Implement",
  quick: "Quick",
  done: "Done",
};

// Only the closed set of orchestrator steps is rendered: an unrecognised step is
// dropped rather than surfaced raw, so an internal rename can never leak noise
// into a client's task list.
const STEP_LABELS: Record<string, string> = {
  spawn_planners: "spawning planners",
  await_planners: "awaiting planners",
  synthesize: "synthesizing plans",
  await_reviewers: "awaiting reviewers",
  apply_feedback: "applying review feedback",
  user_gate: "awaiting user",
};

function currentPhaseDetail(state: TaskState): string | undefined {
  const parts: string[] = [];
  const pass = state.reviewCycle?.pass;
  if (typeof pass === "number" && pass > 0) parts.push(`review pass ${pass}`);
  const step = state.step ? STEP_LABELS[state.step] : undefined;
  if (step) parts.push(step);
  return parts.length ? parts.join(" · ") : undefined;
}

function listPhases(type: TaskType, state: TaskState): AcpPhase[] {
  const pipeline: Phase[] = phasePipeline(type).filter(
    (phase) => phase !== "done",
  );
  const current = pipeline.indexOf(state.phase);
  // A phase outside the pipeline is either "done" (everything behind it is
  // finished) or a state this build does not know, which must not be reported
  // as progress.
  const fallback: AcpPhaseStatus =
    state.phase === "done" ? "completed" : "pending";
  return pipeline.map((phase, index) => {
    if (current === -1) {
      return { id: phase, label: PHASE_LABELS[phase], status: fallback };
    }
    if (index < current) {
      return { id: phase, label: PHASE_LABELS[phase], status: "completed" };
    }
    if (index > current) {
      return { id: phase, label: PHASE_LABELS[phase], status: "pending" };
    }
    const detail = currentPhaseDetail(state);
    return {
      id: phase,
      label: PHASE_LABELS[phase],
      status: "in_progress",
      ...(detail ? { detail } : {}),
    };
  });
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
    phases: listPhases(active.type, active.state),
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
