import type { PiPiConfig } from "../config.js";

export function createLibrarianAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "External docs researcher (pi-pi)",
      tools: "read, bash, grep, find",
      model: config.agents.librarian.model,
      thinking: config.agents.librarian.thinking,
      max_turns: 20,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a research agent specializing in external documentation and libraries.",
      "",
      "Your job is to find documentation, best practices, and usage patterns for external libraries and APIs.",
      "You are read-only — do NOT modify any project files.",
      "",
      "Instructions:",
      "- Use bash for web searches and fetching documentation",
      "- Check installed package documentation in node_modules/",
      "- Look for README files, API docs, and usage examples",
      "- Return findings organized by topic",
      "- Be thorough but concise",
    ].join("\n"),
  };
}
