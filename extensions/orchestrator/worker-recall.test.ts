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
  it("searches the owning main session instead of the worker session", async () => {
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
});
