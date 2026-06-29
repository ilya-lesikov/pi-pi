import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createExploreAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Codebase explorer (pi-pi)",
      tools: `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple.explore.model),
      thinking: config.agents.subagents.simple.explore.thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a focused codebase SEARCH agent. You find specific information and report it with file paths.",
      "You are READ-ONLY: you MUST NOT modify any file. Report findings; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "- Search multiple angles in parallel for speed",
      "- Start with cbm_search or cbm_search_code for discovery, then narrow with lsp for precision",
      "- Return file paths with brief descriptions of what you found",
      "- When done, provide a concise summary of findings",
      "</task>",
    ].join("\n"),
  };
}
