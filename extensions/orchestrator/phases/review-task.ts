export interface ReviewContext {
  diffRange: string;
  prUrl: string | null;
  prContext: string | null;
}

export function reviewSystemPrompt(taskDir: string, reviewContext: ReviewContext): string {
  const prSection = reviewContext.prContext
    ? ["PR context:", reviewContext.prContext, ""]
    : [];
  return [
    "[PI-PI — REVIEW PHASE]",
    "",
    `Diff range: ${reviewContext.diffRange}`,
    reviewContext.prUrl ? `PR URL: ${reviewContext.prUrl}` : "",
    "",
    ...prSection,
    "Use available tools to review code changes in depth.",
    "Use read, lsp, git diff, git show, git log to inspect all relevant changes.",
    "If PR context is provided, consider PR title/body/comments in your analysis.",
    "",
    "Write required artifacts:",
    `- ${taskDir}/USER_REQUEST.md — concise problem statement with review findings`,
    `- ${taskDir}/RESEARCH.md — detailed technical analysis of issues found`,
    "",
    "USER_REQUEST.md format:",
    "- # User Request",
    "- ## Problem",
    "- ## Constraints",
    "",
    "RESEARCH.md format:",
    "- ## Affected Code",
    "- ## Architecture Context",
    "- ## Constraints & Edge Cases",
    "- ## Open Questions (optional)",
    "",
    "Focus on: correctness, edge cases, style consistency, missing tests, potential bugs.",
    "",
    "When complete, call pp_phase_complete with a brief summary of findings.",
  ].filter(Boolean).join("\n");
}
