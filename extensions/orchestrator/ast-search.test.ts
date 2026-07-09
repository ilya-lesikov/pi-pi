import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

import { registerAstSearchTool } from "./ast-search.js";

const SG_AVAILABLE_KEY = Symbol.for("pi-pi:sg-available");

function makePi() {
  const registerTool = vi.fn();
  return { pi: { registerTool } as any, registerTool };
}

function setSg(value: boolean | undefined) {
  (globalThis as any)[SG_AVAILABLE_KEY] = value;
}

afterEach(() => {
  setSg(undefined);
  mocks.execFile.mockReset();
  mocks.execFileSync.mockReset();
});

describe("registerAstSearchTool availability", () => {
  it("returns false and registers no tool when sg is unavailable", () => {
    setSg(false);
    const { pi, registerTool } = makePi();
    expect(registerAstSearchTool(pi, "/repo")).toBe(false);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("returns true and registers an ast_search tool when sg is available", () => {
    setSg(true);
    const { pi, registerTool } = makePi();
    expect(registerAstSearchTool(pi, "/repo")).toBe(true);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0][0].name).toBe("ast_search");
  });
});

function registerAndGetTool(cwd: string) {
  setSg(true);
  const { pi, registerTool } = makePi();
  registerAstSearchTool(pi, cwd);
  return registerTool.mock.calls[0][0];
}

describe("ast_search execute", () => {
  it("fails when the search path does not exist", async () => {
    const tool = registerAndGetTool(process.cwd());
    const result = await tool.execute("id", { pattern: "$X", path: "definitely-not-a-real-dir-xyz" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not exist");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("lists matches as file:line: text on valid JSON stdout", async () => {
    const matches = [
      { file: "a.ts", range: { start: { line: 4 } }, text: "  const x = 1  " },
      { file: "b.ts", range: { start: { line: 0 } }, matchedCode: "y := 2" },
    ];
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(matches), "");
    });
    const tool = registerAndGetTool(process.cwd());
    const result = await tool.execute("id", { pattern: "$X", path: "." });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("2 match(es):");
    expect(result.content[0].text).toContain("a.ts:5: const x = 1");
    expect(result.content[0].text).toContain("b.ts:1: y := 2");
  });

  it("reports no matches on empty stdout", async () => {
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "", "");
    });
    const tool = registerAndGetTool(process.cwd());
    const result = await tool.execute("id", { pattern: "$X", path: "." });
    expect(result.content[0].text).toBe("No matches found.");
  });

  it("reports no matches on an empty JSON array", async () => {
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "[]", "");
    });
    const tool = registerAndGetTool(process.cwd());
    const result = await tool.execute("id", { pattern: "$X", path: "." });
    expect(result.content[0].text).toBe("No matches found.");
  });

  it("fails when execFile errors without stdout", async () => {
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error("boom"), "", "sg exploded");
    });
    const tool = registerAndGetTool(process.cwd());
    const result = await tool.execute("id", { pattern: "$X", path: "." });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ast_search error:");
    expect(result.content[0].text).toContain("sg exploded");
  });

  it("maps lang to -l and resolves path against cwd", async () => {
    let capturedArgs: string[] = [];
    mocks.execFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      capturedArgs = args;
      cb(null, "[]", "");
    });
    const cwd = process.cwd();
    const tool = registerAndGetTool(cwd);
    await tool.execute("id", { pattern: "func $NAME", lang: "go", path: "." });
    expect(capturedArgs.slice(0, 4)).toEqual(["run", "--json", "-p", "func $NAME"]);
    expect(capturedArgs).toContain("-l");
    expect(capturedArgs[capturedArgs.indexOf("-l") + 1]).toBe("go");
    expect(capturedArgs[capturedArgs.length - 1]).toBe(cwd);
  });
});
