import { describe, it, expect } from "vitest";
import { stripAiCommentsFromContent, isAiCommentOnlyChange } from "./ai-comment-cleanup.js";

describe("stripAiCommentsFromContent", () => {
  it("drops full-line AI_COMMENT markers in various comment syntaxes", () => {
    const input = [
      "const x = 1;",
      "// AI_COMMENT: this is wrong",
      "  # AI_COMMENT: python style",
      "<!-- AI_COMMENT: markdown -->",
      "-- AI_COMMENT: sql style",
      "const y = 2;",
    ].join("\n");
    const { content, removed } = stripAiCommentsFromContent(input);
    expect(removed).toBe(4);
    expect(content).toBe(["const x = 1;", "const y = 2;"].join("\n"));
  });

  it("strips a trailing AI_COMMENT marker but keeps the code", () => {
    const input = "const z = 3; // AI_COMMENT: off-by-one?";
    const { content, removed } = stripAiCommentsFromContent(input);
    expect(removed).toBe(1);
    expect(content).toBe("const z = 3;");
  });

  it("leaves prose that merely mentions the token untouched", () => {
    const input = "This paragraph explains what AI_COMMENT: means in docs.";
    const { content, removed } = stripAiCommentsFromContent(input);
    expect(removed).toBe(0);
    expect(content).toBe(input);
  });

  it("is a no-op when no token present", () => {
    const input = "line one\nline two";
    expect(stripAiCommentsFromContent(input)).toEqual({ content: input, removed: 0 });
  });

  it("does NOT corrupt a marker that lives inside a string literal", () => {
    const cases = [
      `const s = "// AI_COMMENT: example";`,
      `const AI_COMMENT_MARKER_SYNTAX = "// AI_COMMENT: ...";`,
      `log('# AI_COMMENT: note');`,
      "const t = `<!-- AI_COMMENT: x -->`;",
    ];
    for (const input of cases) {
      expect(stripAiCommentsFromContent(input)).toEqual({ content: input, removed: 0 });
    }
  });

  it("strips a real trailing marker even when the code has an earlier closed string", () => {
    const input = `url = "http://x"; // AI_COMMENT: note`;
    const { content, removed } = stripAiCommentsFromContent(input);
    expect(removed).toBe(1);
    expect(content).toBe(`url = "http://x";`);
  });
});

describe("isAiCommentOnlyChange", () => {
  it("allows inserting an AI_COMMENT marker line", () => {
    const before = "const x = 1;\nconst y = 2;";
    const after = "const x = 1;\n// AI_COMMENT: off-by-one?\nconst y = 2;";
    expect(isAiCommentOnlyChange(before, after)).toBe(true);
  });

  it("allows removing an AI_COMMENT marker line", () => {
    const before = "const x = 1;\n// AI_COMMENT: note\nconst y = 2;";
    const after = "const x = 1;\nconst y = 2;";
    expect(isAiCommentOnlyChange(before, after)).toBe(true);
  });

  it("allows a trailing AI_COMMENT marker", () => {
    expect(isAiCommentOnlyChange("const x = 1;", "const x = 1; // AI_COMMENT: hm")).toBe(true);
  });

  it("rejects an actual code change", () => {
    expect(isAiCommentOnlyChange("const x = 1;", "const x = 2;")).toBe(false);
  });

  it("rejects a fix disguised alongside a marker", () => {
    const before = "const x = 1;";
    const after = "const x = 2; // AI_COMMENT: fixed";
    expect(isAiCommentOnlyChange(before, after)).toBe(false);
  });

  it("treats an identical write as allowed", () => {
    expect(isAiCommentOnlyChange("same", "same")).toBe(true);
  });
});

