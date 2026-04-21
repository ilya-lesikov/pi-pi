import { describe, it, expect, vi, afterEach } from "vitest";
import * as cp from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

async function getSgTool() {
  const { registerSgTool } = await import("../src/sg.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerSgTool(mockPi as any);
  if (!captured) throw new Error("sg tool was not registered");
  return captured;
}

describe("sg path resolution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves params.path relative to ctx.cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-path-resolution-"));
    mkdirSync(join(dir, "src"));
    try {
      const tool = await getSgTool();

      let capturedArgs: string[] = [];
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        capturedArgs = args;
        cb(null, "[]", "");
        return {} as any;
      });

      await tool.execute(
        "tc",
        { pattern: "p", path: "src" },
        new AbortController().signal,
        () => {},
        { cwd: dir },
      );

      expect(capturedArgs[capturedArgs.length - 1]).toBe(join(dir, "src"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
