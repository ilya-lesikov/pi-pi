import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

async function callReadTool(params: Record<string, unknown>) {
  const { registerReadTool } = await import("../src/read.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerReadTool(mockPi as any);
  if (!captured) throw new Error("read tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

function getPtc(result: any) { return result.details?.ptcValue; }

describe("read ptcValue.error — remaining error sites", () => {
  it("invalid-limit when limit < 1", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-il-"));
    const f = resolve(dir, "f.txt"); writeFileSync(f, "a\n", "utf-8");
    const r = await callReadTool({ path: f, limit: 0 });
    expect(getPtc(r)?.error?.code).toBe("invalid-limit");
  });

  it("invalid-params-combo when symbol combined with offset", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-ipc-"));
    const f = resolve(dir, "f.ts"); writeFileSync(f, "function foo() {}\n", "utf-8");
    const r = await callReadTool({ path: f, symbol: "foo", offset: 1 });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });

  it("invalid-params-combo when bundle without symbol", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-ipc2-"));
    const f = resolve(dir, "f.ts"); writeFileSync(f, "x\n", "utf-8");
    const r = await callReadTool({ path: f, bundle: "local" });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });

  it("invalid-params-combo when bundle combined with map", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-ipc3-"));
    const f = resolve(dir, "f.ts"); writeFileSync(f, "function foo(){}\n", "utf-8");
    const r = await callReadTool({ path: f, symbol: "foo", bundle: "local", map: true });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });

  it("invalid-params-combo when map combined with symbol", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-ipc4-"));
    const f = resolve(dir, "f.ts"); writeFileSync(f, "function foo(){}\n", "utf-8");
    const r = await callReadTool({ path: f, symbol: "foo", map: true });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });

  it("path-is-directory when path is a directory", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-dir-"));
    const sub = resolve(dir, "sub"); mkdirSync(sub);
    const r = await callReadTool({ path: sub });
    expect(getPtc(r)?.error?.code).toBe("path-is-directory");
  });

  it("file-not-found when file is missing", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-nf-"));
    const r = await callReadTool({ path: resolve(dir, "missing.txt") });
    expect(getPtc(r)?.error?.code).toBe("file-not-found");
  });

  it("offset-past-end when offset > total lines", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-r-pe-"));
    const f = resolve(dir, "f.txt"); writeFileSync(f, "one\ntwo\n", "utf-8");
    const r = await callReadTool({ path: f, offset: 999 });
    expect(getPtc(r)?.error?.code).toBe("offset-past-end");
  });
});
