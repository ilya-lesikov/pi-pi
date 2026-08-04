import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCrossPassSummary, buildCrossPassDigest, extractActionableHeadings, mergeSummary, mergeMenuSummary } from "./review-summary.js";

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

  it("merges the same path:line anchor across reviewers into ONE finding, remaining if ANY reviewer re-reports it", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: at src/a.ts:12 wording X");
    writeReview(dir, 2, "fable", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 different wording");
    writeReview(dir, 1, "gpt", 2, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 CHANGED wording");
    writeReview(dir, 2, "fable", 2, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    // src/a.ts:12 is ONE finding keyed by anchor; gpt re-reported it in the
    // final pass -> remaining. Both reviewers are listed on the single line.
    expect(out).toContain("[remaining] (fable, gpt, pass 1)");
    // It must NOT also appear as a separate addressed line for the same anchor.
    expect(out).not.toContain("[addressed (not re-reported)]");
    expect((out.match(/src\/a\.ts:12/g) ?? []).length).toBe(1);
  });

  it("keeps a finding remaining when the final pass never ran (missing round is not proof of a fix)", () => {
    const dir = makeTaskDir();
    // Two passes claimed, but only pass 1 produced output; pass 2 is missing.
    writeReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## MAJOR: src/a.ts:12 leak");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    // Absence in a NON-present final pass must NOT be reported as addressed.
    expect(out).toContain("[remaining] (gpt, pass 1) MAJOR: src/a.ts:12 leak");
    expect(out).toContain("(no reviewer output on record for this pass)");
  });

  it("extracts findings written as bullets under an empty severity section header", () => {
    const dir = makeTaskDir();
    const body = ["VERDICT: NEEDS_CHANGES", "## MAJOR", "- src/x.ts:5 off-by-one", "- src/y.ts:9 null deref"].join("\n");
    writeReview(dir, 1, "gpt", 1, body);
    writeReview(dir, 1, "gpt", 2, body);
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes: 2, approvedClean: false, capReached: true, maxPasses: 2 })!;
    expect(out).toContain("MAJOR: src/x.ts:5 off-by-one");
    expect(out).toContain("MAJOR: src/y.ts:9 null deref");
  });

  it("captures an UNBULLETED finding line under a severity header (mirrors hasActionableFindings)", () => {
    // hasActionableFindings treats `### CRITICAL\nnull deref at x.ts:1` as a
    // real finding, so the cross-pass extractor must not drop the unbulleted
    // line — otherwise a required finding would be silently omitted.
    const content = ["### CRITICAL", "null deref at x.ts:1", "", "### MAJOR", "None."].join("\n");
    expect(extractActionableHeadings(content)).toEqual(["CRITICAL: null deref at x.ts:1"]);
  });

  it("captures both bulleted and unbulleted body lines, skipping none-bodies", () => {
    const content = ["## MAJOR", "- real.ts:1 finding one", "prose finding two at real.ts:2"].join("\n");
    expect(extractActionableHeadings(content)).toEqual([
      "MAJOR: real.ts:1 finding one",
      "MAJOR: prose finding two at real.ts:2",
    ]);
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

  it("bounds a many-pass header (999 approving passes, zero findings) within 32 KiB", () => {
    const dir = makeTaskDir();
    const passes = 999;
    for (let p = 1; p <= passes; p++) {
      writeReview(dir, 1, "gpt-reviewer-with-a-longish-name", p, "VERDICT: APPROVE");
      writeReview(dir, 2, "fable-reviewer-with-a-longish-name", p, "VERDICT: APPROVE");
    }
    const out = buildCrossPassSummary({ taskDir: dir, phase: "implement", passes, approvedClean: true, capReached: false, maxPasses: 999 })!;
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(out).toContain("pass record(s) omitted");
  });

  it("works for the plan phase (plan-reviews dir, BLOCKERS)", () => {
    const dir = makeTaskDir();
    writePlanReview(dir, 1, "gpt", 1, "VERDICT: NEEDS_CHANGES\n## BLOCKERS: plan.md:3 missing step");
    writePlanReview(dir, 1, "gpt", 2, "VERDICT: APPROVE");
    const out = buildCrossPassSummary({ taskDir: dir, phase: "plan", passes: 2, approvedClean: true, capReached: false, maxPasses: 3 })!;
    expect(out).toContain("[addressed (not re-reported)] (gpt, pass 1) BLOCKERS: plan.md:3 missing step");
  });
});

describe("buildCrossPassDigest", () => {
  const threePass = (dir: string) => {
    writeReview(dir, 1, "fable", 1, "VERDICT: NEEDS_CHANGES\n- MAJOR: broken thing at src/a.ts:10 with a very long explanatory paragraph that would bloat any dialog it was pasted into, going on at length about mechanisms and fix shapes.\n");
    writeReview(dir, 2, "gpt", 1, "VERDICT: UNKNOWN\n");
    writeReview(dir, 3, "fable", 2, "VERDICT: APPROVE\n");
    writeReview(dir, 4, "gpt", 2, "VERDICT: NEEDS_CHANGES\n- MAJOR: other thing at src/b.ts:20 also with a lengthy paragraph of reviewer prose attached to it.\n");
    writeReview(dir, 5, "fable", 3, "VERDICT: APPROVE\n");
    writeReview(dir, 6, "gpt", 3, "VERDICT: APPROVE\n");
  };

  it("is a single line naming passes, outcome, and finding counts", () => {
    const dir = makeTaskDir();
    threePass(dir);
    const digest = buildCrossPassDigest({
      taskDir: dir, phase: "implement", passes: 3,
      approvedClean: true, capReached: false, maxPasses: 3,
    });
    expect(digest).toBe("Review: 3 passes, reviewers approved — 2 findings addressed, 0 remaining.");
  });

  it("omits per-finding prose entirely, however verbose the reviewers were", () => {
    const dir = makeTaskDir();
    threePass(dir);
    const digest = buildCrossPassDigest({
      taskDir: dir, phase: "implement", passes: 3,
      approvedClean: true, capReached: false, maxPasses: 3,
    })!;
    expect(digest).not.toContain("src/a.ts:10");
    expect(digest).not.toContain("bloat any dialog");
    expect(digest.split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThan(200);
  });

  it("reports remaining findings and a reached cap", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "fable", 1, "VERDICT: NEEDS_CHANGES\n- MAJOR: still broken at src/a.ts:10\n");
    writeReview(dir, 2, "fable", 2, "VERDICT: NEEDS_CHANGES\n- MAJOR: still broken at src/a.ts:10\n");
    const digest = buildCrossPassDigest({
      taskDir: dir, phase: "implement", passes: 2,
      approvedClean: false, capReached: true, maxPasses: 2,
    });
    expect(digest).toBe("Review: 2 passes, reached the 2-pass cap — 0 findings addressed, 1 remaining.");
  });

  it("returns null for a single pass, like the full summary", () => {
    const dir = makeTaskDir();
    writeReview(dir, 1, "fable", 1, "VERDICT: APPROVE\n");
    expect(buildCrossPassDigest({
      taskDir: dir, phase: "implement", passes: 1,
      approvedClean: true, capReached: false, maxPasses: 3,
    })).toBeNull();
  });
});

describe("mergeMenuSummary", () => {
  it("keeps a short agent summary intact and appends the digest", () => {
    expect(mergeMenuSummary("Did the thing.", "Review: 2 passes, reviewers approved — 1 findings addressed, 0 remaining."))
      .toBe("Did the thing.\n\nReview: 2 passes, reviewers approved — 1 findings addressed, 0 remaining.");
  });

  it("truncates an enormous agent summary at a line boundary and points to the message above", () => {
    const huge = Array.from({ length: 60 }, (_, i) => `Fix ${i}: a long paragraph of detail about what changed and why, repeated to blow the budget.`).join("\n\n");
    const out = mergeMenuSummary(huge, null);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(1200);
    expect(out).toContain("Fix 0:");
    expect(out).not.toContain("Fix 59:");
    expect(out).toContain("full details are in the message above");
    // Never cuts mid-line.
    expect(out.split("\n").every((l) => !l.endsWith("repeated to blow the budge"))).toBe(true);
  });

  it("does not truncate when the agent summary already fits", () => {
    const fits = "One short line.\n\nAnother short line.";
    expect(mergeMenuSummary(fits, null)).toBe(fits);
  });

  it("keeps the digest even when the agent summary is truncated", () => {
    const huge = Array.from({ length: 60 }, (_, i) => `Fix ${i}: a long paragraph of detail about what changed and why.`).join("\n\n");
    const out = mergeMenuSummary(huge, "Review: 3 passes, reviewers approved — 7 findings addressed, 0 remaining.");
    expect(out).toContain("Review: 3 passes, reviewers approved — 7 findings addressed, 0 remaining.");
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
