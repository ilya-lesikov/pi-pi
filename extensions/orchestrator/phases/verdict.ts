import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { Phase } from "../state.js";

export type ReviewVerdict = "approve" | "changes" | "unknown";

const APPROVE_TOKENS = ["APPROVE"];
const CHANGES_TOKENS = ["NEEDS_CHANGES", "NEEDS_WORK", "REJECT"];

export function parseVerdict(reviewContent: string): ReviewVerdict {
  const match = reviewContent.match(/VERDICT:\s*([A-Z_]+)/i);
  if (!match) return "unknown";
  const token = match[1].toUpperCase();
  if (CHANGES_TOKENS.includes(token)) return "changes";
  if (APPROVE_TOKENS.includes(token)) return "approve";
  return "unknown";
}

export function hasActionableFindings(reviewContent: string): boolean {
  for (const rawLine of reviewContent.split("\n")) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    const m = line.match(/^(CRITICAL|MAJOR)\b\s*:?(.*)$/i);
    if (!m) continue;
    const rest = m[2].trim().replace(/[():]/g, "").toLowerCase();
    if (rest === "" || rest === "none" || rest.startsWith("none")) continue;
    return true;
  }
  return false;
}

function reviewsDirForPhase(taskDir: string, phase: Phase): string {
  if (phase === "brainstorm") return join(taskDir, "brainstorm-reviews");
  if (phase === "plan") return join(taskDir, "plan-reviews");
  return join(taskDir, "code-reviews");
}

export function reviewPassUnanimousApprove(taskDir: string, phase: Phase, round: number): boolean {
  const dir = reviewsDirForPhase(taskDir, phase);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter(
    (f) => f.includes(`round-${round}`) && !f.includes("final") && f.endsWith(".md"),
  );
  if (files.length === 0) return false;
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
