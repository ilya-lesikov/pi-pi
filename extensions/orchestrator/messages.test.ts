import { describe, expect, it } from "vitest";
import { advanceBanner } from "./messages.js";

describe("advanceBanner", () => {
  it("starts with [PI-PI] so the controller-injection guard still matches", () => {
    const out = advanceBanner("[PI-PI] User wants to continue. Run /pp when ready to advance.");
    expect(out.startsWith("[PI-PI]")).toBe(true);
  });

  it("renders separators around the content for visual distinctness", () => {
    const out = advanceBanner("[PI-PI] hello");
    const lines = out.split("\n");
    expect(lines[0]).toBe("[PI-PI]");
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toBe("hello");
    expect(lines[3]).toMatch(/^─+$/);
  });

  it("does not double up the [PI-PI] prefix when the body already has one", () => {
    const out = advanceBanner("[PI-PI] hello");
    expect(out.match(/\[PI-PI\]/g)?.length).toBe(1);
    expect(out).not.toContain("[PI-PI] [PI-PI]");
  });

  it("adds the prefix when the body lacks one", () => {
    const out = advanceBanner("plain body");
    expect(out.startsWith("[PI-PI]")).toBe(true);
    expect(out).toContain("plain body");
  });
});
