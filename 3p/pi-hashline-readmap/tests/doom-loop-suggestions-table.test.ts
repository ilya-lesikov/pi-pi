import { describe, it, expect } from "vitest";
import { SUGGESTIONS, GENERIC_SUGGESTION } from "../src/doom-loop-suggestions.js";
import { readFileSync } from "node:fs";

describe("SUGGESTIONS table", () => {
  it("exposes entries for every tool named in the issue doc", () => {
    for (const name of ["grep", "read", "edit", "ast_search", "find", "ls"]) {
      expect(SUGGESTIONS[name]).toBeDefined();
      expect(SUGGESTIONS[name].length).toBeGreaterThan(0);
    }
  });

  it("contains the exact strings from the issue doc for each tool", () => {
    expect(SUGGESTIONS.grep).toEqual([
      "try ignoreCase: true",
      "try literal: true if pattern has special characters",
      "try a narrower glob or path",
      "switch to ast_search for structural patterns",
      "try summary: true to scope broader",
    ]);
    expect(SUGGESTIONS.read).toEqual([
      "if searching for a symbol, use symbol: or map: true",
      "if file is large, try offset + limit",
      "if file keeps being read identically, the content may already be what you expect",
    ]);
    expect(SUGGESTIONS.edit).toEqual([
      "if hash-mismatch keeps firing, re-read the file",
      "if no-op keeps firing, your new_text equals current content",
      "verify the anchor came from the most recent read/grep/ast_search",
    ]);
    expect(SUGGESTIONS.ast_search).toEqual([
      'check the lang parameter matches file type (e.g. lang: "tsx" for JSX)',
      "simplify the pattern with $_ or $$$ wildcards",
      "verify ast-grep is installed",
    ]);
    expect(SUGGESTIONS.find).toEqual([
      "try a looser glob",
      'try type: "any"',
      "try a different path",
    ]);
    expect(SUGGESTIONS.ls).toEqual([
      "try a different path",
      "remove the glob filter",
    ]);
  });

  it("exposes a generic suggestion for unknown tools", () => {
    expect(typeof GENERIC_SUGGESTION).toBe("string");
    expect(GENERIC_SUGGESTION.length).toBeGreaterThan(0);
    expect(GENERIC_SUGGESTION.toLowerCase()).toContain("different approach");
  });

  it("source file carries an upkeep comment", () => {
    const source = readFileSync(new URL("../src/doom-loop-suggestions.ts", import.meta.url), "utf8");
    expect(source).toMatch(/manual upkeep|keep in sync|maintained alongside/i);
  });
});
