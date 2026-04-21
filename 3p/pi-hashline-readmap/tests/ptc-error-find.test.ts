import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

async function callFindTool(params: Record<string, unknown>) {
  const { registerFindTool } = await import("../src/find.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerFindTool(mockPi as any);
  if (!captured) throw new Error("find tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}
const getPtc = (r: any) => r.details?.ptcValue;

describe("find ptcValue.error", () => {
  it("path-not-found when path does not exist", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-find-nf-"));
    const r = await callFindTool({ pattern: "*.ts", path: resolve(dir, "missing") });
    expect(r.isError).toBe(true);
    expect(getPtc(r)?.tool).toBe("find");
    expect(getPtc(r)?.error?.code).toBe("path-not-found");
  });

  it("path-not-directory when path is a file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-find-nd-"));
    const f = resolve(dir, "f.txt"); writeFileSync(f, "x", "utf-8");
    const r = await callFindTool({ pattern: "*.ts", path: f });
    expect(getPtc(r)?.error?.code).toBe("path-not-directory");
  });

  it("invalid-params-combo when regex pattern is invalid", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-find-iv-"));
    const r = await callFindTool({ pattern: "[unclosed", path: dir, regex: true });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });
});
