import { describe, it, expect, vi } from "vitest";
import {
  parseReviewAnchors,
  parseBaseRepoFromUrl,
  detectPrTarget,
  postPrLineComments,
  PI_PI_FOOTER,
  type ExecFn,
  type PrTarget,
} from "./pr-comments.js";

describe("parseReviewAnchors", () => {
  it("parses ANCHORS lines with em dash, hyphen, and bullet prefixes", () => {
    const text = [
      "VERDICT: NEEDS_CHANGES",
      "ANCHORS:",
      "src/a.ts:12 — CRITICAL: null deref",
      "- src/b.ts:340 -- MAJOR: missing await",
      "* pkg/c.go:5 - MINOR: rename var",
    ].join("\n");
    const anchors = parseReviewAnchors(text);
    expect(anchors).toEqual([
      { path: "src/a.ts", line: 12, body: "CRITICAL: null deref" },
      { path: "src/b.ts", line: 340, body: "MAJOR: missing await" },
      { path: "pkg/c.go", line: 5, body: "MINOR: rename var" },
    ]);
  });

  it("ignores prose, headings, (none), and paths containing spaces", () => {
    const text = [
      "The issue at line 5 — is bad",
      "ANCHORS:",
      "(none)",
      "some sentence: 10 — not a path",
    ].join("\n");
    expect(parseReviewAnchors(text)).toEqual([]);
  });

  it("deduplicates identical anchors", () => {
    const text = ["src/a.ts:1 — dup", "src/a.ts:1 — dup"].join("\n");
    expect(parseReviewAnchors(text)).toHaveLength(1);
  });
});

describe("detectPrTarget", () => {
  it("returns null when gh is not authenticated", async () => {
    const exec: ExecFn = vi.fn(async (_c, args) => {
      if (args[0] === "auth") return { code: 1, stdout: "", stderr: "not logged in" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await detectPrTarget(exec, "/repo")).toBeNull();
  });

  it("returns null when there is no PR", async () => {
    const exec: ExecFn = vi.fn(async (_c, args) => {
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "no pull requests found" };
    });
    expect(await detectPrTarget(exec, "/repo")).toBeNull();
  });

  it("derives owner/repo from the PR url (base repo), keeping head SHA as commit_id", async () => {
    const exec: ExecFn = vi.fn(async (_c, args) => {
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 42,
          headRefOid: "abc123",
          url: "https://github.com/octo/widget/pull/42",
        }),
        stderr: "",
      };
    });
    expect(await detectPrTarget(exec, "/repo")).toEqual({ number: 42, headSha: "abc123", owner: "octo", repo: "widget" });
  });

  it("targets the base repo for a fork PR, not the head fork", async () => {
    const exec: ExecFn = vi.fn(async (_c, args) => {
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 7,
          headRefOid: "ff00",
          url: "https://github.com/upstream-org/proj/pull/7",
        }),
        stderr: "",
      };
    });
    expect(await detectPrTarget(exec, "/repo")).toEqual({ number: 7, headSha: "ff00", owner: "upstream-org", repo: "proj" });
  });
});

describe("parseBaseRepoFromUrl", () => {
  it("extracts owner/repo from a PR url", () => {
    expect(parseBaseRepoFromUrl("https://github.com/octo/widget/pull/42")).toEqual({ owner: "octo", repo: "widget" });
  });
  it("returns null for a non-PR url", () => {
    expect(parseBaseRepoFromUrl("https://github.com/octo/widget")).toBeNull();
  });
});

describe("postPrLineComments", () => {
  const target: PrTarget = { number: 7, headSha: "deadbeef", owner: "octo", repo: "widget" };

  it("posts one comment per anchor with the pi-pi footer and RIGHT side", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = vi.fn(async (_c, args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" };
    });
    const res = await postPrLineComments(exec, "/repo", target, [
      { path: "src/a.ts", line: 3, body: "CRITICAL: bug" },
    ]);
    expect(res.posted).toBe(1);
    expect(res.skipped).toHaveLength(0);
    const args = calls[0];
    expect(args).toContain("repos/octo/widget/pulls/7/comments");
    expect(args).toContain(`body=CRITICAL: bug${PI_PI_FOOTER}`);
    expect(args).toContain("commit_id=deadbeef");
    expect(args).toContain("path=src/a.ts");
    expect(args).toContain("line=3");
    expect(args).toContain("side=RIGHT");
  });

  it("collects off-diff (422) anchors into skipped instead of failing", async () => {
    const exec: ExecFn = vi.fn(async (_c, args) => {
      const isBad = args.some((a: string) => a === "path=src/bad.ts");
      return isBad ? { code: 1, stdout: "", stderr: "422 line not part of diff" } : { code: 0, stdout: "{}", stderr: "" };
    });
    const res = await postPrLineComments(exec, "/repo", target, [
      { path: "src/ok.ts", line: 1, body: "ok" },
      { path: "src/bad.ts", line: 999, body: "bad" },
    ]);
    expect(res.posted).toBe(1);
    expect(res.skipped).toEqual([{ path: "src/bad.ts", line: 999, body: "bad" }]);
  });

  it("does not double-append the footer when already present", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = vi.fn(async (_c, args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await postPrLineComments(exec, "/repo", target, [
      { path: "src/a.ts", line: 3, body: `already${PI_PI_FOOTER}` },
    ]);
    const bodyArg = calls[0].find((a) => a.startsWith("body="))!;
    expect(bodyArg.endsWith(PI_PI_FOOTER)).toBe(true);
    expect(bodyArg.match(/_Generated with pi-pi_/g)).toHaveLength(1);
  });
});
