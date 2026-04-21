import { describe, it, expect } from "vitest";
import type { FileMap } from "../src/readmap/types.js";
import { DetailLevel, SymbolKind } from "../src/readmap/enums.js";
import { findSymbol } from "../src/readmap/symbol-lookup.js";

function makeMap(symbols: FileMap["symbols"]): FileMap {
  return {
    path: "/tmp/test.ts",
    totalLines: 100,
    totalBytes: 1000,
    language: "typescript",
    symbols,
    imports: [],
    detailLevel: DetailLevel.Full,
  };
}

// Issue 099: tiers 3 (camelCase word-boundary) and 4 (substring) currently
// return { type: "found" } silently. Expected behavior is { type: "fuzzy", tier, ... }.
describe("repro #099 — fuzzy symbol match silently resolves for tiers 3 & 4", () => {
  it("tier 4 substring: read({symbol:'get'}) should NOT silently resolve to initGetters", () => {
    const map = makeMap([
      { name: "initGetters", kind: SymbolKind.Function, startLine: 42, endLine: 58 },
      { name: "formatOutput", kind: SymbolKind.Function, startLine: 60, endLine: 70 },
    ]);

    const result = findSymbol(map, "get");
    // BUG: currently returns { type: "found", symbol: initGetters } with no warning.
    expect(result.type).toBe("fuzzy");
  });

  it("tier 3 camelCase: read({symbol:'handler'}) should NOT silently resolve to getHandler", () => {
    const map = makeMap([
      { name: "getHandler", kind: SymbolKind.Function, startLine: 10, endLine: 20 },
      { name: "formatOutput", kind: SymbolKind.Function, startLine: 60, endLine: 70 },
    ]);

    const result = findSymbol(map, "handler");
    // BUG: currently returns { type: "found", symbol: getHandler } with no warning.
    expect(result.type).toBe("fuzzy");
  });
});
