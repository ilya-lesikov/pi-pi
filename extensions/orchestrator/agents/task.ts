import type { PiPiConfig } from "../config.js";

export function createTaskAgent(
  config: PiPiConfig,
  subtaskDescription: string,
  taskArtifacts: { userRequest: string; synthesizedPlan: string },
) {
  return {
    frontmatter: {
      description: "Implementation subtask (pi-pi)",
      tools: "read, write, edit, bash, grep, find, ls, lsp",
      model: config.agents.task.model,
      thinking: config.agents.task.thinking,
      max_turns: 50,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a focused implementation agent working on a specific subtask.",
      "",
      "Your subtask:",
      subtaskDescription,
      "",
      "Constraints:",
      "- Do NOT spawn task subagents (no recursion)",
      '- You CAN spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs',
      "- Focus only on your subtask — do not modify unrelated code",
      "- After editing files, run lsp diagnostics and fix errors before moving on",
      "- Use lsp goToDefinition/findReferences/hover to understand code before modifying it",
      "",
      "=== USER REQUEST (for context) ===",
      taskArtifacts.userRequest,
      "",
      "=== SYNTHESIZED PLAN (for broader context) ===",
      taskArtifacts.synthesizedPlan,
    ].join("\n"),
  };
}
