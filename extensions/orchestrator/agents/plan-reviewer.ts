import type { VariantConfig } from "../config.js";
import { loadAllContextFiles, formatManifestBlock } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { toolsBlock, parseToolNames, identityBlock, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createPlanReviewerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; synthesizedPlan: string; manifest?: { title: string; path: string }[] },
  outputPath: string,
  contextDirs: string[],
  phase?: string,
  repos: RepoInfo[] = [],
) {
  const variantConfig = variants[variant];
  if (!variantConfig) {
    throw new Error(`Unknown plan-reviewer variant: ${variant}`);
  }
  const info = getModelInfo(resolveModel(variantConfig.model));
  const contextFiles = loadAllContextFiles(contextDirs, "planReviewer", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
  const repoContext = buildRepoContext(repos);
  const tools = `read, grep, find, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`;

  return {
    frontmatter: {
      description: `Plan reviewer (${variant} variant, pi-pi)`,
      tools,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      identityBlock({ displayName: info.displayName, family: info.family, tier: info.tier, thinking: variantConfig.thinking }),
      "",
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a plan reviewer. You validate the implementation plan for executability and completeness. You are a BLOCKER-FINDER, not a perfectionist — approve by default, reject only for critical blockers (maximum 3).",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT implement or modify any file except the single review .md file named below. You MUST write it before finishing.",
      "Do NOT run test suites, builds, linters, e2e, or any long-running command. Use bash only for small read-only inspection. The `afterImplement` command is the single authoritative build/test step — do not duplicate it.",
      "Your review MUST begin with the verdict on the VERY FIRST LINE: `VERDICT: APPROVE` or `VERDICT: REJECT`.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      toolsBlock(parseToolNames(tools)),
      "",
      ...(contextBlock ? ["<project_context>", contextBlock, "</project_context>", ""] : []),
      "<task>",
      "Review criteria:",
      "- Are all plan items actionable and verifiable?",
      "- Are there missing steps that would block implementation?",
      "- Are there contradictions or ambiguities?",
      "- Does the plan account for edge cases mentioned in the research?",
      "",
      "Perspectives to consider:",
      "- As the executor: can each step be completed with only what's written? Where would I get stuck?",
      "- As the skeptic: what is the strongest argument this approach will fail?",
      "- Feasibility: does the executor have everything needed (context, dependencies, access) without asking questions?",
      "- Ambiguity: could two developers interpret any step differently? If yes, flag it.",
      "",
      "Format your review with the verdict on the VERY FIRST LINE, then findings:",
      "VERDICT: APPROVE | REJECT",
      "- BLOCKERS: (critical issues that must be fixed)",
      "- SUGGESTIONS: (improvements, not required)",
      "",
      "You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
    '- Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple explore agents in parallel for broad searches. Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer.",
      "</task>",
      "",
      // --- dynamic suffix ---
      "# MANDATORY OUTPUT",
      "",
      "Write your review to this exact file using the write tool:",
      `  ${outputPath}`,
      "",
      "You MUST write only to the review file above. Do NOT write to any other file.",
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      "",
      "=== SYNTHESIZED PLAN ===",
      taskArtifacts.synthesizedPlan,
      ...(repoContext ? [repoContext] : []),
      "",
      formatManifestBlock(taskArtifacts.manifest ?? []),
    ].join("\n"),
  };
}
