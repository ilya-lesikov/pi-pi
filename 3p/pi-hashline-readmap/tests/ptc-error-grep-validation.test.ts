import { describe, it, expect } from "vitest";

async function callGrepTool(params: Record<string, unknown>) {
  const { registerGrepTool } = await import("../src/grep.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerGrepTool(mockPi as any);
  if (!captured) throw new Error("grep tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}
const getPtc = (r: any) => r.details?.ptcValue;

describe("grep ptcValue.error — parameter validation", () => {
  it("invalid-params-combo when context is non-numeric string", async () => {
    const r = await callGrepTool({ pattern: "x", context: "abc" });
    expect(r.isError).toBe(true);
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
    expect(typeof getPtc(r)?.error?.message).toBe("string");
  });

  it("invalid-limit when limit is non-numeric string", async () => {
    const r = await callGrepTool({ pattern: "x", limit: "abc" });
    expect(getPtc(r)?.error?.code).toBe("invalid-limit");
  });

  it("invalid-params-combo when scopeContext given without scope:symbol", async () => {
    const r = await callGrepTool({ pattern: "x", scopeContext: 2 });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });

  it("invalid-params-combo when scopeContext is negative", async () => {
    const r = await callGrepTool({ pattern: "x", scope: "symbol", scopeContext: -1 });
    expect(getPtc(r)?.error?.code).toBe("invalid-params-combo");
  });
});
