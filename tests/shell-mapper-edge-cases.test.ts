import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMap } from "../src/readmap/mapper.js";
import { SymbolKind } from "../src/readmap/enums.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/shell-edge-cases.sh");

describe("Shell mapper edge cases", () => {
  // ---- Bug #078: One-liner functions ----

  it("detects one-liner function: oneliner() { echo ...; }", async () => {
    const map = await generateMap(FIXTURE);
    expect(map).not.toBeNull();

    const sym = map!.symbols.find(s => s.name === "oneliner");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Function);
    // One-liner should have startLine === endLine
    expect(sym!.startLine).toBe(10);
    expect(sym!.endLine).toBe(10);
  });

  it("detects one-liner with 'function' keyword: function another_oneliner() { ...; }", async () => {
    const map = await generateMap(FIXTURE);
    const sym = map!.symbols.find(s => s.name === "another_oneliner");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Function);
    expect(sym!.startLine).toBe(13);
    expect(sym!.endLine).toBe(13);
  });

  it("detects one-liner without parens: function keyword_oneliner { ...; }", async () => {
    const map = await generateMap(FIXTURE);
    const sym = map!.symbols.find(s => s.name === "keyword_oneliner");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Function);
    expect(sym!.startLine).toBe(16);
    expect(sym!.endLine).toBe(16);
  });

  // ---- Bug #084: Multi-line export ----

  it("multi-line double-quoted export spans correct lines", async () => {
    const map = await generateMap(FIXTURE);
    expect(map).not.toBeNull();
    const sym = map!.symbols.find(s => s.name === "MULTILINE");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Variable);
    expect(sym!.startLine).toBe(22);
    // Should span through the closing quote on line 24
    expect(sym!.endLine).toBe(24);
  });

  it("multi-line single-quoted export spans correct lines", async () => {
    const map = await generateMap(FIXTURE);
    expect(map).not.toBeNull();
    const sym = map!.symbols.find(s => s.name === "MULTI_SINGLE");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Variable);
    expect(sym!.startLine).toBe(27);
    // Should span through the closing quote on line 29
    expect(sym!.endLine).toBe(29);
  });

  // ---- Existing functionality still works ----

  it("still detects normal multi-line functions", async () => {
    const map = await generateMap(FIXTURE);
    const sym = map!.symbols.find(s => s.name === "greet");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Function);
    expect(sym!.startLine).toBe(5);
    expect(sym!.endLine).toBe(7);
  });

  it("still detects simple exports", async () => {
    const map = await generateMap(FIXTURE);
    const sym = map!.symbols.find(s => s.name === "SIMPLE");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Variable);
    expect(sym!.startLine).toBe(19);
    expect(sym!.endLine).toBe(19);
  });

  it("still detects aliases", async () => {
    const map = await generateMap(FIXTURE);
    const sym = map!.symbols.find(s => s.name === "shortcut");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe(SymbolKind.Variable);
  });
});
