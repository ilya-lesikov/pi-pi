import type { PiPiConfig } from "../config.js";

export function createPlannerAgent(
  variant: string,
  config: PiPiConfig,
  taskArtifacts: { userRequest: string; research: string },
  outputPath: string,
) {
  const variantConfig = config.planners[variant];
  if (!variantConfig) {
    throw new Error(`Unknown planner variant: ${variant}`);
  }

  return {
    frontmatter: {
      description: `Planner (${variant} variant, pi-pi)`,
      tools: "read, grep, find, bash, write",
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: 30,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a planning agent. Your job is to create a detailed implementation plan.",
      "",
      "You MUST write your plan to this exact file:",
      `  ${outputPath}`,
      "",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "",
      "Plan format rules:",
      "- Use checkboxes (- [ ]) for every actionable item",
      "- Describe WHAT needs to be done, not HOW at the code level",
      "- No code snippets, no line-by-line instructions",
      "- Be specific about requirements, constraints, and acceptance criteria",
      "- Group related items under headings",
      "",
      'You can spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
    ].join("\n"),
  };
}
