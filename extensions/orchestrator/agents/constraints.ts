import type { Phase, TaskMode } from "../state.js";

const READONLY_CONSTRAINT =
  "You MUST NOT edit, create, or delete any project file (source, tests, config, docs) — only files under .pp/state/ may be written — and you MUST NOT run state-changing shell commands. If you find a fix worth making, record it in your output; do NOT apply it here.";

// The review phase is read-only EXCEPT for publishing findings: the main agent may
// insert or remove `AI_COMMENT:` markers in source files (file comments), and may
// run `gh` to post/read GitHub PR line comments (PR comments) — and nothing else
// (no fixes, no other edits, no other state-changing commands). This is the
// reviewer→user mirror of the user→reviewer `AI_REVIEW:` markers.
const REVIEW_READONLY_CONSTRAINT =
  "You MUST NOT edit, create, or delete any project file (source, tests, config, docs) — only files under .pp/state/ may be written — and you MUST NOT run state-changing shell commands, WITH ONE EXCEPTION: when publishing review findings you MAY insert or remove `AI_COMMENT:` markers in source files (in each file's native comment syntax) and MAY run `gh` to post or read GitHub PR line comments, and nothing else. Do NOT apply fixes or make any other source change. If you find a fix worth making, record it in your output.";

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
  if (phase === "review") return REVIEW_READONLY_CONSTRAINT;
  return READONLY_CONSTRAINT;
}

// Guided phases that stop and hand back to the user (brainstorm, review, debug) end their turn
// with prose rather than a tool call. To keep that handoff consistent, the model must close with
// this exact block. NEXT_PHASE_LABEL supplies the phase the /pp menu advances into.
const NEXT_PHASE_LABEL: Partial<Record<Phase, string>> = {
  brainstorm: "plan",
  review: "plan",
  debug: "plan",
};

export function closingBlockInstruction(phase: Phase): string {
  const next = NEXT_PHASE_LABEL[phase] ?? "the next phase";
  return [
    "End that turn with EXACTLY this block, verbatim, as the final lines of your message (fill the summary line with one sentence; change nothing else):",
    "✅ <one-sentence summary of what this phase produced>",
    "",
    `▶ Advance via the /pp menu to move into ${next}.`,
  ].join("\n");
}

export function completionLine(phase: Phase, mode: TaskMode): string {
  if (phase === "quick") {
    return "When the user's request is complete, call pp_phase_complete. Do NOT stop and wait for the user before then.";
  }
  if (mode === "autonomous") {
    return "There is no user driving this phase. The moment its work is complete, call pp_phase_complete — do NOT pause, ask for confirmation, or wait for input. Never end a turn with prose: every turn ends in a tool call.";
  }
  if (phase === "brainstorm") {
    return "This is a conversation. Do NOT call pp_phase_complete yourself — keep going until the user ends it or advances via the /pp menu. When you have delivered a complete answer and are handing back for the user to advance, close with the standardized block. " + closingBlockInstruction(phase);
  }
  if (phase === "plan" || phase === "implement") {
    return "When you judge this phase complete, call pp_phase_complete — the extension opens the advance gate for the user to review and confirm. Do NOT instead stop and ask the user to run /pp manually.";
  }
  return "When the work is complete, stop and let the user review and advance it via the /pp menu. Do NOT advance on your own or call pp_phase_complete unprompted. Close with the standardized block. " + closingBlockInstruction(phase);
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
