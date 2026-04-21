import { describe, it, expect } from "vitest";

async function callSgTool(params: Record<string, unknown>) {
  const { registerSgTool } = await import("../src/sg.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerSgTool(mockPi as any);
  if (!captured) throw new Error("sg tool not registered");
  return captured.execute("tc", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}
const getPtc = (r: any) => r.details?.ptcValue;

describe("ast_search ptcValue.error", () => {
  it("sg-not-installed when ENOENT", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const r = await callSgTool({ pattern: "$X", lang: "ts" });
      expect(r.isError).toBe(true);
      const ptc = getPtc(r);
      expect(ptc?.tool).toBe("ast_search");
      expect(ptc?.ok).toBe(false);
      expect(ptc?.error?.code).toBe("sg-not-installed");
      expect(typeof ptc?.error?.message).toBe("string");
      expect(ptc?.error?.hint).toMatch(/brew install ast-grep/i);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
