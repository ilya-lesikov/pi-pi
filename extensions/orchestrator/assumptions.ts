import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ASSUMPTIONS_PATH = "artifacts/ASSUMPTIONS.md";

// The optional artifact the main agent writes unverified assumptions to (see
// agents/constraints.ts assumptionsRule). Absence — or an explicit
// `_No open assumptions._` sentinel — means there are none. Entries are markdown
// list items carrying statement/confidence/basis/invalidation test/decision
// impact plus an open|resolved status marker.
export interface AssumptionEntry {
  text: string;
  confidence: "low" | "med" | "high" | "unknown";
  resolved: boolean;
}

function assumptionsFile(taskDir: string): string {
  return join(taskDir, "artifacts", "ASSUMPTIONS.md");
}

// Split the file into top-level list items (each assumption). A list item starts
// with `-`/`*`/`1.`; continuation/detail lines are folded into the current item
// so multi-line entries parse as one.
function parseEntries(content: string): AssumptionEntry[] {
  const entries: AssumptionEntry[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.join(" ").trim();
    if (text) entries.push(classify(text));
    current = null;
  };
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      current = [line.replace(/^\s*([-*]|\d+\.)\s+/, "")];
    } else if (current && line.trim()) {
      current.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  return entries;
}

function classify(text: string): AssumptionEntry {
  const lower = text.toLowerCase();
  const resolved = /\bresolved\b/.test(lower) && !/\bstatus:\s*open\b/.test(lower);
  let confidence: AssumptionEntry["confidence"] = "unknown";
  if (/confidence:?\s*low\b/.test(lower) || /\blow confidence\b/.test(lower)) confidence = "low";
  else if (/confidence:?\s*med(ium)?\b/.test(lower) || /\bmed(ium)? confidence\b/.test(lower)) confidence = "med";
  else if (/confidence:?\s*high\b/.test(lower) || /\bhigh confidence\b/.test(lower)) confidence = "high";
  return { text, confidence, resolved };
}

export function readAssumptions(taskDir: string): AssumptionEntry[] {
  const file = assumptionsFile(taskDir);
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8");
  if (/^\s*_no open assumptions\._\s*$/im.test(content) && parseEntries(content).length === 0) return [];
  return parseEntries(content);
}

// A one-line /pp gate banner when there are open low/med-confidence assumptions
// the user should double-check; null when there is nothing worth surfacing.
export function openAssumptionsBanner(taskDir: string): string | null {
  const open = readAssumptions(taskDir).filter((e) => !e.resolved && (e.confidence === "low" || e.confidence === "med"));
  if (open.length === 0) return null;
  return `⚠ ${open.length} unresolved low/medium-confidence assumption${open.length === 1 ? "" : "s"} recorded — review ${ASSUMPTIONS_PATH} before advancing.`;
}

// End-of-run summary for an autonomous task that never hit a /pp gate: lists every
// recorded assumption (open and resolved, all confidence levels), or states none.
export function terminalAssumptionsSummary(taskDir: string): string {
  const entries = readAssumptions(taskDir);
  if (entries.length === 0) return "Assumptions: none recorded.";
  const lines = entries.map((e) => {
    const status = e.resolved ? "resolved" : "open";
    const conf = e.confidence === "unknown" ? "" : `, ${e.confidence}`;
    return `- [${status}${conf}] ${e.text}`;
  });
  return [`Assumptions recorded this run (${entries.length}):`, ...lines].join("\n");
}
