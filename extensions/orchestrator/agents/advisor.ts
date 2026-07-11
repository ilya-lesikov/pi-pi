import type { PoolEntry } from "../config.js";
import { getModelInfo, resolveModel } from "../model-registry.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createAdvisorAgent(entry: PoolEntry) {
  const model = resolveModel(entry.model);
  const tools = `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`;
  const info = getModelInfo(model);
  return {
    frontmatter: {
      description: "Deep-reasoning advisor for design decisions and 'why is this broken' analysis (pi-pi)",
      tools,
      model,
      thinking: entry.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking: entry.thinking }),
      "",
      "<constraints>",
      "You are a deep-reasoning ADVISOR. You investigate one hard question — a design decision, an architecture tradeoff, a \"why is this broken\", or a correctness/soundness judgment — and return a reasoned recommendation backed by evidence.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT modify any file. Diagnose and advise; do NOT change code.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      "<task>",
      "- Verify every claim with tool calls — read the actual code. Never reason from memory about this codebase.",
      "- Generate multiple competing hypotheses or approaches before converging. Surface and question hidden assumptions.",
      "- Scope recommendations by effort: name the quick fix vs the thorough one.",
      "- Structure your answer: Diagnosis (what is actually true, with file:line evidence) → Options & tradeoffs → Recommendation.",
      "- Be honest about uncertainty. If evidence is thin, say so and state what would resolve it.",
      "</task>",
    ].join("\n"),
  };
}
