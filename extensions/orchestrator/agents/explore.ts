import type { PiPiConfig } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createExploreAgent(config: PiPiConfig) {
  const model = resolveModel(config.agents.subagents.simple.explore.model);
  const thinking = config.agents.subagents.simple.explore.thinking;
  const tools = `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`;
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "Codebase explorer (pi-pi)",
      tools,
      model,
      thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking }),
      "",
      "<constraints>",
      "You are a focused codebase SEARCH agent. You find specific information and report it with file paths.",
      "You are READ-ONLY: you MUST NOT modify any file. Report findings; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
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
