import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { Phase } from "../state.js";
import { isReviewFileForRound, isReviewComplete } from "../review-files.js";
import { reviewPresetGroupForPhase } from "../config.js";

export type ReviewVerdict = "approve" | "changes" | "unknown";

const CHANGES_TOKENS = ["NEEDS_CHANGES", "NEEDS_WORK", "REJECT"];

export function parseVerdict(reviewContent: string): ReviewVerdict {
  const match = reviewContent.match(/VERDICT\**\s*:?\**\s*\n*\s*([A-Z_]+)/i);
  if (!match) return "unknown";
  const token = match[1].toUpperCase();
  if (CHANGES_TOKENS.includes(token)) return "changes";
  if (token === "APPROVE") return "approve";
  return "unknown";
}

function isNoneBody(text: string): boolean {
  const cleaned = text.trim().replace(/[().*]/g, "").toLowerCase();
  return cleaned === "" || /^none\b/.test(cleaned);
}

export function hasActionableFindings(reviewContent: string): boolean {
  const lines = reviewContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();

    const inline = raw.replace(/^[-*]\s*/, "").match(/^(CRITICAL|MAJOR)\b\s*:?(.*)$/i);
    if (inline && !raw.startsWith("#")) {
      if (!isNoneBody(inline[2])) return true;
      continue;
    }

    const header = raw.match(/^#{1,4}\s*(CRITICAL|MAJOR)\b\s*:?(.*)$/i);
    if (header) {
      if (header[2].trim() !== "" && !isNoneBody(header[2])) return true;
      let body = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,4}\s/.test(lines[j].trim())) break;
        body += lines[j] + "\n";
      }
      const meaningful = body
        .split("\n")
        .map((l) => l.trim().replace(/^[-*]\s*/, ""))
        .filter((l) => l.length > 0);
      if (meaningful.length > 0 && !meaningful.every((l) => isNoneBody(l))) return true;
    }
  }
  return false;
}

export function reviewsDirForPhase(taskDir: string, phase: Phase): string {
  const group = reviewPresetGroupForPhase(phase);
  if (group === "brainstormReviewers") return join(taskDir, "brainstorm-reviews");
  if (group === "planReviewers") return join(taskDir, "plan-reviews");
  return join(taskDir, "code-reviews");
}

export function reviewPassUnanimousApprove(
  taskDir: string,
  phase: Phase,
  round: number,
  expectedReviewerCount: number,
): boolean {
  if (expectedReviewerCount <= 0) return false;
  const dir = reviewsDirForPhase(taskDir, phase);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => isReviewFileForRound(f, round));
  if (files.length < expectedReviewerCount) return false;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf-8");
    } catch {
      return false;
    }
    // An incomplete/stub review (reviewer ran out of budget or a written-in
    // placeholder) is never an approval, regardless of any partial content.
    if (!isReviewComplete(content)) return false;
    if (parseVerdict(content) !== "approve") return false;
    if (hasActionableFindings(content)) return false;
  }
  return true;
}

// Count MINOR/NIT (non-actionable) findings across all reviewer outputs for a
// round. Used to describe a minor-only pass ("passed with N optional comments").
// Mirrors hasActionableFindings' line/header scan but for the MINOR|NIT tokens.
export function countOptionalComments(reviewContent: string): number {
  const lines = reviewContent.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const inline = raw.replace(/^[-*]\s*/, "").match(/^(MINOR|NIT)\b\s*:?(.*)$/i);
    if (inline && !raw.startsWith("#")) {
      if (!isNoneBody(inline[2])) count++;
      continue;
    }
    const header = raw.match(/^#{1,4}\s*(MINOR|NIT)\b\s*:?(.*)$/i);
    if (header) {
      // Inline body on the header line counts directly.
      if (header[2].trim() !== "") {
        if (!isNoneBody(header[2])) count++;
        continue;
      }
      // Empty header remainder: the finding lives on the following lines (until
      // the next header). Mirror hasActionableFindings so a `### MINOR` block
      // with its text below is not silently dropped.
      let body = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,4}\s/.test(lines[j].trim())) break;
        body += lines[j] + "\n";
      }
      const meaningful = body
        .split("\n")
        .map((l) => l.trim().replace(/^[-*]\s*/, ""))
        .filter((l) => l.length > 0);
      if (meaningful.length > 0 && !meaningful.every((l) => isNoneBody(l))) count++;
    }
  }
  return count;
}

// A review pass is MINOR-ONLY when every expected reviewer produced output, NONE
// has an actionable (CRITICAL/MAJOR) finding, but it is NOT the fully-clean
// unanimous-approve case (there ARE optional MINOR/NIT comments or a non-approve
// verdict that carries no actionable finding). This is the item-7 "review
// broadly passed, here are optional comments" state. Returns the optional-comment
// count (0 means "not minor-only" — either clean-approve or actionable/incomplete).
export function reviewPassMinorOnly(
  taskDir: string,
  phase: Phase,
  round: number,
  expectedReviewerCount: number,
): { minorOnly: boolean; optionalComments: number } {
  const notMinor = { minorOnly: false, optionalComments: 0 };
  if (expectedReviewerCount <= 0) return notMinor;
  const dir = reviewsDirForPhase(taskDir, phase);
  if (!existsSync(dir)) return notMinor;
  const files = readdirSync(dir).filter((f) => isReviewFileForRound(f, round));
  if (files.length < expectedReviewerCount) return notMinor;
  let optionalComments = 0;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf-8");
    } catch {
      return notMinor;
    }
    // An incomplete/stub/placeholder review is not a clean minor-only pass —
    // treat it as needing a real re-review.
    if (!isReviewComplete(content)) return notMinor;
    // Any actionable finding disqualifies minor-only (that's a real re-review).
    if (hasActionableFindings(content)) return notMinor;
    // A NON-approve verdict (NEEDS_CHANGES/REJECT) is NOT minor-only even when
    // it carries no severity-marked findings — reviewer format drift (prose
    // findings, no MAJOR:/CRITICAL: bullet) must NOT be silently treated as a
    // clean pass. Such a verdict stays on the existing re-review path.
    if (parseVerdict(content) !== "approve") return notMinor;
    optionalComments += countOptionalComments(content);
  }
  // Every reviewer approved. Zero optional comments = the fully-clean pass
  // (handled by reviewPassUnanimousApprove), not minor-only.
  if (optionalComments === 0) return notMinor;
  return { minorOnly: true, optionalComments };
}
