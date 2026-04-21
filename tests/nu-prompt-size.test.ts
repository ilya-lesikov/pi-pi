import { describe, it, expect } from "vitest";
import { NU_GUIDELINES } from "../src/nu.js";

describe("NU_GUIDELINES prompt-size budget", () => {
  const serialized = NU_GUIDELINES.join("\n\n");

  it("is at most 25 lines when serialized", () => {
    const lineCount = serialized.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(25);
  });

  it("is at most 1500 characters when serialized", () => {
    expect(serialized.length).toBeLessThanOrEqual(1500);
  });

  it("preserves the nu-vs-bash routing table sentinel", () => {
    expect(serialized).toContain("| Task | Tool |");
  });

  it("preserves the primer's parse-structured example sentinel", () => {
    expect(serialized).toContain("open package.json | get scripts");
  });

  it("preserves the plugin pointer sentinel", () => {
    expect(serialized).toContain("plugin list");
  });
});
