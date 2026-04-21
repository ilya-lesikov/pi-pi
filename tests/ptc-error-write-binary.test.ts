import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

async function callWrite(params: Record<string, unknown>) {
  const { registerWriteTool } = await import("../src/write.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerWriteTool(mockPi as any);
  if (!captured) throw new Error("write tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

describe("write ptcValue — binary-content code alignment", () => {
  it("uses code 'binary-content' for the binary warning (taxonomy alignment)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-write-bin-"));
    const f = resolve(dir, "b.bin");
    const content = "hello\u0000world";  // contains NUL → looks binary
    const r = await callWrite({ path: f, content });
    const ptc = r.details?.ptcValue;
    expect(ptc).toBeDefined();
    expect(ptc.tool).toBe("write");
    const warnings = ptc.warnings ?? [];
    const codes = warnings.map((w: any) => w.code);
    expect(codes).toContain("binary-content");
  });
});
