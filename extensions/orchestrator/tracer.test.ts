import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { initTracer, finalizeTracer, getTracer } from "./tracer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-tracer-test-"));
  tempDirs.push(dir);
  return dir;
}

function readLines(file: string): Record<string, any>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

afterEach(() => {
  finalizeTracer();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("tracer", () => {
  it("is a no-op when not initialized", () => {
    expect(getTracer()).toBeUndefined();
  });

  it("creates per-session dir with main.jsonl and writes main events", () => {
    const ppDir = join(makeTempDir(), ".pp");
    initTracer(ppDir, "sess-abc");
    const tracer = getTracer();
    expect(tracer).toBeDefined();

    tracer!.traceMain("before_agent_start", { prompt: "hello", systemPrompt: "sys" });
    tracer!.traceMain("tool_execution_end", { toolCallId: "t1", result: { ok: true }, isError: false });

    const dir = join(ppDir, "logs", "traces", "sess-abc");
    expect(existsSync(join(dir, "main.jsonl"))).toBe(true);

    const lines = readLines(join(dir, "main.jsonl"));
    expect(lines[0].kind).toBe("before_agent_start");
    expect(lines[0].prompt).toBe("hello");
    expect(lines[0].systemPrompt).toBe("sys");
    expect(lines[1].kind).toBe("tool_execution_end");
    expect(lines[1].result).toEqual({ ok: true });
  });

  it("writes one file per subagent keyed by id, with prompts and full payloads", () => {
    const ppDir = join(makeTempDir(), ".pp");
    initTracer(ppDir, "sess-1");
    const tracer = getTracer()!;

    tracer.openSubagent({
      subagentId: "agent-1",
      type: "Explore",
      description: "find stuff",
      parentToolCallId: "call-9",
      depth: 1,
      systemPrompt: "sub-sys",
      effectivePrompt: "do the thing",
    });
    tracer.traceSubagent("agent-1", "tool_execution_start", { toolCallId: "x", toolName: "grep", args: { pattern: "foo" } });

    const dir = join(ppDir, "logs", "traces", "sess-1");
    const subLines = readLines(join(dir, "agent-1.jsonl"));
    expect(subLines[0].kind).toBe("subagent_open");
    expect(subLines[0].systemPrompt).toBe("sub-sys");
    expect(subLines[0].effectivePrompt).toBe("do the thing");
    expect(subLines[0].parentToolCallId).toBe("call-9");
    expect(subLines[1].kind).toBe("tool_execution_start");
    expect(subLines[1].args).toEqual({ pattern: "foo" });

    const mainLines = readLines(join(dir, "main.jsonl"));
    expect(mainLines.some((l) => l.kind === "subagent_spawned" && l.subagentId === "agent-1")).toBe(true);
  });

  it("keeps concurrent subagents in separate files", () => {
    const ppDir = join(makeTempDir(), ".pp");
    initTracer(ppDir, "sess-2");
    const tracer = getTracer()!;

    tracer.openSubagent({ subagentId: "a", depth: 1 });
    tracer.openSubagent({ subagentId: "b", depth: 1 });
    tracer.traceSubagent("a", "turn_end", { turnIndex: 0 });
    tracer.traceSubagent("b", "turn_end", { turnIndex: 0 });

    const dir = join(ppDir, "logs", "traces", "sess-2");
    expect(readLines(join(dir, "a.jsonl")).some((l) => l.kind === "turn_end")).toBe(true);
    expect(readLines(join(dir, "b.jsonl")).some((l) => l.kind === "turn_end")).toBe(true);
    expect(readLines(join(dir, "a.jsonl")).some((l) => l.subagentId === "b")).toBe(false);
  });

  it("finalize writes session_finalized and clears the tracer", () => {
    const ppDir = join(makeTempDir(), ".pp");
    initTracer(ppDir, "sess-3");
    const dir = join(ppDir, "logs", "traces", "sess-3");
    finalizeTracer();
    expect(getTracer()).toBeUndefined();
    expect(readLines(join(dir, "main.jsonl")).some((l) => l.kind === "session_finalized")).toBe(true);
  });

  it("cleans up trace dirs older than 7 days", () => {
    const ppDir = join(makeTempDir(), ".pp");
    initTracer(ppDir, "old-session");
    finalizeTracer();
    const tracesRoot = join(ppDir, "logs", "traces");
    const oldDir = join(tracesRoot, "old-session");
    expect(existsSync(oldDir)).toBe(true);

    const past = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldDir, past, past);

    initTracer(ppDir, "new-session");
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(tracesRoot, "new-session"))).toBe(true);
  });
});
