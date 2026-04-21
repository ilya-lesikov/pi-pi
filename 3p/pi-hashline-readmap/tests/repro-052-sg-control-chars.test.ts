import { describe, it, expect, vi, afterEach } from "vitest";
import * as cp from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

async function getSgTool() {
  const { registerSgTool } = await import("../src/sg.js");
  let capturedTool: any = null;
  const mockPi = { registerTool(def: any) { capturedTool = def; } };
  registerSgTool(mockPi as any);
  if (!capturedTool) throw new Error("sg tool was not registered");
  return capturedTool;
}

function getTextContent(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function makeControlTsFile(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-repro-052-sg-"));
  const filePath = resolve(dir, "control.ts");
  writeFileSync(
    filePath,
    [
      "export function demo() {",
      "  // raw-control-\x07-bell",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

describe("Bug #052: sg output escapes raw control characters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sg tool output must not contain raw control characters", async () => {
    const filePath = makeControlTsFile();
    const mockedMatches = [
      {
        file: filePath,
        range: {
          start: { line: 0, column: 0 },
          end: { line: 3, column: 1 },
        },
      },
    ];

    vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify(mockedMatches), "");
      return {} as any;
    });

    const tool = await getSgTool();
    const result = await tool.execute(
      "tc",
      { pattern: "export function $NAME($$$PARAMS) { $$$BODY }", lang: "typescript", path: filePath },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    const text = getTextContent(result);
    expect(
      CONTROL_CHAR_RE.test(text),
      "sg output contains raw control characters that would break JSON parsing",
    ).toBe(false);
    expect(text).toContain("\\u0007");
  });
});
