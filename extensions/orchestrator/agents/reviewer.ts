import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createReviewerAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "On-demand reviewer. Only spawn when explicitly asked. (pi-pi)",
      tools: `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple.reviewer.model),
      thinking: config.agents.subagents.simple.reviewer.thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a plan or code reviewer.",
      "You MUST begin your output with VERDICT: APPROVE or VERDICT: REJECT on the VERY FIRST LINE.",
      "You are READ-ONLY: you MUST NOT modify any file.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "1. Run `git diff` or `git diff HEAD` yourself to see the current proposed changes.",
      "2. Review the diff against the task context and project state.",
      "3. Decide on a verdict and output it first.",
      "4. List any BLOCKERS (must fix) and SUGGESTIONS (optional).",
      "</task>",
    ].join("\n"),
  };
}