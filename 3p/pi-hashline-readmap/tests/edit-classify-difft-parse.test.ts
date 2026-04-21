import { describe, it, expect } from "vitest";
import { parseDifftJson } from "../src/edit-classify.js";

describe("parseDifftJson", () => {
  it("returns whitespace-only for status unchanged", () => {
    const json = { language: "TypeScript", path: "/tmp/b.ts", status: "unchanged" };
    const result = parseDifftJson(json);
    expect(result!.classification).toBe("whitespace-only");
    expect(result!.movedBlocks).toBe(0);
  });

  it("returns semantic for status changed with no moved blocks", () => {
    const json = {
      chunks: [[
        {
          lhs: { line_number: 1, changes: [{ start: 8, end: 9, content: "x", highlight: "normal" }] },
          rhs: { line_number: 1, changes: [{ start: 8, end: 9, content: "y", highlight: "normal" }] },
        },
      ]],
      language: "TypeScript",
      path: "/tmp/b.ts",
      status: "changed",
    };
    const result = parseDifftJson(json);
    expect(result!.classification).toBe("semantic");
    expect(result!.movedBlocks).toBe(0);
  });

  it("counts moved blocks when chunks have lhs-only and rhs-only pairs", () => {
    const json = {
      chunks: [
        [{ rhs: { line_number: 0, changes: [{ start: 0, end: 8, content: "function", highlight: "keyword" }] } }],
        [{ lhs: { line_number: 4, changes: [{ start: 0, end: 8, content: "function", highlight: "keyword" }] } }],
      ],
      language: "TypeScript",
      path: "/tmp/b.ts",
      status: "changed",
    };
    const result = parseDifftJson(json);
    expect(result!.classification).toBe("semantic");
    expect(result!.movedBlocks).toBe(1);
  });

  it("does not count moved blocks when lhs-only and rhs-only chunks have different content", () => {
    const json = {
      chunks: [
        [{ rhs: { line_number: 0, changes: [{ start: 0, end: 3, content: "AAA", highlight: "normal" }] } }],
        [{ lhs: { line_number: 4, changes: [{ start: 0, end: 3, content: "BBB", highlight: "normal" }] } }],
      ],
      language: "TypeScript",
      path: "/tmp/b.ts",
      status: "changed",
    };
    const result = parseDifftJson(json);
    expect(result!.classification).toBe("semantic");
    expect(result!.movedBlocks).toBe(0);
  });

  it("returns null for invalid JSON shape", () => {
    const result = parseDifftJson({ garbage: true });
    expect(result).toBeNull();
  });
});
