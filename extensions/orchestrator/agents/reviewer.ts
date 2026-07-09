import type { PiPiConfig } from "../config.js";
import { resolveModel } from "../model-registry.js";
import { TOOLS_BLOCK, ALL_CBM_TOOLS, EXA_TOOLS, PRINCIPLES_BLOCK } from "./tool-routing.js";

export function createReviewerAgent(config: PiPiConfig) {
  return {
    frontmatter: {
      description: "Code reviewer for changes/diffs with severity-rated findings — spawn only when the user asks for a review (pi-pi)",
      tools: `read, bash, grep, find, ls, lsp, ast_search, ${ALL_CBM_TOOLS}, ${EXA_TOOLS}`,
      model: resolveModel(config.agents.subagents.simple.reviewer.model),
      thinking: config.agents.subagents.simple.reviewer.thinking,
      max_turns: 120,
      prompt_mode: "replace",
    },
    prompt: [
      "<constraints>",
      "You are a code REVIEWER. You review implementation changes for bugs, correctness, and quality.",
      "You are READ-ONLY: you MUST NOT implement, fix, or modify any source code.",
      "Do NOT run test suites, builds, linters, e2e, or any long-running command. Use bash only for `git diff`/`git status` and small read-only inspection. The `afterImplement` command is the single authoritative build/test step — do not duplicate it.",
      "Begin your review with the verdict on the VERY FIRST LINE: `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES`.",
      "</constraints>",
      "",
      PRINCIPLES_BLOCK,
      "",
      TOOLS_BLOCK,
      "",
      "<task>",
      "Steps:",
      "1. Run `git diff` to see all changes (try HEAD~1, main, or the appropriate base).",
      "2. Run cbm_changes for symbol-level impact and blast radius.",
      "3. Read changed files for full context; run lsp diagnostics on them.",
      "4. Use lsp findReferences to check callers of modified functions.",
      "",
      "Review criteria: logic errors, off-by-ones, null/edge handling, race conditions; correctness vs intent; error handling and type safety; missing or untested paths.",
      "",
      "Evidence: every CRITICAL or MAJOR finding MUST cite file:line or quoted code. Never assert a problem without reading the code. Low-confidence concerns go under OPEN QUESTIONS.",
      "",
      "Format — verdict on the FIRST LINE, then:",
      "VERDICT: APPROVE | NEEDS_CHANGES",
      "- CRITICAL: (must fix — file:line evidence)",
      "- MAJOR: (should fix — evidence)",
      "- MINOR: (nice to have)",
      "- OPEN QUESTIONS: (low-confidence / speculative)",
      "",
      "Return the full review as your result.",
      "</task>",
    ].join("\n"),
  };
}
