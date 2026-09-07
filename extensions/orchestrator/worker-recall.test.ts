import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecallTool } from "../../3p/pi-vcc/index.js";
import registerOrchestrator from "./index.js";

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
  // The root session replaces the shared source object on every session_start,
  // so a worker must read it per call rather than capture it at load time.
  it("follows the root session source across a root session switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-recall-"));
    dirs.push(dir);
    const first = join(dir, "first.jsonl");
    const second = join(dir, "second.jsonl");
    writeFileSync(first, JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: "first-session-detail" }] } }) + "\n");
    writeFileSync(second, JSON.stringify({ type: "message", id: "b", message: { role: "user", content: [{ type: "text", text: "second-session-detail" }] } }) + "\n");
    const sourceKey = Symbol.for("pi-pi:root-session-source");
    const scopeKey = Symbol.for("pi-pi:subagent-session-scope");
    const makeSource = (file: string) => ({
      getSessionFile: () => file,
      getSessionManager: () => ({ getSessionFile: () => file, getActiveLineage: () => [], getEntries: () => [] }),
    });

    (globalThis as any)[sourceKey] = makeSource(first);
    (globalThis as any)[scopeKey] = { getStore: () => ({ depth: 1 }) };
    const registered: any[] = [];
    try {
      registerOrchestrator({
        registerTool: (tool: any) => registered.push(tool),
        on: vi.fn(),
        events: { on: vi.fn(), emit: vi.fn() },
        registerProvider: vi.fn(),
        unregisterProvider: vi.fn(),
        registerCommand: vi.fn(),
      } as any);
    } finally {
      delete (globalThis as any)[scopeKey];
    }
    const tool = registered.find((entry) => entry.name === "vcc_recall");

    (globalThis as any)[sourceKey] = makeSource(second);
    try {
      const result = await tool.execute("id", { query: "second-session-detail", scope: "all" }, undefined, undefined, {
        sessionManager: { getSessionFile: vi.fn(() => undefined) },
      });
      // "No matches for \"<query>\"" echoes the query, so the query text alone
      // proves nothing about which session was searched.
      expect(result.content[0].text).not.toContain("No matches");
      expect(result.content[0].text).toContain("second-session-detail");
    } finally {
      delete (globalThis as any)[sourceKey];
    }
  });
});
