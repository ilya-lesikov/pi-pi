import { describe, it, expect } from "vitest";
import type { FileMap } from "../src/readmap/types.js";
import { DetailLevel, SymbolKind } from "../src/readmap/enums.js";
import { buildLocalBundle } from "../src/read-local-bundle.js";

const sourceLines = [
  "function helperOne() {",
  "  return 1;",
  "}",
  "",
  "function helperTwo(value: number) {",
  "  return value * 2;",
  "}",
  "",
  "export function target() {",
  "  const value = helperOne();",
  "  return helperTwo(value);",
  "}",
  "",
  "function unusedHelper() {",
  "  return 99;",
  "}",
];

const fileMap: FileMap = {
  path: "/tmp/local-bundle.ts",
  totalLines: sourceLines.length,
  totalBytes: sourceLines.join("\n").length,
  language: "typescript",
  detailLevel: DetailLevel.Full,
  imports: [],
  symbols: [
    { name: "helperOne", kind: SymbolKind.Function, startLine: 1, endLine: 3 },
    { name: "helperTwo", kind: SymbolKind.Function, startLine: 5, endLine: 7 },
    { name: "target", kind: SymbolKind.Function, startLine: 9, endLine: 12 },
    { name: "unusedHelper", kind: SymbolKind.Function, startLine: 14, endLine: 16 },
  ],
};

describe("buildLocalBundle", () => {
  it("returns direct same-file support in source order without unrelated symbols", () => {
    const bundle = buildLocalBundle(
      fileMap,
      { name: "target", kind: SymbolKind.Function, startLine: 9, endLine: 12 },
      sourceLines,
    );

    expect(bundle).toEqual({
      requested: { name: "target", kind: "function", startLine: 9, endLine: 12 },
      support: [
        {
          symbol: { name: "helperOne", kind: "function", startLine: 1, endLine: 3 },
          lines: sourceLines.slice(0, 3),
        },
        {
          symbol: { name: "helperTwo", kind: "function", startLine: 5, endLine: 7 },
          lines: sourceLines.slice(4, 7),
        },
      ],
    });
  });

  it("returns null when a directly referenced local symbol name is ambiguous", () => {
    const ambiguousMap: FileMap = {
      ...fileMap,
      symbols: [
        { name: "helper", kind: SymbolKind.Function, startLine: 1, endLine: 3 },
        { name: "helper", kind: SymbolKind.Function, startLine: 5, endLine: 7 },
        { name: "target", kind: SymbolKind.Function, startLine: 9, endLine: 12 },
      ],
    };

    const ambiguousLines = [
      "function helper() {",
      "  return 1;",
      "}",
      "",
      "function helper() {",
      "  return 2;",
      "}",
      "",
      "export function target() {",
      "  return helper();",
      "}",
    ];

    expect(
      buildLocalBundle(
        ambiguousMap,
        { name: "target", kind: SymbolKind.Function, startLine: 9, endLine: 11 },
        ambiguousLines,
      ),
    ).toBeNull();
  });
});
