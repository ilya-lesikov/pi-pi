import { describe, it, expect } from "vitest";
import piHashlineReadmapExtension from "../index.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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

describe("edit gate — write anchors", () => {
  it("accepts a fresh write anchor without an intermediate read", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-edit-write-anchor-"));
    const filePath = resolve(dir, "written.ts");

    try {
      const writeResult = await tools.write.execute(
        "write-call",
        { path: filePath, content: "export const x = 1;\n" },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      const writeText = getTextContent(writeResult);
      const anchor = writeText.match(/^(\d+:[0-9a-f]{3})\|/m)?.[1];
      expect(anchor).toBeDefined();

      const editResult = await tools.edit.execute(
        "edit-call",
        { path: filePath, edits: [{ set_line: { anchor, new_text: "export const x = 2;" } }] },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      expect(editResult.isError).toBeFalsy();
      expect(readFileSync(filePath, "utf8")).toContain("export const x = 2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
