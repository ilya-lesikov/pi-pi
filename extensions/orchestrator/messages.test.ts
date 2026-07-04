import { describe, expect, it } from "vitest";
import { advanceBanner } from "./messages.js";

describe("advanceBanner", () => {
  it("wraps the body with a leading blank line and separator lines", () => {
    const out = advanceBanner("[PI-PI] User wants to continue. Run /pp when ready to advance.");
    const lines = out.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toContain("[PI-PI] User wants to continue.");
    expect(lines[3]).toMatch(/^─+$/);
  });

  it("preserves the [PI-PI] prefix in the body", () => {
    expect(advanceBanner("[PI-PI] hello")).toContain("[PI-PI] hello");
  });
});
