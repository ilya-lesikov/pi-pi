import { describe, it, expect, vi, afterEach } from "vitest";
import * as cp from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(() => Buffer.from("ast-grep 0.42.0")),
  };
});

async function captureTools() {
  const { default: piHashlineReadmapExtension } = await import("../index.ts");
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

describe("edit gate — ast_search anchors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a fresh ast_search anchor without an intermediate read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-edit-sg-anchor-"));
    const filePath = resolve(dir, "sample.ts");

    try {
      await writeFile(filePath, "const value = 1;\nconst other = 2;\n", "utf8");
      const actualCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(cp.execFile).mockImplementation((cmd: any, args: any, optsOrCb: any, maybeCb?: any) => {
        if (cmd === "sg") {
          const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
          cb(
            null,
            JSON.stringify([
              { file: filePath, range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } },
            ]),
            "",
          );
          return {} as any;
        }

        return (actualCp.execFile as any)(cmd, args, optsOrCb, maybeCb);
      });

      const tools = await captureTools();
      const searchResult = await tools.ast_search.execute(
        "sg-call",
        { pattern: "const $NAME = $_", lang: "typescript", path: filePath },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      const searchText = getTextContent(searchResult);
      const anchor = searchText.match(/>>(\d+:[0-9a-f]{3})\|/)?.[1];
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
