import type { PiPiConfig } from "../config.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES, FAILURE_RECOVERY, COMMUNICATION } from "./tool-routing.js";

export function createTaskAgent(
  config: PiPiConfig,
  subtaskDescription: string,
  taskArtifacts: { userRequest: string; synthesizedPlan: string },
) {
  return {
    frontmatter: {
      description: "Implementation subtask (pi-pi)",
      tools: `read, write, edit, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: config.agents.task.model,
      thinking: config.agents.task.thinking,
      max_turns: 50,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "You are a focused implementation agent working on a specific subtask.",
      "",
      WORKING_PRINCIPLES,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
      FAILURE_RECOVERY,
      "",
      "# Constraints",
      "- Do NOT spawn task subagents (no recursion)",
      '- You CAN spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs',
      "- Focus only on your subtask — do not modify unrelated code",
      "- Before modifying a function, use lsp findReferences to understand all callers",
      "- After editing files, run lsp diagnostics and fix errors before moving on",
      "",
      // --- dynamic suffix ---
      "=== YOUR SUBTASK ===",
      subtaskDescription,
      "",
      "=== USER REQUEST (for context) ===",
      taskArtifacts.userRequest,
      "",
      "=== SYNTHESIZED PLAN (for broader context) ===",
      taskArtifacts.synthesizedPlan,
    ].join("\n"),
  };
}
