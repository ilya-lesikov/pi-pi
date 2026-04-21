import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isFdAvailable, _testable } from "../src/find.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures/find-basic");
const _originalIsFdAvailable = isFdAvailable;
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalExecFile = childProcess.execFile;

function installExecFileMock(impl: any) {
  const mock = vi.fn(impl);
  childProcess.execFile = mock;
  syncBuiltinESMExports();
  return mock;
}

function restoreExecFileMock() {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}

async function getFindTool() {
  const { registerFindTool } = await import("../src/find.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerFindTool(mockPi as any);
  if (!captured) throw new Error("find tool was not registered");
  return captured;
}

describe("find regex (fallback)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("matches a JavaScript regex against entry basenames", async () => {
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();

    const result = await tool.execute(
      "tc",
      { pattern: "(app|helper)\\.ts$", regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    const paths = result.details?.ptcValue.entries.map((e: any) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/utils/helper.ts");
    expect(paths).not.toContain("README.md");
  });

  it("applies ^ and $ to the basename rather than the full relative path", async () => {
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();

    const result = await tool.execute(
      "tc",
      { pattern: "^app\\.ts$", regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    const paths = result.details?.ptcValue.entries.map((e: any) => e.path);
    expect(paths).toEqual(["src/app.ts"]);
  });
});


describe("find regex backend parity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreExecFileMock();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("returns identical regex results with fd mocked on or off", async () => {
    const tool = await getFindTool();

    _testable.isFdAvailable = () => true;
    const fdSpy = installExecFileMock(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "README.md\n.hidden-file\ndocs/guide.md\nsrc/app.ts\nsrc/utils/helper.ts\n", "");
      return {} as any;
    }) as any);
    const withFd = await tool.execute(
      "tc",
      { pattern: "(app|helper)\\.ts$", regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );
    restoreExecFileMock();
    _testable.isFdAvailable = () => false;
    const fallback = await tool.execute(
      "tc",
      { pattern: "(app|helper)\\.ts$", regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );

    expect(withFd.details?.ptcValue.entries).toEqual(fallback.details?.ptcValue.entries);
  });

  it("does not pass --regex to fd even when regex: true", async () => {
    _testable.isFdAvailable = () => true;
    const spy = installExecFileMock(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "src/app.ts\nsrc/utils/helper.ts\n", "");
      return {} as any;
    }) as any);

    const tool = await getFindTool();
    await tool.execute(
      "tc",
      { pattern: "anything", regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--regex");
    }
  });
});


describe("find regex invalid input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _testable.isFdAvailable = _originalIsFdAvailable;
  });

  it("returns a tool error naming pattern/regex and the offending value", async () => {
    const badPattern = "(unterminated";
    _testable.isFdAvailable = () => false;
    const tool = await getFindTool();
    const result = await tool.execute(
      "tc",
      { pattern: badPattern, regex: true },
      new AbortController().signal,
      undefined,
      { cwd: fixturesDir },
    );
    expect(result.isError).toBe(true);
    const msg = result.content?.[0]?.text ?? "";
    expect(msg).toMatch(/pattern/i);
    expect(msg).toMatch(/regex/i);
    expect(msg).toContain(badPattern);
    expect(result.details?.ptcValue).toMatchObject({
      tool: "find",
      ok: false,
      error: { code: "invalid-params-combo", message: msg },
    });
  });
});
