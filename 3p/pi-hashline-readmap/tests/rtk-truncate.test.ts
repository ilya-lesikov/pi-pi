import { describe, it, expect } from "vitest";
import { truncate, truncateLines } from "../src/rtk/truncate.js";

describe("truncate", () => {
  it("returns text unchanged when shorter than maxLength", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns text unchanged when exactly at maxLength", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates text over maxLength with ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello...");
    expect(result.length).toBe(8);
  });

  it("returns just ellipsis when maxLength < 3", () => {
    expect(truncate("hello", 2)).toBe("...");
    expect(truncate("hello", 1)).toBe("...");
    expect(truncate("hello", 0)).toBe("...");
  });

  it("handles empty input", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("handles maxLength of exactly 3", () => {
    expect(truncate("hello", 3)).toBe("...");
  });

  it("handles maxLength of 4", () => {
    const result = truncate("hello", 4);
    expect(result).toBe("h...");
    expect(result.length).toBe(4);
  });
});

describe("truncateLines", () => {
  it("returns text unchanged when fewer lines than limit", () => {
    const text = "line1\nline2\nline3";
    expect(truncateLines(text, 5)).toBe(text);
  });

  it("returns text unchanged when exactly at limit", () => {
    const text = "line1\nline2\nline3";
    expect(truncateLines(text, 3)).toBe(text);
  });

  it("truncates with indicator when over limit", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(`line ${i}`);
    }
    const text = lines.join("\n");

    const result = truncateLines(text, 10);
    expect(result).toContain("lines omitted");
    // Should keep some from start and some from end
    expect(result).toContain("line 1");
    expect(result).toContain("line 20");
  });

  it("handles empty input", () => {
    expect(truncateLines("", 10)).toBe("");
  });

  it("handles single line input", () => {
    expect(truncateLines("hello", 10)).toBe("hello");
  });
});
