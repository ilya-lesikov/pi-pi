import type { PiPiConfig } from "../config.js";

export function createPlanReviewerAgent(
  variant: string,
  config: PiPiConfig,
  taskArtifacts: { userRequest: string; research: string; synthesizedPlan: string },
  outputPath: string,
) {
  const variantConfig = config.planReviewers[variant];
  if (!variantConfig) {
    throw new Error(`Unknown plan-reviewer variant: ${variant}`);
  }

  return {
    frontmatter: {
      description: `Plan reviewer (${variant} variant, pi-pi)`,
      tools: "read, grep, find, bash, write",
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: 20,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a plan reviewer. Your job is to validate the implementation plan for executability and completeness.",
      "",
      "You are a BLOCKER-FINDER, not a perfectionist.",
      "Approve by default. Reject only for critical blockers — maximum 3.",
      "",
      "Write your review to this exact file:",
      `  ${outputPath}`,
      "",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "",
      "Review criteria:",
      "- Are all plan items actionable and verifiable?",
      "- Are there missing steps that would block implementation?",
      "- Are there contradictions or ambiguities?",
      "- Does the plan account for edge cases mentioned in the research?",
      "",
      "Format your review as:",
      "- BLOCKERS: (critical issues that must be fixed)",
      "- SUGGESTIONS: (improvements, not required)",
      "- VERDICT: APPROVE or REJECT (with reason)",
      "",
      'You can spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      "",
      "=== SYNTHESIZED PLAN ===",
      taskArtifacts.synthesizedPlan,
    ].join("\n"),
  };
}
