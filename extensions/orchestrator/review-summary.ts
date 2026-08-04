import { parseVerdict, type ReviewVerdict } from "./phases/verdict.js";
import { loadPhaseReviewOutputs } from "./context.js";

// Deterministic cross-pass review summary (item 1). Assembled from the per-round
// reviewer outputs already persisted on disk (loadPhaseReviewOutputs), so it
// does NOT rely on an extra agent turn or on prior conversation turns that may
// have been compacted away.

// The authoritative actionable severities/sections this extractor recognizes.
// NOTE: this is intentionally BROADER than hasActionableFindings (verdict.ts),
// which matches only CRITICAL/MAJOR; the cross-pass summary also surfaces
// plan-review BLOCKERS and brainstorm GAPS/INACCURACIES.
const ACTIONABLE_TOKENS = ["CRITICAL", "MAJOR", "BLOCKERS", "GAPS", "INACCURACIES"];
const ACTIONABLE_RE = new RegExp(`^(?:${ACTIONABLE_TOKENS.join("|")})\\b`, "i");

// ~32 KiB output cap (UTF-8 bytes), per the design direction.
const MAX_SUMMARY_BYTES = 32 * 1024;

type FindingStatus = "remaining" | "addressed (not re-reported)";

interface Finding {
  anchor: string;
  reviewer: string;
  heading: string;
  firstPass: number;
  lastPass: number;
}

function reviewerName(fileName: string): string {
  return fileName.replace(/^\d+_/, "").replace(/_round-\d+\.md$/, "").replace(/\.md$/, "");
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// A finding's stable anchor identity: prefer a `path:line` reference embedded in
// the heading (so the same location tracks across passes and reviewers), else
// fall back to the exact normalized heading text. Reviewer identity is kept
// SEPARATE (never folded into the anchor).
function findingAnchor(heading: string): string {
  const loc = heading.match(/([\w./-]+):(\d+)/);
  if (loc) return `${loc[1]}:${loc[2]}`;
  return normalizeHeading(heading).toLowerCase();
}

// Extract actionable finding headings from one reviewer's output. Recognizes
// both inline (`- MAJOR: ...` / `MAJOR: ...`) and header (`## MAJOR ...`) forms,
// mirroring the line/header scan style of hasActionableFindings.
export function extractActionableHeadings(content: string): string[] {
  const out: string[] = [];
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const raw = rawLine.trim();
    if (!raw) continue;
    const header = raw.match(/^#{1,4}\s*(.*)$/);
    const candidate = header ? header[1].trim() : raw.replace(/^[-*]\s*/, "");
    const m = candidate.match(ACTIONABLE_RE);
    if (!m) continue;
    const body = candidate.slice(m[0].length).replace(/^\s*:?\s*/, "").trim();
    // Skip an empty / explicit "none" body (no real finding).
    const cleaned = body.replace(/[().*]/g, "").toLowerCase();
    if (cleaned === "" || /^none\b/.test(cleaned)) continue;
    out.push(normalizeHeading(candidate));
  }
  return out;
}

export interface CrossPassSummaryInput {
  taskDir: string;
  phase: string;
  passes: number;
  approvedClean: boolean;
  capReached: boolean;
  maxPasses: number;
}

// Build the deterministic cross-pass summary markdown. Returns null when there
// is not more than one completed pass with loadable output — callers keep the
// existing single-pass wording in that case.
export function buildCrossPassSummary(input: CrossPassSummaryInput): string | null {
  const { taskDir, phase, passes } = input;
  if (passes < 2) return null;

  interface PassRecord {
    pass: number;
    reviewers: { reviewer: string; verdict: ReviewVerdict; actionable: number }[];
  }
  const passRecords: PassRecord[] = [];
  const findings = new Map<string, Finding>();
  let anyOutput = false;

  for (let p = 1; p <= passes; p++) {
    const outputs = loadPhaseReviewOutputs(taskDir, phase, p);
    if (outputs.length === 0) continue;
    anyOutput = true;
    const reviewers: PassRecord["reviewers"] = [];
    for (const { name, content } of outputs) {
      const reviewer = reviewerName(name);
      const verdict = parseVerdict(content);
      const headings = extractActionableHeadings(content);
      reviewers.push({ reviewer, verdict, actionable: headings.length });
      for (const heading of headings) {
        const anchor = findingAnchor(heading);
        const key = `${reviewer}\u0000${anchor}`;
        const existing = findings.get(key);
        if (existing) {
          existing.lastPass = p;
        } else {
          findings.set(key, { anchor, reviewer, heading, firstPass: p, lastPass: p });
        }
      }
    }
    passRecords.push({ pass: p, reviewers });
  }

  if (!anyOutput) return null;

  const statusOf = (f: Finding): FindingStatus =>
    f.lastPass >= passes ? "remaining" : "addressed (not re-reported)";

  // Assemble markdown with a hard byte budget on BOTH the per-pass records AND
  // the findings section (a long unlimited-pass loop can make the pass records
  // alone large), so the FINAL output is always within MAX_SUMMARY_BYTES.
  const capNote = input.capReached
    ? `reached the ${input.maxPasses >= 999 ? "unlimited" : input.maxPasses}-pass cap`
    : input.approvedClean
      ? "reviewers approved"
      : "review loop ended";
  const title = `## Cross-pass review summary (${phase}, ${passes} passes — ${capNote})\n\n`;

  const passLineGroups = passRecords.map((pr) => {
    const g = [`### Pass ${pr.pass}`];
    for (const r of pr.reviewers) {
      g.push(`- ${r.reviewer}: ${r.verdict} (${r.actionable} actionable finding${r.actionable === 1 ? "" : "s"})`);
    }
    return g.join("\n") + "\n\n";
  });

  const sortedFindings = [...findings.values()].sort(
    (a, b) => a.firstPass - b.firstPass || a.reviewer.localeCompare(b.reviewer) || a.heading.localeCompare(b.heading),
  );
  const remaining = sortedFindings.filter((f) => statusOf(f) === "remaining");
  const addressed = sortedFindings.filter((f) => statusOf(f) !== "remaining");
  const findingsHeader = `### Findings (${remaining.length} remaining, ${addressed.length} addressed)\n`;
  const findingLines = sortedFindings.map((f) => `- [${statusOf(f)}] (${f.reviewer}, pass ${f.firstPass}) ${f.heading}\n`);

  // Greedily append chunks while they fit, reserving room for a worst-case
  // omission notice; return { text, omitted }.
  const omitNotice = (kind: string, n: number) => `\n_${n} ${kind} omitted to stay within the summary size budget._\n`;
  const fitChunks = (chunks: string[], prefixBytes: number, budget: number, kind: string): { text: string; omitted: number } => {
    const reserve = Buffer.byteLength(omitNotice(kind, chunks.length), "utf8");
    let text = "";
    for (let i = 0; i < chunks.length; i++) {
      if (prefixBytes + Buffer.byteLength(text + chunks[i], "utf8") + reserve > budget) {
        return { text: text + omitNotice(kind, chunks.length - i), omitted: chunks.length - i };
      }
      text += chunks[i];
    }
    return { text, omitted: 0 };
  };

  const titleBytes = Buffer.byteLength(title, "utf8");
  // Split the remaining budget: up to half for the pass records, the rest for
  // findings (findings also get whatever the pass records did not use).
  const afterTitle = MAX_SUMMARY_BYTES - titleBytes;
  const passBudget = titleBytes + Math.floor(afterTitle / 2);
  const passSection = fitChunks(passLineGroups, titleBytes, passBudget, "further pass record(s)");
  const usedSoFar = titleBytes + Buffer.byteLength(passSection.text, "utf8") + Buffer.byteLength(findingsHeader, "utf8");
  const findingsSection = fitChunks(findingLines, usedSoFar, MAX_SUMMARY_BYTES, "further finding line(s)");

  const out = title + passSection.text + findingsHeader + findingsSection.text;
  return out.trimEnd() + "\n";
}

// Merge the cross-pass summary with an agent-authored summary string for the
// menu/transition paths. When there is no cross-pass summary, the agent summary
// passes through unchanged.
export function mergeSummary(agentSummary: string | undefined, crossPass: string | null): string {
  const agent = (agentSummary ?? "").trim();
  if (!crossPass) return agent;
  if (!agent) return crossPass;
  return `${agent}\n\n${crossPass}`;
}
