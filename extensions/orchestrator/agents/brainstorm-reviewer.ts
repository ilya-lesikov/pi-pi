import type { VariantConfig } from "../config.js";
import { loadContextFiles } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES_READONLY, COMMUNICATION } from "./tool-routing.js";

export function createBrainstormReviewerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; artifacts?: { name: string; content: string }[] },
  outputPath: string,
  cwd: string,
  phase?: string,
) {
  const variantConfig = variants[variant];
  if (!variantConfig) {
    throw new Error(`Unknown brainstorm-reviewer variant: ${variant}`);
  }
  const contextFiles = loadContextFiles(cwd, "brainstormReviewer", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");

  return {
    frontmatter: {
      description: `Brainstorm reviewer (${variant} variant, pi-pi)`,
      tools: `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: variantConfig.maxTurns ?? 120,
      prompt_mode: "replace",
    },
    prompt: [
      ...(contextBlock ? ["# Project Context", "", contextBlock, ""] : []),
      "You are a research reviewer. Your job is to verify the thoroughness and accuracy of brainstorm research artifacts.",
      "",
      "You are a GAP-FINDER, not a perfectionist.",
      "Approve by default. Reject only for critical gaps — maximum 3.",
      "",
      WORKING_PRINCIPLES_READONLY,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
      "# Your job:",
      "1. Read USER_REQUEST.md and RESEARCH.md provided below",
      "2. INDEPENDENTLY investigate the codebase to verify claims and find gaps",
      "3. Check whether the research is thorough enough for a planner to work without re-exploring",
      "",
      "# Review criteria:",
      "- Completeness: are all affected code paths identified? Any missed callers/callees?",
      "- Accuracy: do the architecture claims match what you find in the code?",
      "- Constraints: are there edge cases or hard requirements the researcher missed?",
      "- Separation: does USER_REQUEST.md contain only user-stated info (no agent findings leaked in)?",
      "- Structure: do both files follow the required format?",
      "",
      "# Format your review as:",
      "- GAPS: (missing information that would block planning)",
      "- INACCURACIES: (claims that don't match the code)",
      "- SUGGESTIONS: (improvements, not required)",
      "- VERDICT: APPROVE or NEEDS_WORK (with reason)",
      "",
      "subagent_type is REQUIRED when spawning subagents — calls without it are rejected:",
    '- Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple Explore agents in parallel for broad searches.",
      "",
      "# MANDATORY: Write your review to this exact file using the write tool:",
      `  ${outputPath}`,
      "",
      "Your task is NOT complete until this file exists. Do NOT finish without writing it.",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "Do NOT implement, fix, or modify any source code — you are a reviewer, not an implementer.",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      ...(taskArtifacts.artifacts && taskArtifacts.artifacts.length > 0
        ? [
            "",
            ...taskArtifacts.artifacts.flatMap((a) => [`=== ${a.name} ===`, a.content, ""]),
          ]
        : []),
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
