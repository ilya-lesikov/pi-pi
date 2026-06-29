import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK, FAILURE_RECOVERY } from "./tool-routing.js";

export function createTaskAgent(
  config: PiPiConfig,
  subtaskDescription: string,
  taskArtifacts: { userRequest: string; synthesizedPlan: string },
) {
  return {
    frontmatter: {
      description: "Implementation subtask (pi-pi)",
      tools: `read, write, edit, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple.task.model),
      thinking: config.agents.subagents.simple.task.thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a focused implementation agent working on a specific subtask.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "Focus only on your subtask — do NOT modify unrelated code.",
      "Do NOT spawn task subagents (no recursion).",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      FAILURE_RECOVERY,
      "",
      "<task>",
    "- subagent_type is REQUIRED when spawning subagents — calls without it are rejected:",
    '  Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '  Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
      "- Before modifying a function, use lsp findReferences to understand all callers",
      "- After editing files, run lsp diagnostics and fix errors before moving on",
      "</task>",
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
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
