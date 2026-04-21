import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
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

describe("find regex schema", () => {
  afterEach(() => { vi.restoreAllMocks(); _testable.isFdAvailable = _originalIsFdAvailable; });

  it("schema exposes a 'regex' boolean parameter", async () => {
    const tool = await getFindTool();
    expect(tool.parameters.properties.regex).toBeDefined();
    expect(tool.parameters.properties.regex.type).toBe("boolean");
  });

  it("passing regex: false (or omitting) preserves current glob behavior", async () => {
    _testable.isFdAvailable = () => false;
    const prevHintShown = _testable.fdHintShown;
    _testable.fdHintShown = true;
    try {
      const tool = await getFindTool();
      const resultOmit = await tool.execute(
        "tc",
        { pattern: "*.ts" },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );
      const resultFalse = await tool.execute(
        "tc",
        { pattern: "*.ts", regex: false },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );
      expect(resultFalse.details?.ptcValue.entries).toEqual(
        resultOmit.details?.ptcValue.entries,
      );
      expect(resultFalse.content?.[0]?.text).toBe(resultOmit.content?.[0]?.text);
    } finally {
      _testable.fdHintShown = prevHintShown;
    }
  });
});

describe("find sortBy/reverse schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("schema exposes sortBy and reverse", async () => {
    const tool = await getFindTool();
    expect(tool.parameters.properties.sortBy).toBeDefined();
    expect(tool.parameters.properties.reverse).toBeDefined();
    expect(tool.parameters.properties.reverse.type).toBe("boolean");
    const serialized = JSON.stringify(tool.parameters.properties.sortBy);
    expect(serialized).toContain("name");
    expect(serialized).toContain("mtime");
    expect(serialized).toContain("size");
  });

  it("sortBy: 'name' (default) preserves current lexicographic output", async () => {
    _testable.isFdAvailable = () => false;
    const prevHintShown = _testable.fdHintShown;
    _testable.fdHintShown = true;
    try {
      const tool = await getFindTool();
      const def = await tool.execute(
        "tc",
        { pattern: "*.ts" },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );
      const explicit = await tool.execute(
        "tc",
        { pattern: "*.ts", sortBy: "name" },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );
      expect(explicit.content?.[0]?.text).toBe(def.content?.[0]?.text);
    } finally {
      _testable.fdHintShown = prevHintShown;
    }
  });

  it("sortBy: 'name', reverse: true sorts lexicographically descending", async () => {
    _testable.isFdAvailable = () => false;
    const prevHintShown = _testable.fdHintShown;
    _testable.fdHintShown = true;
    try {
      const tool = await getFindTool();
      const result = await tool.execute(
        "tc",
        { pattern: "*.ts", sortBy: "name", reverse: true },
        new AbortController().signal,
        undefined,
        { cwd: fixturesDir },
      );
      expect(result.details!.ptcValue.entries.map((e: any) => e.path)).toEqual([
        "src/utils/helper.ts",
        "src/app.ts",
      ]);
    } finally {
      _testable.fdHintShown = prevHintShown;
    }
  });
});

describe("find modifiedSince/minSize/maxSize schema", () => {
  afterEach(() => { vi.restoreAllMocks(); _testable.isFdAvailable = _originalIsFdAvailable; });

  it("schema exposes modifiedSince (string), minSize and maxSize (number|string)", async () => {
    const tool = await getFindTool();
    expect(tool.parameters.properties.modifiedSince).toBeDefined();
    expect(tool.parameters.properties.modifiedSince.type).toBe("string");
    expect(tool.parameters.properties.minSize).toBeDefined();
    expect(tool.parameters.properties.maxSize).toBeDefined();
    const minSer = JSON.stringify(tool.parameters.properties.minSize);
    expect(minSer).toContain("number");
    expect(minSer).toContain("string");
  });
});
