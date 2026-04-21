import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

async function callLsTool(params: Record<string, unknown>) {
  const { registerLsTool } = await import("../src/ls.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerLsTool(mockPi as any);
  if (!captured) throw new Error("ls tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}
const getPtc = (r: any) => r.details?.ptcValue;

describe("ls ptcValue.error", () => {
  it("path-not-found when path does not exist", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-ls-nf-"));
    const r = await callLsTool({ path: resolve(dir, "missing") });
    expect(r.isError).toBe(true);
    expect(getPtc(r)?.tool).toBe("ls");
    expect(getPtc(r)?.error?.code).toBe("path-not-found");
  });

  it("path-not-directory when path is a file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-ls-nd-"));
    const f = resolve(dir, "f.txt"); writeFileSync(f, "x", "utf-8");
    const r = await callLsTool({ path: f });
    expect(getPtc(r)?.error?.code).toBe("path-not-directory");
  });
});
