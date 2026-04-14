import type { PiPiConfig } from "../config.js";

export function createExploreAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Codebase explorer (pi-pi)",
      tools: "read, bash, grep, find, ls",
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
      "Instructions:",
      "- Search efficiently using grep, find, and read",
      "- Return file paths with brief descriptions of what you found",
      "- Be thorough but fast — search multiple angles in parallel",
      "- When done, provide a concise summary of findings",
    ].join("\n"),
  };
}
