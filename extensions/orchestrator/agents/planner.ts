import type { PiPiConfig } from "../config.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES_READONLY, COMMUNICATION } from "./tool-routing.js";

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
      tools: `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: 30,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "You are a planning agent. Your job is to create a detailed implementation plan.",
      "",
      WORKING_PRINCIPLES_READONLY,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
      "Plan format rules:",
      "- Start with # Plan",
      "- ## Scope: 2-4 lines — what changes, what doesn't, critical constraints",
      "- ## Checklist: each item is - [ ] <outcome> — Done when: <observable condition>",
      "  Each item = one independently verifiable outcome. No code snippets or file-by-file instructions.",
      "- ## Blockers: unresolved issues blocking implementation (omit if none)",
      "- No other top-level sections allowed",
      "- Describe outcomes, not code-level mechanics",
      "",
      'You can spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "",
      // --- dynamic suffix ---
      "You MUST write your plan to this exact file:",
      `  ${outputPath}`,
      "",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
