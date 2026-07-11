import type { PiPiConfig } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createLibrarianAgent(config: PiPiConfig) {
  const model = resolveModel(config.agents.subagents.simple.librarian.model);
  const thinking = config.agents.subagents.simple.librarian.thinking;
  const tools = "read, bash, grep, find, exa_search, exa_fetch";
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "External docs researcher (pi-pi)",
      tools,
      model,
      thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking }),
      "",
      "<constraints>",
      "You are a research agent specializing in external documentation and libraries. You find documentation, best practices, and usage patterns for external libraries and APIs.",
      "You are READ-ONLY: you MUST NOT modify any project file. Report findings; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      "<task>",
      "# How to research",
      "",
      "Never guess at APIs — always look them up. Training data may be outdated or wrong.",
      "",
      "Web search and docs:",
      "- exa_search: search the web for docs, guides, examples. Describe the ideal page, not keywords.",
      "- exa_fetch: read a URL's full content as clean markdown. Use after exa_search for details.",
      "",
      "Local sources:",
      "- Read installed package docs (node_modules/, vendor/, go module cache)",
      "- grep: search installed dependencies for usage patterns",
      "",
      "Priority: exa_search → exa_fetch (for full page) → installed source → grep as fallback",
      "",
      "# Output",
      "- Organize findings by topic",
      "- Include exact URLs or file paths for every claim",
      "- Quote relevant code snippets from docs",
      "- Flag any version-specific caveats",
      "</task>",
    ].join("\n"),
  };
}
