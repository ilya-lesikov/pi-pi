import type { VariantConfig } from "../config.js";
import { loadAllContextFiles, formatManifestBlock } from "../context.js";
import { resolveModel, getModelInfo } from "../model-registry.js";
import type { RepoInfo } from "../repo-utils.js";
import { buildRepoContext } from "./repo-context.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createCodeReviewerAgent(
  variant: string,
  variants: Record<string, VariantConfig>,
  taskArtifacts: { userRequest: string; research: string; synthesizedPlan?: string; manifest?: { title: string; path: string }[] },
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
  // A standalone review task (phase "review") has no synthesized plan: review the
  // diff against USER_REQUEST.md/RESEARCH.md, not an implementation plan.
  const hasPlan = typeof taskArtifacts.synthesizedPlan === "string" && taskArtifacts.synthesizedPlan.trim().length > 0;

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
      "Do NOT run test suites, builds, linters, e2e, or any long-running command. Use bash only for `git diff`/`git status` and small read-only inspection. The `afterImplement` command is the single authoritative build/test step — do not duplicate it.",
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
      hasPlan
        ? "6. Check the implementation against the plan"
        : "6. Check the changes against USER_REQUEST.md and RESEARCH.md (there is no implementation plan for a standalone review)",
      "",
      "Review criteria:",
      "- Bugs: logic errors, off-by-ones, null handling, race conditions",
      hasPlan
        ? "- Correctness: does it match the plan and user request?"
        : "- Correctness: does it match the user request and the reviewed scope?",
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
      "After the findings, include a machine-readable ANCHORS block so the synthesizer can place",
      "the findings at their exact locations (in source AI_COMMENT markers and/or GitHub PR line comments).",
      "Emit one line per actionable finding (CRITICAL/MAJOR/MINOR), in this EXACT format:",
      "ANCHORS:",
      "<relative/path/from/repo/root>:<line> — <severity>: <one-line finding>",
      "Rules:",
      "- Use the repo-relative path (as `git diff` shows it) and a single 1-based line number on the NEW side of the diff.",
      "- One finding per line; omit findings you cannot pin to a concrete file:line (keep those in OPEN QUESTIONS).",
      "- If there are no actionable findings, write `ANCHORS:` followed by `(none)`.",
      "",
      "You may spawn ONLY explore/librarian subagents (subagent_type is REQUIRED — calls without it are rejected):",
    '- Agent(subagent_type="explore", ...) — codebase research. Prefer this for most lookups. Fast and cheap.',
    '- Agent(subagent_type="librarian", ...) — external docs, library APIs, web research.',
    "Spawn multiple explore agents in parallel for broad searches. Do NOT spawn task, advisor, advisor2, advisor3, deep-debugger, or reviewer.",
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
      ...(hasPlan ? ["=== SYNTHESIZED PLAN ===", taskArtifacts.synthesizedPlan as string, ""] : []),
      ...(repoContext ? [repoContext] : []),
      "",
      formatManifestBlock(taskArtifacts.manifest ?? []),
    ].join("\n"),
  };
}
