import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface ReviewContext {
  diffRange: string;
  prUrl: string | null;
  prContext: string | null;
}

const DEFAULT_REVIEW_CONTEXT: ReviewContext = {
  diffRange: "uncommitted",
  prUrl: null,
  prContext: null,
};

export function reviewContextPath(taskDir: string): string {
  return join(taskDir, "REVIEW_CONTEXT.md");
}

export function serializeReviewContext(context: ReviewContext): string {
  const prUrl = context.prUrl ?? "";
  const prContext = context.prContext ?? "";
  return [
    "# Review Context",
    "",
    `diffRange: ${context.diffRange}`,
    `prUrl: ${prUrl}`,
    "",
    "## PR Context",
    prContext,
    "",
  ].join("\n");
}

export function saveReviewContext(taskDir: string, context: ReviewContext): void {
  writeFileSync(reviewContextPath(taskDir), serializeReviewContext(context), "utf-8");
}

export function loadReviewContext(taskDir: string): ReviewContext {
  const filePath = reviewContextPath(taskDir);
  if (!existsSync(filePath)) return { ...DEFAULT_REVIEW_CONTEXT };
  const content = readFileSync(filePath, "utf-8");
  const diffMatch = content.match(/^diffRange:\s*(.*)$/m);
  const prUrlMatch = content.match(/^prUrl:\s*(.*)$/m);
  const contextMatch = content.match(/^## PR Context\n([\s\S]*)$/m);

  const diffRange = diffMatch?.[1]?.trim() || DEFAULT_REVIEW_CONTEXT.diffRange;
  const prUrlRaw = prUrlMatch?.[1]?.trim() ?? "";
  const prUrl = prUrlRaw.length > 0 ? prUrlRaw : null;
  const prContextRaw = contextMatch?.[1] ?? "";
  const prContext = prContextRaw.trim().length > 0 ? prContextRaw.trim() : null;

  return { diffRange, prUrl, prContext };
}

export function reviewSystemPrompt(taskDir: string, reviewContext: ReviewContext): string {
  const contextPath = reviewContextPath(taskDir);
  const prContextText = reviewContext.prContext ? reviewContext.prContext : "(none)";
  return [
    "[PI-PI — REVIEW PHASE]",
    "",
    `Task directory: ${taskDir}`,
    `Review context file: ${contextPath}`,
    `Diff range: ${reviewContext.diffRange}`,
    `PR URL: ${reviewContext.prUrl ?? "(none)"}`,
    "",
    "Use available tools to review code changes in depth.",
    "You may use read/lsp and git commands (for example git diff, git show, git log) to inspect all relevant changes.",
    "",
    "PR context:",
    prContextText,
    "",
    "If PR context exists, include PR title/body/comments and review feedback in your analysis.",
    "",
    "Write required artifacts:",
    `- ${taskDir}/USER_REQUEST.md with concise review problem statement`,
    `- ${taskDir}/RESEARCH.md with detailed technical analysis`,
    "",
    "Focus on correctness, edge cases, style consistency, missing tests, and potential bugs.",
    "When complete, call pp_phase_complete with a brief summary.",
  ].join("\n");
}
