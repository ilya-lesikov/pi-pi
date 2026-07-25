import type { PiPiConfig } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK, IMPLEMENTATION_PRINCIPLES_BLOCK, FAILURE_RECOVERY } from "./tool-routing.js";

export function createTaskAgent(config: PiPiConfig) {
  const model = resolveModel(config.agents.subagents.simple.task.model);
  const thinking = config.agents.subagents.simple.task.thinking;
  const tools = `read, write, edit, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`;
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "Implementation subtask (pi-pi)",
      tools,
      model,
      thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking }),
      "",
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
      IMPLEMENTATION_PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      FAILURE_RECOVERY,
      "",
      "<task>",
      "- You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
      '  Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
      '  Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
      "  Do NOT spawn task, advisor, deep-debugger, or reviewer subagents.",
      "- Before modifying a function, use lsp findReferences to understand all callers",
      "- After editing files, run lsp diagnostics and fix errors before moving on",
      "- Verification gate: before reporting your subtask done, produce fresh tool output that proves it (lsp diagnostics clean, a passing test, expected cbm_changes) and cite it. The gate is on whether that proving evidence EXISTS, not on wording, so it holds in any language. If a claim cannot be proven with your granted tools, say so and state why (\"not applicable — <reason>\") rather than implying verification.",
      "- Test-first policy (conditional): for a behavior change or bug fix where an automated test is feasible, write/reproduce the FAILING test first, then make it pass; otherwise state the verification method before editing. No universal test-first mandate and no delete-untested-code rule — choose the path that produces real evidence.",
      "- Your subtask and task context (USER_REQUEST, RESEARCH, and a manifest of additional documents) are provided in the spawn message. Read the manifested files from disk if relevant.",
      "</task>",
    ].join("\n"),
  };
}
