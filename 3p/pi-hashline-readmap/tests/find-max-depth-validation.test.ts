import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cp from "node:child_process";
import { _testable, isFdAvailable } from "../src/find.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), execFileSync: vi.fn(actual.execFileSync) };
});

const _originalIsFdAvailable = isFdAvailable;

async function getFindTool() {
  const { registerFindTool } = await import("../src/find.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerFindTool(mockPi as any);
  if (!captured) throw new Error("find tool was not registered");
  return captured;
}

function text(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("find maxDepth validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("rejects negative maxDepth with validator-style message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "find-maxdepth-neg-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      const tool = await getFindTool();
      const execFileSpy = vi.spyOn(cp, "execFile");
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts", maxDepth: -1 },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid maxDepth: expected a non-negative integer, received -1.");
      expect(result.details?.ptcValue?.ok).toBe(false);
      expect(result.details?.ptcValue?.error?.code).toBe("invalid-params-combo");
      expect(execFileSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects string '-1' maxDepth via coerceObviousBase10Int parity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "find-maxdepth-str-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts", maxDepth: "-1" as any },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid maxDepth: expected a non-negative integer, received -1.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-numeric maxDepth like 'abc'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "find-maxdepth-abc-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts", maxDepth: "abc" as any },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid maxDepth: expected a base-10 integer, received");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects fractional maxDepth like 1.5", async () => {
    const dir = mkdtempSync(join(tmpdir(), "find-maxdepth-frac-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts", maxDepth: 1.5 as any },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid maxDepth: expected a base-10 integer, received 1.5.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts maxDepth=0 and maxDepth=3 (regression — valid inputs unchanged)", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-maxdepth-ok-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      const tool = await getFindTool();
      const ok0 = await tool.execute("tc", { pattern: "*.ts", maxDepth: 0 }, new AbortController().signal, undefined, { cwd: dir });
      expect(ok0.isError).toBeFalsy();
      const ok3 = await tool.execute("tc", { pattern: "*.ts", maxDepth: 3 }, new AbortController().signal, undefined, { cwd: dir });
      expect(ok3.isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
