import { describe, it, expect, vi, afterEach } from "vitest";
import * as cp from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

async function getSgTool() {
  const { registerSgTool } = await import("../src/sg.js");
  let captured: any = null;
  registerSgTool({ registerTool(def: any) { captured = def; } } as any);
  if (!captured) throw new Error("sg tool was not registered");
  return captured;
}

function text(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("ast_search path validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns path-not-found error for non-existent path and does not spawn ast-grep", async () => {
    const tool = await getSgTool();
    const execFileSpy = vi.mocked(cp.execFile);
    execFileSpy.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "[]", "");
      return {} as any;
    });
    const result = await tool.execute(
      "tc",
      { pattern: "console.log($X)", path: "/this/path/definitely/does/not/exist", lang: "typescript" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Error: path '/this/path/definitely/does/not/exist' does not exist",
    );
    expect(result.details?.ptcValue?.ok).toBe(false);
    expect(result.details?.ptcValue?.error?.code).toBe("path-not-found");
    expect(execFileSpy).not.toHaveBeenCalled();
  });
});
