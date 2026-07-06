import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stripAiCommentsFromContent, stripAiCommentMarkers, isAiCommentOnlyChange, AI_COMMENT_TOKEN, type ExecFn } from "./ai-comment-cleanup.js";

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

describe("stripAiCommentMarkers", () => {
  it("removes markers from all git-grep-reported files, leaving none behind", async () => {
    const repo = mkdtempSync(join(tmpdir(), "aicomment-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const fileA = join(repo, "src", "a.ts");
    const fileB = join(repo, "src", "b.ts");
    writeFileSync(fileA, ["const a = 1;", "// AI_COMMENT: fix me", "const a2 = 2;"].join("\n"));
    writeFileSync(fileB, "const b = 1; // AI_COMMENT: trailing");

    const exec: ExecFn = vi.fn(async (cmd, args) => {
      if (cmd === "git" && args[0] === "grep") {
        return { code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    });

    const res = await stripAiCommentMarkers(exec, [repo]);
    expect(res.filesChanged).toBe(2);
    expect(res.markersRemoved).toBe(2);
    expect(readFileSync(fileA, "utf-8")).not.toContain(AI_COMMENT_TOKEN);
    expect(readFileSync(fileB, "utf-8")).toBe("const b = 1;");
  });

  it("swallows git grep failure (no tracked matches) without throwing", async () => {
    const exec: ExecFn = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
    const res = await stripAiCommentMarkers(exec, ["/nonexistent"]);
    expect(res).toEqual({ filesChanged: 0, markersRemoved: 0 });
  });
});
