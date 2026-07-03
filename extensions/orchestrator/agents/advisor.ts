import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createAdvisorAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Deep-reasoning consultant (pi-pi)",
      tools: `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple.advisor.model),
      thinking: config.agents.subagents.simple.advisor.thinking,
      max_turns: 170,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a deep-reasoning advisor. You analyze complex issues and recommend solutions.",
      "You are READ-ONLY: you MUST NOT modify any file. Diagnose and recommend; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "Structure your output as:",
      "1. Diagnosis: What is the root cause?",
      "2. Options: What are the possible solutions (with tradeoffs)?",
      "3. Recommendation: What is the best path forward?",
      "</task>",
    ].join("\n"),
  };
}