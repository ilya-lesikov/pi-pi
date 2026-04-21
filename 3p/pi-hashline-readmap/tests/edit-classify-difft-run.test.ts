import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

import { runDifftastic, _resetDifftCache } from "../src/edit-classify.js";
import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

describe("runDifftastic", () => {
  beforeEach(() => {
    _resetDifftCache();
    mockedExecFile.mockRestore();
  });

  it("returns a DifftClassifyResult for whitespace-only changes when difft is available", async () => {
    const old = "function hello() {\n  const x = 1;\n  return x;\n}\n";
    const nw = "function hello() {\n    const x = 1;\n    return x;\n}\n";
    const result = await runDifftastic(old, nw, "ts");
    if (result !== null) {
      expect(result.classification).toBe("whitespace-only");
      expect(result.movedBlocks).toBe(0);
    }
  });

  it("returns a DifftClassifyResult for semantic changes when difft is available", async () => {
    const old = "const x = 1;\n";
    const nw = "const y = 2;\n";
    const result = await runDifftastic(old, nw, "ts");
    if (result !== null) {
      expect(result.classification).toBe("semantic");
    }
  });

  it("returns null when difft subprocess fails", async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      }
      return {} as any;
    });
    const result = await runDifftastic("a\n", "b\n", "ts");
    expect(result).toBeNull();
  });
});
