import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerReadTool } from "../src/read.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

async function getReadTool() {
  let capturedTool: any = null;
  registerReadTool({ registerTool(def: any) { capturedTool = def; } } as any);
  if (!capturedTool) throw new Error("read tool was not registered");
  return capturedTool;
}

async function callReadTool(params: { path: string; offset?: number; limit?: number; symbol?: string; map?: boolean; bundle?: "local"; }) {
  const tool = await getReadTool();
  return tool.execute("test-call", params, new AbortController().signal, () => {}, { cwd: process.cwd() });
}

function getTextContent(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("read bundle schema validation", () => {
  it("adds bundle and validates combos", async () => {
    const tool = await getReadTool();
    expect(tool.parameters.properties.bundle).toBeDefined();
    expect(tool.parameters.properties.bundle.const).toBe("local");
    expect(tool.parameters.required ?? []).not.toContain("bundle");

    const filePath = resolve(fixturesDir, "small.ts");
    const baseline = await callReadTool({ path: filePath, symbol: "createDemoDirectory" });
    expect(getTextContent(baseline)).toMatch(/^\[Symbol: createDemoDirectory \(function\), lines 45-49 of 49\]/);
    expect(getTextContent(baseline)).not.toContain("## Requested symbol");
    expect((baseline.details?.ptcValue as any).bundle).toBeUndefined();

    const withoutSymbol = await callReadTool({ path: filePath, bundle: "local" });
    expect(withoutSymbol.isError).toBe(true);
    expect(getTextContent(withoutSymbol)).toBe('Cannot use bundle without symbol. Use read({ path, symbol, bundle: "local" }).');

    const withMap = await callReadTool({ path: filePath, symbol: "createDemoDirectory", bundle: "local", map: true });
    expect(withMap.isError).toBe(true);
    expect(getTextContent(withMap)).toBe("Cannot combine bundle with map. Use one or the other.");

    const withOffset = await callReadTool({ path: filePath, symbol: "createDemoDirectory", bundle: "local", offset: 1 });
    expect(withOffset.isError).toBe(true);
    expect(getTextContent(withOffset)).toBe("Cannot combine symbol with offset/limit. Use one or the other.");
  });
});
