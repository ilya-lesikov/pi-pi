import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecallTool } from "../../3p/pi-vcc/index.js";

// M6 (1): vcc_recall must resolve `scope:"compaction:latest"` and
// `scope:"compaction:N"` against a persisted compaction entry whose
// details.compactor === "pi-vcc" and details.messageRange = [firstId, lastId]
// (exactly the metadata pi-pi's in-phase dispatcher writes via buildVccDetails).

function msg(id: string, role: string, text: string) {
  return JSON.stringify({ type: "message", id, message: { role, content: [{ type: "text", text }] } });
}

describe("vcc_recall compaction-scope resolution", () => {
  let dir: string;
  let sessionFile: string;
  let tool: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vcc-recall-"));
    sessionFile = join(dir, "session.jsonl");
    // 4 messages + one pi-vcc compaction entry whose messageRange spans m1..m3.
    const lines = [
      msg("m0", "user", "alpha task setup"),
      msg("m1", "assistant", "beta implementation detail"),
      msg("m2", "user", "gamma follow-up question"),
      msg("m3", "assistant", "delta final answer"),
      JSON.stringify({
        type: "compaction",
        id: "c0",
        details: { compactor: "pi-vcc", messageRange: ["m1", "m3"], summary: "s" },
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");

    const registered: any[] = [];
    const pi = { registerTool: (t: any) => registered.push(t) } as any;
    registerRecallTool(pi);
    tool = registered.find((t) => t.name === "vcc_recall");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx() {
    return {
      sessionManager: {
        getSessionFile: () => sessionFile,
        // getActiveLineageEntryIds walks this; return undefined-ish shape.
        getEntries: () => [],
        getActiveLineage: () => [],
      },
    };
  }

  it("registers a vcc_recall tool", () => {
    expect(tool).toBeTruthy();
    expect(tool.name).toBe("vcc_recall");
  });

  it("resolves scope:'compaction:latest' to the pi-vcc compaction's message range", async () => {
    const res = await tool.execute("id", { scope: "compaction:latest" }, undefined, undefined, ctx());
    const text = res.content[0].text as string;
    // Not the "no compaction found" error — the range resolved and scoped output
    // is labeled with the compaction scope.
    expect(text).not.toContain("No compaction found");
    expect(text).toContain("compaction:latest");
  });

  it("resolves scope:'compaction:0' (the first pi-vcc compaction) by index", async () => {
    const res = await tool.execute("id", { scope: "compaction:0" }, undefined, undefined, ctx());
    const text = res.content[0].text as string;
    expect(text).not.toContain("No compaction found");
    expect(text).toContain("compaction:0");
  });

  it("reports no compaction for an out-of-range index", async () => {
    const res = await tool.execute("id", { scope: "compaction:9" }, undefined, undefined, ctx());
    expect(res.content[0].text as string).toContain("No compaction found");
  });
});
