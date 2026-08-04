import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCrossPassSummary, extractActionableHeadings, mergeSummary } from "./review-summary.js";

const tempDirs: string[] = [];
function makeTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-review-summary-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Write a code-review round file (phase "implement" -> code-reviews/).
function writeReview(taskDir: string, idx: number, reviewer: string, round: number, content: string) {
  const dir = join(taskDir, "code-reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(idx).padStart(3, "0")}_${reviewer}_round-${round}.md`), content, "utf-8");
}

function writePlanReview(taskDir: string, idx: number, reviewer: string, round: number, content: string) {
  const dir = join(taskDir, "plan-reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(idx).padStart(3, "0")}_${reviewer}_round-${round}.md`), content, "utf-8");
}

describe("extractActionableHeadings", () => {
  it("recognizes inline and header CRITICAL/MAJOR forms and skips none-bodies", () => {
    const content = [
      "## MAJOR: src/a.ts:12 null deref",
      "- CRITICAL: unbounded loop in b.ts:9",
      "### MAJOR",
      "None",
      "MINOR: cosmetic",
      "MAJOR: (none)",
    ].join("\n");
    const h = extractActionableHeadings(content);
    expect(h).toEqual(["MAJOR: src/a.ts:12 null deref", "CRITICAL: unbounded loop in b.ts:9"]);
  });

  it("recognizes plan BLOCKERS and brainstorm GAPS/INACCURACIES", () => {
    const content = ["## BLOCKERS: missing migration", "GAPS: no error path", "INACCURACIES: wrong file cited"].join("\n");
    expect(extractActionableHeadings(content)).toEqual([
      "BLOCKERS: missing migration",
      "GAPS: no error path",
      "INACCURACIES: wrong file cited",
    ]);
  });
});

describe("buildCrossPassSummary", () => {
  it("returns null for a single pass", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: APPROVE");
    expect(buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 1, approvedClean: true, capReached: false, maxPasses: 3 })).toBeNull();
  });

  it("marks a finding remaining when it persists into the final pass", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 leak");
    writeReview(dir, 1, "gpt", 2, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 leak");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    expect(out).toContain("Cross-pass review summary (implement, 2 passes");
    expect(out).toContain("reached the 2-pass cap");
    expect(out).toContain("[remaining] (gpt, pass 1) MAJOR: src/a.ts:12 leak");
  });

  it("marks a finding addressed when it disappears before the final pass", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 leak");
    writeReview(dir, 1, "gpt", 2, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: true, capReached: false, maxPasses: 3 })!;
    expect(out).toContain("[addressed (not re-reported)] (gpt, pass 1) MAJOR: src/a.ts:12 leak");
    expect(out).toContain("reviewers approved");
  });

  it("tracks the same path:line finding across passes and reviewers separately", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: at src/a.ts:12 wording X");
    writeReview(dir, 2, "fable", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 different wording");
    writeReview(dir, 1, "gpt", 2, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 CHANGED wording");
    writeReview(dir, 2, "fable", 2, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    // gpt's a.ts:12 persists to the final pass despite changed wording -> remaining.
    expect(out).toContain("[remaining] (gpt, pass 1)");
    // fable's a.ts:12 is gone by the final pass -> addressed.
    expect(out).toContain("[addressed (not re-reported)] (fable, pass 1)");
  });

  it("handles a 3-pass fixture with per-pass verdict lines", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: a.ts:1 x");
    writeReview(dir, 1, "gpt", 2, "VERDICT: NEEDS_CHANGES\n## MAJOR: b.ts:2 y");
    writeReview(dir, 1, "gpt", 3, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 3, approvedClean: true, capReached: false, maxPasses: 3 })!;
    expect(out).toContain("### Pass 1");
    expect(out).toContain("### Pass 2");
    expect(out).toContain("### Pass 3");
    expect(out).toContain("gpt: approve");
  });

  it("degrades to unknown verdict on malformed content without throwing", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "garbled no verdict header at all");
    writeReview(dir, 1, "gpt", 2, "still no verdict");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    expect(out).toContain("gpt: unknown");
  });

  it("returns null when passes are counted but no output exists on disk", () => {
    const dir = makeTaskDir();
    expect(buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 3, approvedClean: false, capReached: true, maxPasses: 3 })).toBeNull();
  });

  it("bounds output to ~32 KiB and reports the omitted count", () => {
    const dir = makeTaskDir();
    // Many distinct findings across two passes to blow past 32 KiB.
    const mk = (round: number) =>
      "VERDICT: NEEDS_CHANGES\n" +
      Array.from({ length: 1200 }, (_, i) => `## MAJOR: file${i}.ts:${round} finding ${i} ${"x".repeat(40)}`).join("\n");
    writeReview(dir, 1, "gpt", 1, mk(1));
    writeReview(dir, 1, "gpt", 2, mk(2));
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(out).toContain("further finding line(s) omitted");
  });

  it("works for the plan phase (plan-reviews dir, BLOCKERS)", () => {
    const dir = makeTaskDir();
    writePlanReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## BLOCKERS: plan.md:3 missing step");
    writePlanReview(dir, 1, "gpt", 2, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "plan", passes: 2, approvedClean: true, capReached: false, maxPasses: 3 })!;
    expect(out).toContain("[addressed (not re-reported)] (gpt, pass 1) BLOCKERS: plan.md:3 missing step");
  });
});

describe("mergeSummary", () => {
  it("passes the agent summary through unchanged when there is no cross-pass", () => {
    expect(mergeSummary("agent text", null)).toBe("agent text");
    expect(mergeSummary(undefined, null)).toBe("");
  });
  it("returns the cross-pass alone when the agent summary is empty", () => {
    expect(mergeSummary("  ", "CROSS")).toBe("CROSS");
  });
  it("joins both with a blank line", () => {
    expect(mergeSummary("agent", "CROSS")).toBe("agent\n\nCROSS");
  });
});
