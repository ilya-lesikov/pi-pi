import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecallTool } from "../../3p/pi-vcc/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worker recall source", () => {
  it("searches the owning main session by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-recall-"));
    dirs.push(dir);
    const rootFile = join(dir, "root.jsonl");
    writeFileSync(rootFile, JSON.stringify({ type: "message", id: "root-1", message: { role: "user", content: [{ type: "text", text: "owning-session-decision" }] } }) + "\n");
    const registered: any[] = [];
    registerRecallTool({ registerTool: (tool: any) => registered.push(tool) } as any, {
      getSessionFile: () => rootFile,
      getSessionManager: () => ({ getSessionFile: () => rootFile, getActiveLineage: () => [], getEntries: () => [] }),
    });
    const tool = registered.find((entry) => entry.name === "vcc_recall");
    const result = await tool.execute("id", { query: "owning-session-decision", scope: "all" }, undefined, undefined, {
      sessionManager: { getSessionFile: vi.fn(() => undefined) },
    });
    expect(result.content[0].text).toContain("owning-session-decision");
    expect(result.content[0].text).not.toContain("No session file available");
  });

  it("searches an in-memory worker session with source:'current'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-recall-"));
    dirs.push(dir);
    const rootFile = join(dir, "root.jsonl");
    writeFileSync(rootFile, JSON.stringify({ type: "message", id: "root-1", message: { role: "user", content: [{ type: "text", text: "root-only-detail" }] } }) + "\n");
    const registered: any[] = [];
    registerRecallTool({ registerTool: (tool: any) => registered.push(tool) } as any, {
      getSessionFile: () => rootFile,
      getSessionManager: () => ({ getSessionFile: () => rootFile, getBranch: () => [], getEntries: () => [] }),
    });
    const tool = registered.find((entry) => entry.name === "vcc_recall");
    const entries = [
      { type: "message", id: "worker-1", message: { role: "assistant", content: [{ type: "text", text: "worker-compacted-detail" }] } },
      { type: "compaction", id: "worker-c1", details: { compactor: "pi-vcc", messageRange: ["worker-1", "worker-1"] } },
    ];
    const current = { getSessionFile: () => undefined, getBranch: () => entries, getEntries: () => entries };
    const result = await tool.execute("id", { query: "worker-compacted-detail", scope: "compaction:latest", source: "current" }, undefined, undefined, { sessionManager: current });
    expect(result.content[0].text).toContain("worker-compacted-detail");
    expect(result.content[0].text).not.toContain("No session file available");
  });
});
