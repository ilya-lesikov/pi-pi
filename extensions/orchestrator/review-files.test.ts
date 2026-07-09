import { describe, expect, it } from "vitest";
import { isReviewFileForRound } from "./review-files.js";

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
