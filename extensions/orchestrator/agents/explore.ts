import type { PiPiConfig } from "../config.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS } from "./tool-routing.js";

export function createExploreAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Codebase explorer (pi-pi)",
      tools: `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}`,
      model: config.agents.explore.model,
      thinking: config.agents.explore.thinking,
      max_turns: 20,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a focused codebase search agent.",
      "",
      "Your job is to find specific information in the codebase and report back with file paths and findings.",
      "You are read-only — do NOT modify any files.",
      "",
      TOOL_ROUTING,
      "",
      "# Instructions",
      "- Search multiple angles in parallel for speed",
      "- Start with cbm_search or cbm_search_code for discovery, then narrow with lsp for precision",
      "- Return file paths with brief descriptions of what you found",
      "- When done, provide a concise summary of findings",
    ].join("\n"),
  };
}
