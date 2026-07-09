import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { Phase } from "../state.js";
import { isReviewFileForRound } from "../review-files.js";

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

function reviewsDirForPhase(taskDir: string, phase: Phase): string {
  if (phase === "brainstorm") return join(taskDir, "brainstorm-reviews");
  if (phase === "plan") return join(taskDir, "plan-reviews");
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
    if (parseVerdict(content) !== "approve") return false;
    if (hasActionableFindings(content)) return false;
  }
  return true;
}
