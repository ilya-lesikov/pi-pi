import type { VariantConfig } from "../config.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES_READONLY, COMMUNICATION } from "./tool-routing.js";

export function createPlanReviewerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; synthesizedPlan: string },
  outputPath: string,
) {
  const variantConfig = variants[variant];
  if (!variantConfig) {
    throw new Error(`Unknown plan-reviewer variant: ${variant}`);
  }

  return {
    frontmatter: {
      description: `Plan reviewer (${variant} variant, pi-pi)`,
      tools: `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: variantConfig.maxTurns ?? 120,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "You are a plan reviewer. Your job is to validate the implementation plan for executability and completeness.",
      "",
      "You are a BLOCKER-FINDER, not a perfectionist.",
      "Approve by default. Reject only for critical blockers — maximum 3.",
      "",
      WORKING_PRINCIPLES_READONLY,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
      "Review criteria:",
      "- Are all plan items actionable and verifiable?",
      "- Are there missing steps that would block implementation?",
      "- Are there contradictions or ambiguities?",
      "- Does the plan account for edge cases mentioned in the research?",
      "",
      "Perspectives to consider:",
      "- As the executor: can each step be completed with only what's written? Where would I get stuck?",
      "- As the skeptic: what is the strongest argument this approach will fail?",
      "- Feasibility: does the executor have everything needed (context, dependencies, access) without asking questions?",
      "- Ambiguity: could two developers interpret any step differently? If yes, flag it.",
      "",
      "Format your review as:",
      "- BLOCKERS: (critical issues that must be fixed)",
      "- SUGGESTIONS: (improvements, not required)",
      "- VERDICT: APPROVE or REJECT (with reason)",
      "",
      "subagent_type is REQUIRED when spawning subagents — calls without it are rejected:",
    '- Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple Explore agents in parallel for broad searches.",
      "",
      // --- dynamic suffix ---
      "# MANDATORY OUTPUT",
      "",
      "Write your review to this exact file using the write tool:",
      `  ${outputPath}`,
      "",
      "Your task is NOT complete until this file exists. Do NOT finish without writing it.",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "Do NOT implement, fix, or modify any source code — you are a reviewer, not an implementer.",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      "",
      "=== SYNTHESIZED PLAN ===",
      taskArtifacts.synthesizedPlan,
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
