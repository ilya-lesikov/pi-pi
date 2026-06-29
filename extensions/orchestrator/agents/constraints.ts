import type { Phase, TaskMode } from "../state.js";

const READONLY_CONSTRAINT =
  "You MUST NOT modify project source, config, or files outside .pp/state/. If you find an obvious fix, you MUST record it in your output — you MUST NOT apply it in this phase.";

const IMPLEMENT_CONSTRAINT =
  "You MUST implement only the approved plan. You MUST NOT add scope or change plan items without recording why. If a fix fails 3 times, you MUST stop and re-plan — you MUST NOT keep retrying the same approach.";

const QUICK_CONSTRAINT =
  "You MUST stay within the user's request. There are no phases, planning, or reviews — work directly.";

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
    return "When this phase is complete, you MUST call pp_phase_complete immediately. You MUST NOT wait for the user, ask the user to continue, or mention /pp — there is no user driving this phase. A turn MUST end with a tool call; ending with prose is prohibited.";
  }
  if (phase === "brainstorm") {
    return "This is a conversation — do NOT call pp_phase_complete on your own; keep going until the user is done or advances via the /pp menu.";
  }
  return "When this phase's work is complete, the user will review and advance it via the /pp menu. Do NOT advance on your own.";
}

const PHASE_IDENTITY: Record<string, string> = {
  brainstorm: "You are clarifying the request and researching the codebase to produce USER_REQUEST.md and RESEARCH.md.",
  debug: "You are diagnosing a problem — read-only investigation, no fixes.",
  plan: "You are a SYNTHESIZER merging planner outputs into one plan — not a planner or implementer.",
  implement: "You are implementing an already-approved plan.",
  review: "You are reviewing code changes and recording findings — no fixes.",
  quick: "You are in a quick task: work on the user's request directly.",
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
