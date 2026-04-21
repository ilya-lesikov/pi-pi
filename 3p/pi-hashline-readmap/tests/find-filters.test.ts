import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isFdAvailable, _testable } from "../src/find.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures/find-basic");
const _originalIsFdAvailable = isFdAvailable;
async function getFindTool() {
  const { registerFindTool } = await import("../src/find.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerFindTool(mockPi as any);
  if (!captured) throw new Error("find tool was not registered");
  return captured;
}
describe("find modifiedSince filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });
  it("keeps only entries with mtime strictly after a relative threshold", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-ms-rel-"));
    try {
      writeFileSync(join(dir, "old.txt"), "");
      writeFileSync(join(dir, "recent.txt"), "");
      const nowS = Math.floor(Date.now() / 1000);
      utimesSync(join(dir, "old.txt"), nowS - 7200, nowS - 7200);
      utimesSync(join(dir, "recent.txt"), nowS - 60, nowS - 60);
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", modifiedSince: "1h" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const paths = result.details!.ptcValue.entries.map((e: any) => e.path);
      expect(paths).toEqual(["recent.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("accepts ISO date form like '2024-01-01'", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-ms-iso-"));
    try {
      writeFileSync(join(dir, "before.txt"), "");
      writeFileSync(join(dir, "after.txt"), "");
      const beforeS = Math.floor(new Date("2023-06-01T00:00:00Z").getTime() / 1000);
      const afterS = Math.floor(new Date("2024-06-01T00:00:00Z").getTime() / 1000);
      utimesSync(join(dir, "before.txt"), beforeS, beforeS);
      utimesSync(join(dir, "after.txt"), afterS, afterS);
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", modifiedSince: "2024-01-01" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const paths = result.details!.ptcValue.entries.map((e: any) => e.path);
      expect(paths).toEqual(["after.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("excludes entries whose mtime equals the threshold exactly", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-ms-strict-"));
    try {
      writeFileSync(join(dir, "equal.txt"), "");
      writeFileSync(join(dir, "after.txt"), "");
      const threshold = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
      utimesSync(join(dir, "equal.txt"), threshold, threshold);
      utimesSync(join(dir, "after.txt"), threshold + 1, threshold + 1);
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", modifiedSince: "2024-01-01T00:00:00Z" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.details!.ptcValue.entries.map((e: any) => e.path)).toEqual(["after.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("find pipeline order (filter → sort → limit)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });
  it("limit applies after filter and sort — filtered-out high-ranked entries do not take the slot", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-pipeline-"));
    try {
      writeFileSync(join(dir, "old-a.txt"), "");
      writeFileSync(join(dir, "old-b.txt"), "");
      writeFileSync(join(dir, "old-c.txt"), "");
      writeFileSync(join(dir, "keep-a.txt"), "");
      writeFileSync(join(dir, "keep-b.txt"), "");
      const threshold = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
      utimesSync(join(dir, "old-a.txt"), threshold - 300, threshold - 300);
      utimesSync(join(dir, "old-b.txt"), threshold - 200, threshold - 200);
      utimesSync(join(dir, "old-c.txt"), threshold - 100, threshold - 100);
      utimesSync(join(dir, "keep-a.txt"), threshold + 1, threshold + 1);
      utimesSync(join(dir, "keep-b.txt"), threshold + 2, threshold + 2);
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        {
          pattern: "*.txt",
          modifiedSince: "2024-01-01T00:00:00Z",
          sortBy: "mtime",
          limit: 1,
        },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      expect(result.details!.ptcValue.entries.map((e: any) => e.path)).toEqual(["keep-a.txt"]);
      expect(result.details!.ptcValue.totalEntries).toBe(2);
      expect(result.details!.ptcValue.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("find backward-compat output pin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("omitting all new params preserves the exact legacy output and ptcValue", async () => {
    _testable.isFdAvailable = () => false;
    const prevHintShown = _testable.fdHintShown;
    _testable.fdHintShown = true;
    try {
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts" },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );

      expect(result.content?.[0]?.text).toBe("src/app.ts\nsrc/utils/helper.ts");
      expect(result.details!.ptcValue).toEqual({
        tool: "find",
        pattern: "*.ts",
        totalEntries: 2,
        truncated: false,
        entries: [
          { path: "src/app.ts", type: "file" },
          { path: "src/utils/helper.ts", type: "file" },
        ],
      });
    } finally {
      _testable.fdHintShown = prevHintShown;
    }
  });
});

describe("find minSize / maxSize filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("filters files by minSize using numeric bytes", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-minsize-"));
    try {
      writeFileSync(join(dir, "tiny.txt"), "a");
      writeFileSync(join(dir, "at-limit.txt"), "a".repeat(1024));
      writeFileSync(join(dir, "big.txt"), "a".repeat(5000));

      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", minSize: 1024 },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const paths = result.details!.ptcValue.entries.map((e: any) => e.path).sort();
      expect(paths).toEqual(["at-limit.txt", "big.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("filters files by maxSize using string shorthand '1K'", async () => {
    _testable.isFdAvailable = () => false;
    const dir = mkdtempSync(join(tmpdir(), "find-maxsize-"));
    try {
      writeFileSync(join(dir, "tiny.txt"), "a");
      writeFileSync(join(dir, "at-limit.txt"), "a".repeat(1024));
      writeFileSync(join(dir, "big.txt"), "a".repeat(5000));

      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.txt", maxSize: "1K" },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const paths = result.details!.ptcValue.entries.map((e: any) => e.path).sort();
      expect(paths).toEqual(["at-limit.txt", "tiny.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("size filters do not remove directories when type: 'any'", async () => {
    _testable.isFdAvailable = () => false;
    const { mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "find-size-dirs-"));
    try {
      mkdirSync(join(dir, "subdir"));
      writeFileSync(join(dir, "subdir", "inner.txt"), "a".repeat(10));
      writeFileSync(join(dir, "big.txt"), "a".repeat(5000));

      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*", type: "any", minSize: 100 },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      );
      const paths = result.details!.ptcValue.entries.map((e: any) => e.path);
      expect(paths).toContain("subdir");
      expect(paths).toContain("big.txt");
      expect(paths).not.toContain("subdir/inner.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("find filter error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("malformed modifiedSince returns a tool error naming the field and value", async () => {
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();
    const result = await tool.execute(
      "tc",
      { pattern: "*.ts", modifiedSince: "1y" },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    expect(result.isError).toBe(true);
    const msg = result.content?.[0]?.text ?? "";
    expect(msg).toMatch(/modifiedSince/);
    expect(msg).toContain("1y");
    expect(result.details?.ptcValue).toMatchObject({
      tool: "find",
      ok: false,
      error: { code: "invalid-params-combo", message: msg },
  });
  });
  it("malformed minSize returns a tool error naming the field and value", async () => {
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();
    const result = await tool.execute(
      "tc",
      { pattern: "*.ts", minSize: "10XB" },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    expect(result.isError).toBe(true);
    const msg = result.content?.[0]?.text ?? "";
    expect(msg).toMatch(/minSize/);
    expect(msg).toContain("10XB");
  });
  it("malformed maxSize returns a tool error naming the field and value", async () => {
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();
    const result = await tool.execute(
      "tc",
      { pattern: "*.ts", maxSize: "abc" },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    expect(result.isError).toBe(true);
    const msg = result.content?.[0]?.text ?? "";
    expect(msg).toMatch(/maxSize/);
    expect(msg).toContain("abc");
  });
});

describe("find stat skip when not needed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("does not call statAllWithConcurrency for a plain name-sorted search", async () => {
    _testable.isFdAvailable = () => false;
    const statMod = await import("../src/find-stat.js");
    const spy = vi.spyOn(statMod, "statAllWithConcurrency");

    const tool = await getFindTool();
    await tool.execute("tc", { pattern: "*.ts" }, new AbortController().signal, undefined, { cwd: fixturesDir });
    expect(spy).not.toHaveBeenCalled();
  });
  it("does call statAllWithConcurrency when sortBy is 'mtime'", async () => {
    _testable.isFdAvailable = () => false;
    const statMod = await import("../src/find-stat.js");
    const spy = vi.spyOn(statMod, "statAllWithConcurrency");

    const tool = await getFindTool();
    await tool.execute(
      "tc",
      { pattern: "*.ts", sortBy: "mtime" },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );
    expect(spy).toHaveBeenCalled();
  });
});
