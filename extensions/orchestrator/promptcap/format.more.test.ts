import { describe, expect, it } from "vitest";
import { formatRecallOutput } from "./format.js";
import type { SearchHit } from "./search.js";

const hit = (index: number, role: string, summary: string, snippet?: string, files?: string[]): SearchHit => ({ index, role, summary, ...(snippet !== undefined && { snippet }), ...(files && { files }) });

describe("formatRecallOutput", () => {
  it("says there is nothing, naming the query when there is one", () => {
    expect(formatRecallOutput([])).toBe("No entries in session history.");
    expect(formatRecallOutput([], "x")).toBe('No matches for "x" in session history.');
  });

  it("browses flat with files and an optional header", () => {
    const entries = [hit(0, "user", "hi"), hit(1, "assistant", "read it", undefined, ["/a", "/b"])];
    expect(formatRecallOutput(entries)).toBe("Session history (2 entries):\n\n#0 [user] hi\n\n#1 [assistant] files:[/a, /b] read it");
    expect(formatRecallOutput(entries, undefined, "Custom:")).toMatch(/^Custom:\n\n#0/);
  });

  it("groups hits into turns, marks matched entries with their snippet, and counts partial matches", () => {
    const entries = [
      hit(0, "user", "question", "snip q"),
      hit(1, "assistant", "answer"),
      hit(2, "tool_result", "out", "snip out", ["/f"]),
      hit(3, "user", "next", "snip next"),
    ];
    expect(formatRecallOutput(entries, "q")).toBe([
      'Found 4 matches for "q": — 3 matches across 2 segments',
      "",
      "--- #0-#2 (2/3 entries match) ---",
      "> #0 [user] snip q",
      "  #1 [assistant] answer",
      "> #2 [tool_result] files:[/f] snip out",
      "",
      "--- #3 ---",
      "> #3 [user] snip next",
    ].join("\n"));
  });

  it("treats every entry as matched when none carries a snippet", () => {
    const out = formatRecallOutput([hit(0, "user", "a"), hit(1, "assistant", "b")], "q", "Page 1/1");
    expect(out).toBe('Page 1/1 for "q": — 2 matches in 1 segment\n\n--- #0-#1 ---\n> #0 [user] a\n> #1 [assistant] b');
  });

  it("adds the unmatched turns either side of the first matching one as context", () => {
    const entries = [
      hit(0, "user", "before", ""),
      hit(1, "bash", "middle", "snip"),
      hit(2, "user", "after", ""),
      hit(3, "user", "far", ""),
    ];
    const out = formatRecallOutput(entries, "q");
    expect(out).toContain("1 matches across 4 segments");
    expect(out.split("\n\n").slice(1)).toEqual(["--- #0 (context) ---\n  #0 [user] before", "--- #1 ---\n> #1 [bash] snip", "--- #2 (context) ---\n  #2 [user] after"]);
  });

  it("adds no context when no turn matched", () => {
    const out = formatRecallOutput([hit(0, "user", "a", ""), hit(1, "user", "b", "")], "q");
    expect(out).toBe('Found 2 matches for "q": — 0 matches across 2 segments\n\n');
  });

  it("does not repeat a following turn that matched itself", () => {
    const out = formatRecallOutput([hit(0, "user", "a", "x"), hit(1, "user", "b", "y")], "q");
    expect(out.match(/--- #1/g)).toHaveLength(1);
  });
});
