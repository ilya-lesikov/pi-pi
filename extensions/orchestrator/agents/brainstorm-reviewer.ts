import type { VariantConfig } from "../config.js";
import { loadAllContextFiles } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createBrainstormReviewerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; artifacts?: { name: string; content: string }[] },
  outputPath: string,
  contextDirs: string[],
  phase?: string,
  repos: RepoInfo[] = [],
) {
  const variantConfig = variants[variant];
  if (!variantConfig) {
    throw new Error(`Unknown brainstorm-reviewer variant: ${variant}`);
  }
  const contextFiles = loadAllContextFiles(contextDirs, "brainstormReviewer", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
  const repoContext = buildRepoContext(repos);

  return {
    frontmatter: {
      description: `Brainstorm reviewer (${variant} variant, pi-pi)`,
      tools: `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a research reviewer. You verify the thoroughness and accuracy of brainstorm research artifacts. You are a GAP-FINDER, not a perfectionist — approve by default, reject only for critical gaps (maximum 3).",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT implement or modify any file except the single review .md file named below. You MUST write it before finishing.",
      "Your review MUST begin with the verdict on the VERY FIRST LINE: `VERDICT: APPROVE` or `VERDICT: NEEDS_WORK`.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      ...(contextBlock ? ["<project_context>", contextBlock, "</project_context>", ""] : []),
      "<task>",
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
      "# Format your review with the verdict on the VERY FIRST LINE, then findings:",
      "VERDICT: APPROVE | NEEDS_WORK",
      "- GAPS: (missing information that would block planning)",
      "- INACCURACIES: (claims that don't match the code)",
      "- SUGGESTIONS: (improvements, not required)",
      "",
      "subagent_type is REQUIRED when spawning subagents — calls without it are rejected:",
    '- Agent(subagent_type="Explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="Librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple Explore agents in parallel for broad searches.",
      "</task>",
      "",
      "# MANDATORY: Write your review to this exact file using the write tool:",
      `  ${outputPath}`,
      "",
      "You MUST write only to the review file above. Do NOT write to any other file.",
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
      ...(repoContext ? [repoContext] : []),
      "",
      "The artifacts above are already in your context. Do NOT re-read them from disk.",
    ].join("\n"),
  };
}
