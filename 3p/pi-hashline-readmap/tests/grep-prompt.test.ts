import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../prompts");
const GREP_PROMPT_PATH = resolve(PROMPTS_DIR, "grep.md");

describe("prompts/grep.md", () => {
  it("exists and is non-empty", () => {
    expect(existsSync(GREP_PROMPT_PATH)).toBe(true);
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("contains scope and symbol documentation", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content).toContain("scope");
    expect(content).toContain("symbol");
  });

  it("contains summary mode documentation", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content).toContain("summary");
    expect(content).toContain("per-file");
  });

  it("first paragraph serves as tool description (matches loaded GREP_DESC)", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8").trim();
    const firstParagraph = content.split(/\n\s*\n/, 1)[0]?.trim() ?? content;
    // The first paragraph should describe what grep does and mention LINE:HASH anchors
    expect(firstParagraph).toContain("LINE:HASH");
    expect(firstParagraph.length).toBeGreaterThan(50);
    expect(firstParagraph.length).toBeLessThan(500);
  });

  it("documents all search modes", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content).toContain("context");
    expect(content).toContain("summary");
    expect(content).toContain("scope");
    expect(content).toContain("literal");
    expect(content).toContain("Results truncated at");
    expect(content).toContain("Output truncated:");
  });

  it("documents the grep → edit workflow", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content).toContain("edit");
    expect(content).toContain("anchor");
  });

  it("shows output format with >> markers", () => {
    const content = readFileSync(GREP_PROMPT_PATH, "utf-8");
    expect(content).toContain(">>");
  });
});
