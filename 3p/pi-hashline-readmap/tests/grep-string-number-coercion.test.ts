import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerGrepTool } from "../src/grep.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

function captureGrepTool() {
  let capturedTool: any;
  registerGrepTool(
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

describe("grep numeric-string coercion", () => {
  it("accepts obvious base-10 strings for context/limit", async () => {
    const tool = captureGrepTool();

    expect(tool.parameters.properties.context.anyOf).toBeDefined();
    expect(tool.parameters.properties.limit.anyOf).toBeDefined();

    const numeric = await tool.execute(
      "grep-numeric",
      {
        pattern: "createDemoDirectory",
        path: resolve(fixturesDir, "small.ts"),
        literal: true,
        context: 1,
        limit: 1,
      },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    const stringy = await tool.execute(
      "grep-string",
      {
        pattern: "createDemoDirectory",
        path: resolve(fixturesDir, "small.ts"),
        literal: true,
        context: "1",
        limit: "1",
      },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(stringy.isError).not.toBe(true);
    expect(getTextContent(stringy)).toBe(getTextContent(numeric));
  });

  it("rejects invalid numeric strings cleanly", async () => {
    const tool = captureGrepTool();
    const invalid = await tool.execute(
      "grep-invalid",
      {
        pattern: "createDemoDirectory",
        path: resolve(fixturesDir, "small.ts"),
        literal: true,
        limit: "1x",
      },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(invalid.isError).toBe(true);
    expect(getTextContent(invalid)).toBe('Invalid limit: expected a base-10 integer, received "1x".');
  });
});
