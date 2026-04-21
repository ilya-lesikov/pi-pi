import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("prompts/nu.md", () => {
  it("exists and contains structured exploration description", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    expect(content).toContain("Nushell");
    expect(content).toContain("structured");
    expect(content).toContain("bash");
  });

  it("mentions exploration and investigation use case", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    expect(content).toContain("exploration");
  });

  it("documents Tier 1 + Tier 2 split while keeping a short first paragraph", () => {
    const content = readFileSync(resolve(__dirname, "../prompts/nu.md"), "utf-8");
    // First paragraph stays short so NU_DESC (derived from it) does not grow.
    const firstParagraph = content.split(/\n\s*\n/, 1)[0]!.trim();
    expect(firstParagraph.length).toBeGreaterThan(0);
    expect(firstParagraph.length).toBeLessThanOrEqual(400);
    // Rest of the file documents the Tier 1 / Tier 2 split.
    expect(content).toMatch(/Tier 1/i);
    expect(content).toMatch(/Tier 2/i);
    expect(content).toContain("[nu-hint]");
  });
});
