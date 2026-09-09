import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecallTools, slice } from "./recall.js";

const line = (id: string, message: Record<string, any>) => JSON.stringify({ type: "message", id, message });

const userLine = (id: string, text: string) => line(id, { role: "user", content: [{ type: "text", text }] });

const callLine = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  line(id, { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] });

const resultLine = (id: string, callId: string, name: string, text: string, image?: string) =>
  line(id, {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text }, ...(image ? [{ type: "image", data: image, mimeType: "image/png" }] : [])],
    isError: false,
  });

describe("recall tools", () => {
  let dir: string;
  let sessionFile: string;
  let tools: Record<string, any>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promptcap-recall-"));
    sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, [
      userLine("m0", "alpha task setup"),
      callLine("m1", "toolu_1", "read", { path: "/etc/hosts", body: "y".repeat(4000) }),
      resultLine("m2", "toolu_1", "read", "line one\nline two\nline three\nneedle here\nline five"),
      userLine("m3", "gamma follow-up question"),
      callLine("m4", "toolu_img", "read", { path: "/shot.png" }),
      resultLine("m5", "toolu_img", "read", "1024x768", "AAAAIMAGEBYTES"),
    ].join("\n") + "\n", "utf-8");

    const registered: any[] = [];
    registerRecallTools({ registerTool: (tool: any) => registered.push(tool) } as any);
    tools = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ctx = () => ({ sessionManager: { getSessionFile: () => sessionFile, getEntries: () => [], getBranch: () => [] } });
  const run = (name: string, params: Record<string, unknown>) =>
    tools[name].execute("id", params, undefined, undefined, ctx()).then((res: any) => res.content[0].text as string);

  it("registers the search tool and both call-id tools", () => {
    expect(Object.keys(tools).sort()).toEqual(["recall_tool_args", "recall_tool_output", "vcc_recall"]);
  });

  it("returns a folded call's full output by call id", async () => {
    expect(await run("recall_tool_output", { call_id: "toolu_1" })).toContain("needle here");
  });

  it("returns only matching lines for a pattern", async () => {
    expect(await run("recall_tool_output", { call_id: "toolu_1", pattern: "needle" })).toBe("needle here");
  });

  it("pages output with offset and limit", async () => {
    expect(await run("recall_tool_output", { call_id: "toolu_1", offset: 1, limit: 2 })).toBe("line two\nline three");
  });

  it("returns a call's full arguments, untruncated", async () => {
    const out = await run("recall_tool_args", { call_id: "toolu_1" });
    expect(out).toContain("/etc/hosts");
    expect(out).toContain("y".repeat(4000));
  });

  // Folding removes an image with the rest of the result, so a recall that
  // returned only its caption would be handing back the wrong thing.
  it("hands back the image an image result carried", async () => {
    const res = await tools.recall_tool_output.execute("id", { call_id: "toolu_img" }, undefined, undefined, ctx());
    expect(res.content[0].text).toContain("1024x768");
    expect(res.content[1]).toEqual({ type: "image", data: "AAAAIMAGEBYTES", mimeType: "image/png" });
  });

  it("names the call id it could not find", async () => {
    expect(await run("recall_tool_output", { call_id: "toolu_missing" })).toContain("No call toolu_missing");
  });

  it("asks for a call id when none was given", async () => {
    expect(await run("recall_tool_output", { call_id: "  " })).toContain("No call_id given");
  });

  it("searches history and reports matches", async () => {
    const out = await run("vcc_recall", { query: "gamma", scope: "all" });
    expect(out).toContain("gamma follow-up question");
  });

  it("browses recent history without a query", async () => {
    expect(await run("vcc_recall", { scope: "all" })).toContain("alpha task setup");
  });

  it("expands an entry to its full content", async () => {
    expect(await run("vcc_recall", { scope: "all", expand: [1] })).toContain("/etc/hosts");
  });

  it("refuses an expand index outside the scope", async () => {
    expect(await run("vcc_recall", { scope: "all", expand: [99] })).toContain("Cannot expand indices");
  });
});

describe("slice", () => {
  it("caps a long output and says how to page on", () => {
    const out = slice("x".repeat(20_000));
    expect(out.length).toBeLessThan(20_000);
    expect(out).toContain("bytes not shown");
  });

  it("reports an offset past the end", () => {
    expect(slice("a\nb", 9)).toContain("past the end");
  });

  it("reports a pattern that matches nothing", () => {
    expect(slice("a\nb", 0, 0, "zzz")).toContain("No line contains");
  });
});
