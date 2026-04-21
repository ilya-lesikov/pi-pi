import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

import { isDifftAvailable, _resetDifftCache } from "../src/edit-classify.js";
import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

describe("difftastic availability detection", () => {
  beforeEach(() => {
    _resetDifftCache();
    mockedExecFile.mockReset();
    // Restore real implementation by default
    mockedExecFile.mockImplementation(
      ((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          // Actually call which difft
          const { execFile: realExecFile } = require("node:child_process");
          return realExecFile(...args);
        }
      }) as any,
    );
  });

  it("returns a boolean when checking difft availability", async () => {
    mockedExecFile.mockRestore();
    const result = await isDifftAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("caches the result across calls", async () => {
    mockedExecFile.mockRestore();
    const first = await isDifftAvailable();
    const second = await isDifftAvailable();
    expect(first).toBe(second);
  });

  it("returns false when the lookup fails", async () => {
    mockedExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      }
      return {} as any;
    });
    const result = await isDifftAvailable();
    expect(result).toBe(false);
  });
});
