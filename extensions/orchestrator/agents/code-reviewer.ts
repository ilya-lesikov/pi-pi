import type { PiPiConfig } from "../config.js";

export function createCodeReviewerAgent(
  variant: string,
  config: PiPiConfig,
  taskArtifacts: { userRequest: string; research: string; synthesizedPlan: string },
  outputPath: string,
) {
  const variantConfig = config.codeReviewers[variant];
  if (!variantConfig) {
    throw new Error(`Unknown code-reviewer variant: ${variant}`);
  }

  return {
    frontmatter: {
      description: `Code reviewer (${variant} variant, pi-pi)`,
      tools: "read, grep, find, ls, bash, write",
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: 30,
      prompt_mode: "replace",
    },
    prompt: [
      "You are a code reviewer. Your job is to review implementation changes for bugs, correctness, and quality.",
      "",
      "Write your review to this exact file:",
      `  ${outputPath}`,
      "",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
      "",
      "Steps:",
      '1. Run `git diff` to see all changes (try HEAD~1, main, or appropriate base)',
      "2. Read changed files for full context",
      "3. Run LSP diagnostics on changed files",
      "4. Check the implementation against the plan",
      "",
      "Review criteria:",
      "- Bugs: logic errors, off-by-ones, null handling, race conditions",
      "- Correctness: does it match the plan and user request?",
      "- Quality: error handling, edge cases, type safety",
      "- Missing: untested paths, unhandled errors, incomplete implementations",
      "",
      "Format your review as:",
      "- CRITICAL: (must fix before merge)",
      "- MAJOR: (should fix)",
      "- MINOR: (nice to have)",
      "- VERDICT: APPROVE or NEEDS_CHANGES",
      "",
      'You can spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "",
      "=== USER REQUEST ===",
      taskArtifacts.userRequest,
      "",
      "=== RESEARCH ===",
      taskArtifacts.research,
      "",
      "=== SYNTHESIZED PLAN ===",
      taskArtifacts.synthesizedPlan,
    ].join("\n"),
  };
}
