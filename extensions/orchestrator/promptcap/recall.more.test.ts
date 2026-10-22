import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecallTools } from "./recall.js";

const message = (id: string, msg: Record<string, any>) => ({ type: "message", id, message: msg });
const user = (id: string, text: string) => message(id, { role: "user", content: [{ type: "text", text }] });
const reply = (id: string, text: string) => message(id, { role: "assistant", content: [{ type: "text", text }] });

function tools(source?: any) {
  const registered: any[] = [];
  registerRecallTools({ registerTool: (tool: any) => registered.push(tool) } as any, source);
  return Object.fromEntries(registered.map((tool) => [tool.name, tool])) as Record<string, any>;
}

const textOf = (res: any) => res.content[0].text as string;

describe("vcc_recall", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "recall-more-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, entries: any[]) => {
    const path = join(dir, name);
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n\nnot json\n", "utf-8");
    return path;
  };

  it("reads the root session from the source and the executing one with source current", async () => {
    const root = file("root.jsonl", [user("r", "root needle")]);
    const current = file("current.jsonl", [user("c", "current needle")]);
    const t = tools({ getSessionFile: () => root });
    const ctx = { sessionManager: { getSessionFile: () => current, getBranch: () => [] } };
    expect(textOf(await t.vcc_recall.execute("id", { query: "needle", scope: "all" }, undefined, undefined, ctx))).toContain("root needle");
    const mine = textOf(await t.vcc_recall.execute("id", { query: "needle", scope: "all", source: "current" }, undefined, undefined, ctx));
    expect(mine).toContain("current needle");
    expect(mine).not.toContain("root needle");
  });

  it("falls back to the in-memory entries when there is no session file", async () => {
    const t = tools();
    const entries = [user("a", "memory only")];
    const ctx = { sessionManager: { getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries } };
    expect(textOf(await t.vcc_recall.execute("id", {}, undefined, undefined, ctx))).toContain("memory only");
  });

  it("says when there is no history at all", async () => {
    const t = tools();
    expect(textOf(await t.vcc_recall.execute("id", {}, undefined, undefined, {}))).toBe("No root session history available.");
    expect(textOf(await t.vcc_recall.execute("id", { source: "current" }, undefined, undefined, {}))).toBe("No current session history available.");
    expect(textOf(await t.recall_tool_output.execute("id", { call_id: "x", source: "current" }, undefined, undefined, {}))).toBe("No current session history available.");
  });

  it("limits search to the active branch by default and labels scope all", async () => {
    const entries = [user("a", "kept needle"), user("b", "abandoned needle")];
    const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => [entries[0]] } };
    const t = tools();
    const lineage = textOf(await t.vcc_recall.execute("id", { query: "needle" }, undefined, undefined, ctx));
    expect(lineage).toContain("kept needle");
    expect(lineage).not.toContain("abandoned");
    const all = textOf(await t.vcc_recall.execute("id", { query: "needle", scope: "all" }, undefined, undefined, ctx));
    expect(all).toContain("abandoned needle");
    expect(all).toContain("(scope: all)");
    expect(textOf(await t.vcc_recall.execute("id", { expand: [1] }, undefined, undefined, ctx))).toBe("Cannot expand indices outside the active branch: 1");
  });

  it("uses all entries when the branch is unavailable", async () => {
    const entries = [user("a", "one needle")];
    const throwing = { getEntries: () => entries, getBranch: () => { throw new Error("no branch"); } };
    expect(textOf(await tools().vcc_recall.execute("id", { query: "needle" }, undefined, undefined, { sessionManager: throwing }))).toContain("one needle");
    const sourced = tools({ getSessionFile: () => undefined, getSessionManager: () => ({ getEntries: () => entries, getBranch: () => [] }) });
    expect(textOf(await sourced.vcc_recall.execute("id", { query: "needle" }, undefined, undefined, {}))).toContain("one needle");
  });

  describe("paging", () => {
    const entries = Array.from({ length: 30 }, (_, i) => user(`u${i}`, `needle ${i}`));
    const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => entries } };
    const run = (params: any) => tools().vcc_recall.execute("id", params, undefined, undefined, ctx).then(textOf);

    it("pages results and points at the next page", async () => {
      const first = await run({ query: "needle" });
      expect(first).toContain("Page 1/6 (30 total matches)");
      expect(first).toContain("--- Use page:2 for more results ---");
      const fifth = await run({ query: "needle", page: 5 });
      expect(fifth).toContain("Page 5/6");
      expect(fifth).toContain("--- Results truncated at 5 pages. Use a more specific query to narrow results. ---");
    });

    it("refuses a page past the last browsable one", async () => {
      expect(await run({ query: "needle", page: 6 })).toBe("Too many results to page through (30 matches across 6 pages). Try a more specific query.");
    });

    it("treats page zero as the first page", async () => {
      expect(await run({ query: "needle", page: 0 })).toContain("Page 1/6");
    });

    it("expands matching entries on the page and names those it could not", async () => {
      const both = await run({ query: "needle", expand: [3] });
      expect(both).toContain("expanded 1 entry to full content ---");
      const partial = await run({ query: "needle", expand: [0, 29] });
      expect(partial).toContain("--- expanded 1 entry to full content; not on this page: 29 ---");
      const none = await run({ query: "needle", expand: [29] });
      expect(none).toContain("--- no expand indices on this page: 29 ---");
    });
  });

  it("swaps the clipped summary for the full entry when expanding a hit", async () => {
    const long = "needle\n" + "word\n".repeat(10) + "TAILMARK";
    const entries = [user("a", long), reply("b", "needle two"), user("c", "x")];
    const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => entries } };
    const t = tools();
    const plain = textOf(await t.vcc_recall.execute("id", { query: "needle" }, undefined, undefined, ctx));
    expect(plain).not.toContain("TAILMARK");
    const out = textOf(await t.vcc_recall.execute("id", { query: "needle", expand: [0, 1] }, undefined, undefined, ctx));
    expect(out).toContain("TAILMARK");
    expect(out).toContain("--- expanded 2 entries to full content ---");
  });

  it("marks a hit matched only by its file path as a match, and counts it", async () => {
    const entries = [
      user("a", "please fix"),
      reply("b", "the needle is here"),
      user("c", "next"),
      message("d", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "/src/needle.ts" } }] }),
    ];
    const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => entries } };
    const out = textOf(await tools().vcc_recall.execute("id", { query: "needle" }, undefined, undefined, ctx));
    expect(out).toContain('2 matches for "needle": — 2 matches in 1 segment');
    expect(out).toContain("> #3 [assistant] files:[/src/needle.ts] read(path=/src/needle.ts)");
  });

  it("bounds a search page, cutting at a line break", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => user(`u${i}`, `needle ${i}\n` + `line ${"z".repeat(100)}\n`.repeat(60)));
    const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => entries } };
    const out = textOf(await tools().vcc_recall.execute("id", { query: "needle", expand: [0, 1, 2, 3, 4] }, undefined, undefined, ctx));
    expect(Buffer.byteLength(out)).toBeLessThan(12_200);
    expect(out).toMatch(/\n…\[\d+ bytes not shown; narrow the query, or expand one entry at a time\]$/);
  });
});

describe("recall_tool_output", () => {
  const call = (id: string, callId: string) => message(id, { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }] });

  it("says a call has no recorded output when its result is missing", async () => {
    const entries = [call("a", "toolu_x")];
    const res = await tools().recall_tool_output.execute("id", { call_id: "toolu_x" }, undefined, undefined, { sessionManager: { getEntries: () => entries } });
    expect(textOf(res)).toBe("Call toolu_x has no recorded output.");
  });

  it("says an attachment id names no image rather than handing back the message", async () => {
    const entries = [message("a", { role: "user", timestamp: 42, content: [{ type: "text", text: "no picture" }] })];
    const res = await tools().recall_tool_output.execute("id", { call_id: "attached-42" }, undefined, undefined, { sessionManager: { getEntries: () => entries } });
    expect(textOf(res)).toBe("No attached image attached-42 in this conversation.");
  });

  it("treats a missing call_id as none given", async () => {
    const res = await tools().recall_tool_output.execute("id", {}, undefined, undefined, { sessionManager: { getEntries: () => [] } });
    expect(textOf(res)).toContain("No call_id given");
  });
});
