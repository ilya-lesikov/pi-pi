import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isReviewFileForRound, reviewerNameFromRoundFile, isReviewComplete, reconcileMissingReviewers, partitionRoundFiles } from "./review-files.js";

describe("isReviewFileForRound", () => {
  it("matches the exact round suffix", () => {
    expect(isReviewFileForRound("001_alpha_round-1.md", 1)).toBe(true);
    expect(isReviewFileForRound("42_gemini_round-3.md", 3)).toBe(true);
  });

  it("does not let round-1 match round-10 through round-19", () => {
    expect(isReviewFileForRound("001_alpha_round-10.md", 1)).toBe(false);
    expect(isReviewFileForRound("001_alpha_round-11.md", 1)).toBe(false);
    expect(isReviewFileForRound("001_alpha_round-19.md", 1)).toBe(false);
    expect(isReviewFileForRound("001_alpha_round-10.md", 10)).toBe(true);
  });

  it("excludes synthesized final-pass files", () => {
    expect(isReviewFileForRound("001_final_pass-1.md", 1)).toBe(false);
    expect(isReviewFileForRound("001_final_pass-10.md", 1)).toBe(false);
  });

  it("requires the .md extension", () => {
    expect(isReviewFileForRound("001_alpha_round-1.txt", 1)).toBe(false);
    expect(isReviewFileForRound("001_alpha_round-1", 1)).toBe(false);
  });
});

describe("reviewerNameFromRoundFile", () => {
  it("extracts the reviewer segment between epoch and _round-N", () => {
    expect(reviewerNameFromRoundFile("1785850203_gpt_round-2.md", 2)).toBe("gpt");
    expect(reviewerNameFromRoundFile("42_fable_round-1.md", 1)).toBe("fable");
    // A reviewer name may itself contain underscores.
    expect(reviewerNameFromRoundFile("42_gpt_5_sol_round-3.md", 3)).toBe("gpt_5_sol");
  });
  it("returns null for a non-matching round or a final-pass file", () => {
    expect(reviewerNameFromRoundFile("42_gpt_round-2.md", 1)).toBeNull();
    expect(reviewerNameFromRoundFile("42_final_pass-1.md", 1)).toBeNull();
  });
});

describe("isReviewComplete", () => {
  it("is false for an INCOMPLETE stub even with a verdict line", () => {
    expect(isReviewComplete("VERDICT: UNKNOWN\nREVIEW_STATUS: INCOMPLETE")).toBe(false);
    expect(isReviewComplete("VERDICT: APPROVE\nREVIEW_STATUS: INCOMPLETE\npartial...")).toBe(false);
  });
  it("is true when explicitly marked COMPLETE", () => {
    expect(isReviewComplete("VERDICT: APPROVE\n...\nREVIEW_STATUS: COMPLETE")).toBe(true);
  });
  it("treats a legacy file with a parseable verdict (no status marker) as complete", () => {
    expect(isReviewComplete("VERDICT: NEEDS_CHANGES\n- MAJOR: x")).toBe(true);
    expect(isReviewComplete("## VERDICT\n\nAPPROVE\n")).toBe(true);
  });
  it("is false for a file with no verdict and no status", () => {
    expect(isReviewComplete("just some prose, no verdict")).toBe(false);
  });
});

describe("reconcileMissingReviewers", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), "review-files-"));
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    return rd;
  }

  it("writes an UNKNOWN placeholder for a reviewer that left no file", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    const missing = reconcileMissingReviewers(rd, 1, ["gpt", "fable"]);
    expect(missing).toEqual(["fable"]);
    const files = readdirSync(rd).filter((f) => isReviewFileForRound(f, 1));
    const fableFile = files.find((f) => reviewerNameFromRoundFile(f, 1) === "fable");
    expect(fableFile).toBeDefined();
    const content = readFileSync(join(rd, fableFile!), "utf-8");
    expect(content).toContain("VERDICT: UNKNOWN");
    expect(content).toContain("REVIEW_STATUS: INCOMPLETE");
    expect(isReviewComplete(content)).toBe(false);
  });

  it("counts an existing INCOMPLETE stub as missing but does NOT overwrite it", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_fable_round-1.md"), "VERDICT: UNKNOWN\nREVIEW_STATUS: INCOMPLETE\npartial work");
    const before = readdirSync(rd).length;
    const missing = reconcileMissingReviewers(rd, 1, ["fable"]);
    expect(missing).toEqual(["fable"]);
    // No NEW file created (the stub already records the gap); content preserved.
    expect(readdirSync(rd).length).toBe(before);
    expect(readFileSync(join(rd, "100_fable_round-1.md"), "utf-8")).toContain("partial work");
  });

  it("reports nothing missing when every expected reviewer has a COMPLETE file", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    writeFileSync(join(rd, "101_fable_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    expect(reconcileMissingReviewers(rd, 1, ["gpt", "fable"])).toEqual([]);
  });
});

describe("partitionRoundFiles", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), "review-partition-"));
    const rd = join(dir, "code-reviews");
    mkdirSync(rd, { recursive: true });
    return rd;
  }

  it("keeps a stub out of the complete list so it is not reported as a finished review", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: UNKNOWN\nREVIEW_STATUS: INCOMPLETE");
    writeFileSync(join(rd, "101_fable_round-1.md"), "VERDICT: APPROVE\nfindings\nREVIEW_STATUS: COMPLETE");

    expect(partitionRoundFiles(rd, 1)).toEqual({
      complete: ["101_fable_round-1.md"],
      incomplete: ["100_gpt_round-1.md"],
    });
  });

  it("returns no complete files when every reviewer left only a stub", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: UNKNOWN\nREVIEW_STATUS: INCOMPLETE");
    writeFileSync(join(rd, "101_fable_round-1.md"), "VERDICT: UNKNOWN\nREVIEW_STATUS: INCOMPLETE");

    const { complete, incomplete } = partitionRoundFiles(rd, 1);
    expect(complete).toEqual([]);
    expect(incomplete).toHaveLength(2);
  });

  it("treats a legacy verdict-only file as complete", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: NEEDS_CHANGES\n\nsome findings");

    expect(partitionRoundFiles(rd, 1).complete).toEqual(["100_gpt_round-1.md"]);
  });

  it("ignores other rounds and synthesized final-pass files", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-2.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    writeFileSync(join(rd, "101_final_pass-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    writeFileSync(join(rd, "102_fable_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");

    expect(partitionRoundFiles(rd, 1)).toEqual({ complete: ["102_fable_round-1.md"], incomplete: [] });
  });

  it("honors the extra filter the plan phase uses to scope to its own spawn timestamp", () => {
    const rd = setup();
    writeFileSync(join(rd, "100_gpt_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");
    writeFileSync(join(rd, "999_gpt_round-1.md"), "VERDICT: APPROVE\nREVIEW_STATUS: COMPLETE");

    const { complete } = partitionRoundFiles(rd, 1, (f) => f.startsWith("999"));
    expect(complete).toEqual(["999_gpt_round-1.md"]);
  });

  it("returns empty lists for a directory that does not exist", () => {
    expect(partitionRoundFiles(join(tmpdir(), "pp-does-not-exist-xyz"), 1)).toEqual({ complete: [], incomplete: [] });
  });
});
