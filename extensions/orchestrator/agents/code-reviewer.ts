import type { PiPiConfig } from "../config.js";
import { TOOL_ROUTING, ALL_CBM_TOOLS, EXA_TOOLS, WORKING_PRINCIPLES_READONLY, COMMUNICATION } from "./tool-routing.js";

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
      tools: `read, grep, find, ls, bash, write, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: variantConfig.model,
      thinking: variantConfig.thinking,
      max_turns: 30,
      prompt_mode: "replace",
    },
    prompt: [
      // --- static prefix (cacheable) ---
      "You are a code reviewer. Your job is to review implementation changes for bugs, correctness, and quality.",
      "",
      WORKING_PRINCIPLES_READONLY,
      "",
      COMMUNICATION,
      "",
      TOOL_ROUTING,
      "",
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
      "Format your review as:",
      "- CRITICAL: (must fix — with file:line evidence)",
      "- MAJOR: (should fix — with evidence)",
      "- MINOR: (nice to have)",
      "- OPEN QUESTIONS: (low-confidence concerns, speculative follow-ups)",
      "- VERDICT: APPROVE or NEEDS_CHANGES",
      "",
      'You can spawn subagents: Agent(subagent_type="Explore", ...) for codebase, Agent(subagent_type="Librarian", ...) for external docs.',
      "",
      // --- dynamic suffix ---
      "Write your review to this exact file:",
      `  ${outputPath}`,
      "",
      "You MUST NOT write to any other file. Only write .md files inside .pp/state/.",
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
