import { describe, it, expect } from "vitest";
import piHashlineReadmapExtension from "../index.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function captureTools() {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
    on() {},
    events: { emit() {}, on() {} },
  };
  piHashlineReadmapExtension(pi as any);
  return tools;
}

function getTextContent(result: any): string {
  return result.content?.find((item: any) => item.type === "text")?.text ?? "";
}

describe("edit gate — grep anchors", () => {
  it("accepts a fresh grep anchor without an intermediate read", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-edit-grep-anchor-"));
    const filePath = resolve(dir, "sample.ts");

    try {
      await writeFile(filePath, "const value = 1;\nconst other = 2;\n", "utf8");

      const grepResult = await tools.grep.execute(
        "grep-call",
        { pattern: "value", path: filePath, literal: true },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      const grepText = getTextContent(grepResult);
      const anchor = grepText.match(/:(?:>>|  )(\d+:[0-9a-f]{3})\|/)?.[1];
      expect(anchor).toBeDefined();

      const editResult = await tools.edit.execute(
        "edit-call",
        { path: filePath, edits: [{ set_line: { anchor, new_text: "const value = 2;" } }] },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      expect(editResult.isError).toBeFalsy();
      expect(readFileSync(filePath, "utf8")).toContain("const value = 2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
