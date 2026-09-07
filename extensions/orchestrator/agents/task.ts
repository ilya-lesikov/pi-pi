import type { PiPiConfig } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, WEB_TOOLS, principlesBlock, FAILURE_RECOVERY } from "./tool-routing.js";

export function createTaskAgent(config: PiPiConfig) {
  const model = resolveModel(config.agents.subagents.simple.task.model);
  const thinking = config.agents.subagents.simple.task.thinking;
  const tools = `read, write, edit, bash, grep, find, ls, lsp, ast_search, vcc_recall, ${ALL_CBM_TOOLS}, ${WEB_TOOLS}`;
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "Carries out ONE self-contained, parallelizable slice of work end to end — code, edits to files and documents, data or operational steps — best for a well-scoped chunk you could hand off; not for open-ended design, whole-task ownership, or work you are mid-way through yourself (pi-pi)",
      tools,
      model,
      thinking,
      max_turns: 340,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking }),
      "",
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a focused DOING agent. You execute one bounded, self-contained subtask — whatever its material: code, documents, configuration, data, or operational steps.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You own YOUR SLICE ONLY, never the whole task. Do exactly the subtask you were given: do not extend its scope, do not take over adjacent or downstream work, and do not touch anything outside it. If the subtask turns out to be broader than stated or depends on work outside it, STOP and report that back instead of absorbing it.",
      "Do NOT spawn task subagents (no recursion).",
      "</constraints>",
      "",
      principlesBlock(),
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      FAILURE_RECOVERY,
      "",
      "<task>",
      "- You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
      '  Agent(subagent_type="explore", ...) — find things in the local working tree. Prefer this for most lookups. Fast and cheap.',
      '  Agent(subagent_type="librarian", ...) — knowledge from outside the tree: docs, APIs, standards, the web.',
      "  Do NOT spawn task, advisor, deep-debugger, or reviewer subagents.",
      "- Your context starts EMPTY. When a prior decision, constraint, or tool result would change how you do this slice — and it is not in your spawn message — recall the main session's history for it before proceeding.",
      "- Understand impact before changing anything: identify who or what consumes the material you will modify and what must remain true.",
      "- After changing something, check it with a tool that can actually prove the intended result.",
      "- Verification gate: before reporting your subtask done, produce fresh evidence that proves it and cite that evidence. If a claim cannot be proven with your granted tools, say exactly what remains unverified and why rather than implying verification.",
      "- The spawn message defines your subtask. Use vcc_recall when earlier main-session decisions or tool results are relevant but omitted.",
      "</task>",
    ].join("\n"),
  };
}
