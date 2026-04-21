import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerReadTool } from "../src/read.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

function captureReadTool() {
  let capturedTool: any;
  registerReadTool(
    {
      registerTool(def: any) {
        capturedTool = def;
      },
    } as any,
  );
  return capturedTool;
}

function getTextContent(result: any): string {
  return result.content?.find((item: any) => item.type === "text")?.text ?? "";
}

describe("read numeric-string coercion", () => {
  it("accepts obvious base-10 strings for offset/limit", async () => {
    const tool = captureReadTool();

    expect(tool.parameters.properties.offset.anyOf).toBeDefined();
    expect(tool.parameters.properties.limit.anyOf).toBeDefined();

    const numeric = await tool.execute(
      "read-numeric",
      { path: resolve(fixturesDir, "small.ts"), offset: 2, limit: 2 },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    const stringy = await tool.execute(
      "read-string",
      { path: resolve(fixturesDir, "small.ts"), offset: "2", limit: "2" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(stringy.isError).not.toBe(true);
    expect(getTextContent(stringy)).toBe(getTextContent(numeric));
  });

  it("rejects invalid numeric strings cleanly", async () => {
    const tool = captureReadTool();
    const invalid = await tool.execute(
      "read-invalid",
      { path: resolve(fixturesDir, "small.ts"), offset: "2x" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(invalid.isError).toBe(true);
    expect(getTextContent(invalid)).toBe('Invalid offset: expected a base-10 integer, received "2x".');
  });

  it("keeps the truncation notice in the body text for truncated reads", async () => {
    const tool = captureReadTool();
    const truncated = await tool.execute(
      "read-large",
      { path: resolve(fixturesDir, "large.ts") },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(getTextContent(truncated)).toContain("[Output truncated:");
  });
});
