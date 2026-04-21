import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFdAvailable, _testable } from "../src/find.js";
const _originalIsFdAvailable = isFdAvailable;
async function getFindTool() {
  const { registerFindTool } = await import("../src/find.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerFindTool(mockPi as any);
  if (!captured) throw new Error("find tool was not registered");
  return captured;
}
describe("find sortBy: 'mtime'", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("sorts by mtime ascending and descending", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-sort-mtime-"));
    try {
      writeFileSync(join(dir, "oldest.txt"), "");
      writeFileSync(join(dir, "middle.txt"), "");
      writeFileSync(join(dir, "newest.txt"), "");
      const t = Math.floor(Date.now() / 1000) - 10;
      utimesSync(join(dir, "oldest.txt"), t - 300, t - 300);
      utimesSync(join(dir, "middle.txt"), t - 200, t - 200);
      utimesSync(join(dir, "newest.txt"), t - 100, t - 100);
      const tool = await getFindTool();

      const asc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "mtime" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const ascPaths = asc.details!.ptcValue.entries.map((e: any) => e.path);
      expect(ascPaths).toEqual(["oldest.txt", "middle.txt", "newest.txt"]);
      const desc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "mtime", reverse: true },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const descPaths = desc.details!.ptcValue.entries.map((e: any) => e.path);
      expect(descPaths).toEqual(["newest.txt", "middle.txt", "oldest.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("breaks ties by lexicographic path order when mtimes are equal, even with reverse: true", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-sort-ties-"));
    try {
      writeFileSync(join(dir, "b.txt"), "");
      writeFileSync(join(dir, "a.txt"), "");
      writeFileSync(join(dir, "c.txt"), "");
      const t = Math.floor(Date.now() / 1000) - 100;
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        utimesSync(join(dir, name), t, t);
      }

      const tool = await getFindTool();

      const asc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "mtime" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(asc.details!.ptcValue.entries.map((e: any) => e.path)).toEqual([
        "a.txt",
        "b.txt",
        "c.txt",
      ]);

      const desc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "mtime", reverse: true },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(desc.details!.ptcValue.entries.map((e: any) => e.path)).toEqual([
        "a.txt",
        "b.txt",
        "c.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("find sort concurrency smoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("walks >1000 entries with sortBy: 'mtime' without EMFILE and returns results", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-sort-bulk-"));
    try {
      for (let i = 0; i < 1200; i++) {
        writeFileSync(join(dir, `file-${String(i).padStart(5, "0")}.txt`), "");
      }

      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "mtime", limit: 5000 },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBeUndefined();
      expect(result.details!.ptcValue.totalEntries).toBe(1200);
      expect(result.details!.ptcValue.entries).toHaveLength(1200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("find sortBy: 'size'", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("sorts by size ascending and descending", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-sort-size-"));
    try {
      writeFileSync(join(dir, "small.txt"), "a");
      writeFileSync(join(dir, "medium.txt"), "a".repeat(100));
      writeFileSync(join(dir, "large.txt"), "a".repeat(10000));
      const tool = await getFindTool();
      const asc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "size" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const ascPaths = asc.details!.ptcValue.entries.map((e: any) => e.path);
      expect(ascPaths).toEqual(["small.txt", "medium.txt", "large.txt"]);
      const desc = await tool.execute(
        "tc",
        { pattern: "*.txt", sortBy: "size", reverse: true },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const descPaths = desc.details!.ptcValue.entries.map((e: any) => e.path);
      expect(descPaths).toEqual(["large.txt", "medium.txt", "small.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
