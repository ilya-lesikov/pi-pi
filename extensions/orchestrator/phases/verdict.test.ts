import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseVerdict, hasActionableFindings, reviewPassUnanimousApprove } from "./verdict.js";

describe("parseVerdict", () => {
  it("parses inline colon form", () => {
    expect(parseVerdict("- VERDICT: APPROVE")).toBe("approve");
  });

  it("parses the header form with token on a later line (opus)", () => {
    expect(parseVerdict("## Findings\nNone.\n\n## VERDICT\n\nAPPROVE")).toBe("approve");
  });

  it("parses bold form", () => {
    expect(parseVerdict("**VERDICT:** APPROVE")).toBe("approve");
  });

  it("parses all negative tokens as changes", () => {
    expect(parseVerdict("VERDICT: NEEDS_CHANGES")).toBe("changes");
    expect(parseVerdict("VERDICT: NEEDS_WORK")).toBe("changes");
    expect(parseVerdict("VERDICT: REJECT")).toBe("changes");
    expect(parseVerdict("## VERDICT\nNEEDS_CHANGES")).toBe("changes");
  });

  it("is case-insensitive on the label", () => {
    expect(parseVerdict("verdict: approve")).toBe("approve");
  });

  it("returns unknown when no verdict line", () => {
    expect(parseVerdict("LGTM, looks fine")).toBe("unknown");
  });

  it("first-line verdict wins over a later VERDICT-like word in prose", () => {
    const review = [
      "VERDICT: NEEDS_CHANGES",
      "- CRITICAL: the prose below mentions the word VERDICT: APPROVE but must not win",
    ].join("\n");
    expect(parseVerdict(review)).toBe("changes");
  });
});

describe("hasActionableFindings", () => {
  it("treats inline 'none' as no findings", () => {
    expect(hasActionableFindings("- CRITICAL: none\n- MAJOR: (none)")).toBe(false);
  });

  it("detects a real inline CRITICAL finding", () => {
    expect(hasActionableFindings("- CRITICAL: null deref at foo.ts:10")).toBe(true);
  });

  it("ignores MINOR findings", () => {
    expect(hasActionableFindings("- MINOR: rename a variable")).toBe(false);
  });

  it("treats header form with 'None.' body as no findings (opus)", () => {
    expect(hasActionableFindings("## Findings\n\n### CRITICAL\nNone.\n\n### MAJOR\nNone.\n")).toBe(false);
  });

  it("detects a real header-form CRITICAL finding", () => {
    expect(hasActionableFindings("### CRITICAL\nnull deref at x.ts:1\n\n### MAJOR\nNone.")).toBe(true);
  });
});

describe("reviewPassUnanimousApprove", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verdict-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns true when all reviewer files approve with no findings", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- CRITICAL: none\n- VERDICT: APPROVE");
    writeFileSync(join(rd, "1_b_round-1.md"), "- MAJOR: none\n- VERDICT: APPROVE");
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 2)).toBe(true);
  });

  it("returns true for the real opus header-form approval", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(
      join(rd, "1_opus_round-1.md"),
      "## Findings\n\n### CRITICAL\nNone.\n\n### MAJOR\nNone.\n\n## VERDICT\n\nAPPROVE\n",
    );
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 1)).toBe(true);
  });

  it("returns false when one reviewer needs changes", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- VERDICT: APPROVE");
    writeFileSync(join(rd, "1_b_round-1.md"), "- VERDICT: NEEDS_CHANGES");
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 2)).toBe(false);
  });

  it("returns false when approved but with a CRITICAL finding", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- CRITICAL: bug at x.ts:1\n- VERDICT: APPROVE");
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 1)).toBe(false);
  });

  it("returns false when fewer files than enabled reviewers (some failed)", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- VERDICT: APPROVE");
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 3)).toBe(false);
  });

  it("returns false when a verdict is unparseable (fail-safe)", () => {
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "LGTM");
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 1)).toBe(false);
  });

  it("returns false when no reviewer files exist", () => {
    expect(reviewPassUnanimousApprove(dir, "implement", 1, 1)).toBe(false);
  });

  it("uses brainstorm-reviews dir for brainstorm phase", () => {
    const rd = join(dir, "brainstorm-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- VERDICT: APPROVE");
    expect(reviewPassUnanimousApprove(dir, "brainstorm", 1, 1)).toBe(true);
  });

  it("uses plan-reviews dir for plan phase", () => {
    const rd = join(dir, "plan-reviews");
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "1_a_round-1.md"), "- VERDICT: APPROVE");
    expect(reviewPassUnanimousApprove(dir, "plan", 1, 1)).toBe(true);
  });
});
