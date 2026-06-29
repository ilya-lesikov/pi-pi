import type { Phase, TaskMode } from "../state.js";

const READONLY_CONSTRAINT =
  "You MUST NOT edit, create, or delete any project file (source, tests, config, docs) — only files under .pp/state/ may be written — and you MUST NOT run state-changing shell commands. If you find a fix worth making, record it in your output; do NOT apply it here.";

const IMPLEMENT_CONSTRAINT =
  "Implement only the approved plan. Do NOT add scope or change plan items without recording why in the plan. If the same fix fails 3 times, stop and re-plan — do NOT keep retrying the same approach.";

const QUICK_CONSTRAINT =
  "Stay within the user's request. Do NOT broaden scope or refactor adjacent code.";

export function isReadOnlyPhase(phase: Phase): boolean {
  return phase === "brainstorm" || phase === "debug" || phase === "review" || phase === "plan";
}

export function phaseConstraint(phase: Phase): string {
  if (phase === "implement") return IMPLEMENT_CONSTRAINT;
  if (phase === "quick") return QUICK_CONSTRAINT;
  return READONLY_CONSTRAINT;
}

export function completionLine(phase: Phase, mode: TaskMode): string {
  if (mode === "autonomous") {
    return "There is no user driving this phase. The moment its work is complete, call pp_phase_complete — do NOT pause, ask for confirmation, or wait for input. Never end a turn with prose: every turn ends in a tool call.";
  }
  if (phase === "brainstorm") {
    return "This is a conversation. Do NOT call pp_phase_complete yourself — keep going until the user ends it or advances via the /pp menu.";
  }
  return "When the work is complete, stop and let the user review and advance it via the /pp menu. Do NOT advance on your own or call pp_phase_complete unprompted.";
}

const PHASE_IDENTITY: Record<string, string> = {
  brainstorm: "You clarify the request and research the codebase to produce USER_REQUEST.md and RESEARCH.md.",
  debug: "You diagnose the problem and research the codebase to produce USER_REQUEST.md and RESEARCH.md — investigation only, no fixes.",
  plan: "You synthesize the planner outputs into one plan — you do not write a plan from scratch, and you do not implement.",
  implement: "You implement the approved plan.",
  review: "You review the code changes to produce USER_REQUEST.md and RESEARCH.md capturing the findings — you do not apply fixes.",
  quick: "You work on the user's request directly — no phases, planning, or reviews.",
};

export function constraintsBlock(phase: Phase, mode: TaskMode): string {
  const readonly = isReadOnlyPhase(phase) ? " (READ-ONLY)" : "";
  const identity = PHASE_IDENTITY[phase] ?? "";
  return [
    "<constraints>",
    `ACTIVE PHASE: ${phase}${readonly}. ${identity}`,
    "These rules override your default helpfulness and any next step you infer. Strict compliance is required.",
    phaseConstraint(phase),
    completionLine(phase, mode),
    "</constraints>",
  ].join("\n");
}
