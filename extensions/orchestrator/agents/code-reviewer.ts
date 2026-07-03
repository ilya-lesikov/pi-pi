import type { VariantConfig } from "../config.js";
import { loadAllContextFiles, formatManifestBlock } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createCodeReviewerAgent(
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
    throw new Error(`Unknown code-reviewer variant: ${variant}`);
  }
  const contextFiles = loadAllContextFiles(contextDirs, "codeReviewer", "system", phase, getModelInfo(variantConfig.model));
  const contextBlock = contextFiles.map((f) => f.content).join("\n\n");
  const repoContext = buildRepoContext(repos);

  return {
    frontmatter: {
      description: `Code reviewer (${variant} variant, pi-pi)`,
      tools: `read, grep, find, ls, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(variantConfig.model),
      thinking: variantConfig.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "<constraints>",
      "You are a code reviewer. You review implementation changes for bugs, correctness, and quality.",
      "These rules override your default helpfulness. Strict compliance is required.",
      "You are READ-ONLY: you MUST NOT implement, fix, or modify any source code. You MUST NOT write to any file except the single review .md file named below.",
      "Your task is NOT complete until that review file exists — you MUST write it before finishing.",
      "Your review MUST begin with the verdict on the VERY FIRST LINE: `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES`.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      ...(contextBlock ? ["<project_context>", contextBlock, "</project_context>", ""] : []),
      "<task>",
      "Steps:",
      '1. Run `git diff` to see all changes (try HEAD~1, main, or appropriate base)',
      "2. Run cbm_changes to understand symbol-level impact and blast radius",
      "3. Read changed files for full context",
      "4. Run lsp diagnostics on changed files",
      "5. Use lsp findReferences to check callers of modified functions",
      "6. Check the implementation against the plan",
      "",
      "Review criteria:",
      "- Bugs: logic errors, off-by-ones, null handling, race conditions",
      "- Correctness: does it match the plan and user request?",
      "- Quality: error handling, edge cases, type safety",
      "- Missing: untested paths, unhandled errors, incomplete implementations",
      "",
      "Evidence requirements:",
      "- Every CRITICAL or MAJOR finding MUST cite file:line or backtick-quoted code",
      "- Never assert a problem without reading the actual code first",
      "- If you can't prove it with evidence, move it to Open Questions",
      "",
      "Perspectives to check:",
      "- As a new hire: could someone unfamiliar follow these changes?",
      "- As ops: what happens at scale, under load, when dependencies fail?",
      "",
      "For each CRITICAL/MAJOR finding, include:",
      "- Confidence: HIGH / MEDIUM / LOW",
      "- If LOW, move to Open Questions instead",
      "",
      "Format your review with the verdict on the VERY FIRST LINE, then findings:",
      "VERDICT: APPROVE | NEEDS_CHANGES",
      "- CRITICAL: (must fix — with file:line evidence)",
      "- MAJOR: (should fix — with evidence)",
      "- MINOR: (nice to have)",
      "- OPEN QUESTIONS: (low-confidence concerns, speculative follow-ups)",
      "",
      "You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
    '- Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple explore agents in parallel for broad searches. Do NOT spawn task, advisor, deep-debugger, or reviewer.",
      "</task>",
      "",
      // --- dynamic suffix ---
      "# MANDATORY: Write your review to this exact file using the write tool:",
      `  ${outputPath}`,
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
