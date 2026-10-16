import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureServerForFile = vi.fn(async (_path: string): Promise<any> => null);
vi.mock("./provision/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provision/session.js")>()),
  ensureServerForFile: (path: string) => ensureServerForFile(path),
}));
// A found codebase-memory-mcp binary would start a real daemon.
vi.mock("./cbm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cbm.js")>()),
  registerCbmTools: vi.fn(() => false),
}));

import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { registerEventHandlers, registerWorkerExtension } from "./event-handlers.js";

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
  };
}

/** Every handler's answer, in registration order; the host chains them the same way. */
async function emitAll(pi: any, name: string, event: any, ctx: any = {}): Promise<any[]> {
  const results: any[] = [];
  for (const handler of pi.handlers.get(name) ?? []) results.push(await handler(event, ctx));
  return results.filter((result) => result !== undefined);
}

function tool(pi: any, name: string): any {
  return pi.registerTool.mock.calls.map((call: any[]) => call[0]).find((entry: any) => entry.name === name);
}

const ERROR_AT_1_1 = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "bad thing" };

/** Stands in for the root session's LspManager: answers edit diagnostics without running a server. */
function stubLsp(cwd: string, items: any[] | null = [ERROR_AT_1_1]) {
  return {
    cwd,
    absolute: (path: string) => resolve(cwd, path),
    diagnosticsAfterEdit: vi.fn(async (_path: string, _budget: number, _signal?: AbortSignal) => items),
    warm: vi.fn(),
    available: vi.fn(() => []),
    servers: vi.fn(() => []),
    commandPath: vi.fn(() => null),
    shutdown: vi.fn(async () => {}),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pp-eh-lsp-"));
  ensureServerForFile.mockReset();
  ensureServerForFile.mockResolvedValue(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rootSession(afterEdit: Record<string, { run: string; globs?: string[] }> = {}, diagnosticsAfterEdit = true) {
  const pi = makePi();
  const orchestrator = new Orchestrator(pi);
  orchestrator.cwd = dir;
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.config.commands.afterEdit = afterEdit;
  orchestrator.config.lsp.diagnosticsAfterEdit = diagnosticsAfterEdit;
  orchestrator.config.images.enabled = false;
  registerEventHandlers(orchestrator);
  return { pi, orchestrator };
}

const editEvent = (path: string, overrides: Record<string, unknown> = {}) => ({
  toolName: "edit",
  input: { path },
  content: [{ type: "text", text: "Edited." }],
  isError: false,
  ...overrides,
});

/** The text the edit result gains, or undefined when the handlers leave it alone. */
async function appended(pi: any, event: any): Promise<string | undefined> {
  const results = await emitAll(pi, "tool_result", event, { signal: undefined });
  if (results.length === 0) return undefined;
  expect(results).toHaveLength(1);
  const content = results[0].content;
  expect(content.slice(0, event.content.length)).toEqual(event.content);
  return content.slice(event.content.length).map((block: any) => block.text).join("");
}

describe("root edit results", () => {
  it("appends a failing afterEdit command's output alone when no server reports", async () => {
    const { pi, orchestrator } = rootSession({ lint: { run: "echo lint says no; exit 3" } });
    orchestrator.lsp = stubLsp(dir, null) as any;
    const text = await appended(pi, editEvent("a.ts"));
    expect(text).toBe("\n\n<afterEdit>\nafterEdit command failed: echo lint says no; exit 3\nlint says no\n</afterEdit>");
  });

  it("appends a running server's diagnostics alone when no afterEdit command is configured", async () => {
    const { pi, orchestrator } = rootSession();
    const lsp = stubLsp(dir);
    orchestrator.lsp = lsp as any;
    const text = await appended(pi, editEvent("src/a.ts"));
    expect(text).toBe('\n\n<diagnostics file="src/a.ts">\nERROR 1:1 bad thing\n</diagnostics>');
    expect(lsp.diagnosticsAfterEdit).toHaveBeenCalledWith("src/a.ts", expect.any(Number), undefined);
  });

  it("puts diagnostics before the afterEdit section, taken after the commands ran", async () => {
    const marker = join(dir, "formatted");
    const { pi, orchestrator } = rootSession({
      format: { run: `touch ${marker}` },
      lint: { run: "echo still broken >&2; exit 1" },
    });
    const lsp = stubLsp(dir);
    let formattedFirst = false;
    lsp.diagnosticsAfterEdit.mockImplementation(async () => {
      formattedFirst = existsSync(marker);
      return [ERROR_AT_1_1];
    });
    orchestrator.lsp = lsp as any;
    const text = await appended(pi, editEvent("a.ts"));
    // A formatter in the afterEdit set rewrites the file; diagnostics of the
    // version before it would describe text that no longer exists.
    expect(formattedFirst).toBe(true);
    expect(text).toBe([
      "\n\n<diagnostics file=\"a.ts\">\nERROR 1:1 bad thing\n</diagnostics>",
      "<afterEdit>\nafterEdit command failed: echo still broken >&2; exit 1\nstill broken\n</afterEdit>",
    ].join("\n\n"));
  });

  it("leaves the result alone when every afterEdit command passes and no server reports", async () => {
    const { pi, orchestrator } = rootSession({ ok: { run: "true" } });
    orchestrator.lsp = stubLsp(dir, null) as any;
    expect(await appended(pi, editEvent("a.ts"))).toBeUndefined();
  });

  it("skips afterEdit for a file outside the project but still reports its diagnostics", async () => {
    const marker = join(dir, "ran");
    const { pi, orchestrator } = rootSession({ format: { run: `touch ${marker}; exit 1` } });
    const lsp = stubLsp(dir);
    orchestrator.lsp = lsp as any;
    const outside = join(tmpdir(), "elsewhere.ts");
    for (const path of ["../elsewhere.ts", outside]) {
      const text = await appended(pi, { ...editEvent(path), toolName: "write" });
      expect(text).toContain("<diagnostics file=");
      expect(text).toContain("ERROR 1:1 bad thing");
      expect(text).not.toContain("<afterEdit>");
    }
    expect(existsSync(marker)).toBe(false);
    expect(lsp.diagnosticsAfterEdit).toHaveBeenCalledTimes(2);
  });

  it("treats a project file whose name starts with two dots as inside the project", async () => {
    const { pi, orchestrator } = rootSession({ lint: { run: "echo seen ${file}; exit 1" } });
    orchestrator.lsp = stubLsp(dir, null) as any;
    expect(await appended(pi, editEvent("..hidden.ts"))).toContain("seen ..hidden.ts");
  });

  it("asks no server when diagnosticsAfterEdit is off, and still runs afterEdit", async () => {
    const { pi, orchestrator } = rootSession({ lint: { run: "echo nope; exit 1" } }, false);
    const lsp = stubLsp(dir);
    orchestrator.lsp = lsp as any;
    const text = await appended(pi, editEvent("a.ts"));
    expect(text).toBe("\n\n<afterEdit>\nafterEdit command failed: echo nope; exit 1\nnope\n</afterEdit>");
    expect(lsp.diagnosticsAfterEdit).not.toHaveBeenCalled();
  });

  it("ignores failed edits, other tools, and edits without a path", async () => {
    const marker = join(dir, "ran");
    const { pi, orchestrator } = rootSession({ format: { run: `touch ${marker}; exit 1` } });
    const lsp = stubLsp(dir);
    orchestrator.lsp = lsp as any;
    expect(await appended(pi, editEvent("a.ts", { isError: true }))).toBeUndefined();
    expect(await appended(pi, editEvent("a.ts", { toolName: "read" }))).toBeUndefined();
    expect(await appended(pi, editEvent("a.ts", { input: {} }))).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(lsp.diagnosticsAfterEdit).not.toHaveBeenCalled();
  });

  it("reads the edited path from any of the host's input spellings", async () => {
    const { pi, orchestrator } = rootSession();
    orchestrator.lsp = stubLsp(dir) as any;
    for (const input of [{ file_path: "x.ts" }, { filePath: "x.ts" }]) {
      expect(await appended(pi, editEvent("unused", { input }))).toContain('<diagnostics file="x.ts">');
    }
  });

  it("does nothing before a config has loaded", async () => {
    const { pi, orchestrator } = rootSession({ lint: { run: "exit 1" } });
    const lsp = stubLsp(dir);
    orchestrator.lsp = lsp as any;
    (orchestrator as any)._config = undefined;
    expect(await appended(pi, editEvent("a.ts"))).toBeUndefined();
    expect(lsp.diagnosticsAfterEdit).not.toHaveBeenCalled();
  });

  it("appends afterEdit output even when the session has no language servers", async () => {
    const { pi } = rootSession({ lint: { run: "echo x; exit 1" } });
    expect(await appended(pi, editEvent("a.ts"))).toContain("<afterEdit>");
  });
});

describe("lazy provisioning on tool calls", () => {
  it("holds an lsp call until the language server install settles", async () => {
    const { pi } = rootSession();
    let finish: (value: any) => void = () => {};
    ensureServerForFile.mockReturnValueOnce(new Promise((done) => { finish = done; }));
    let settled = false;
    const call = emitAll(pi, "tool_call", { toolName: "lsp", input: { operation: "hover", filePath: "main.go" } }).then((results) => {
      settled = true;
      return results;
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(ensureServerForFile).toHaveBeenCalledWith("main.go");
    expect(settled).toBe(false);
    finish({ status: "installed", binary: "gopls" });
    // Nothing patches the call's input: answering would shadow another handler's patch.
    expect(await call).toEqual([]);
  });

  it("warms the install in the background for reads and edits without holding them", async () => {
    const { pi } = rootSession();
    ensureServerForFile.mockReturnValue(new Promise(() => {}));
    for (const [toolName, input] of [["read", { path: "a.py" }], ["edit", { file_path: "b.rs" }], ["write", { path: "c.go" }]] as const) {
      expect(await emitAll(pi, "tool_call", { toolName, input })).toEqual([]);
    }
    expect(ensureServerForFile.mock.calls.map((call) => call[0])).toEqual(["a.py", "b.rs", "c.go"]);
  });

  it("installs nothing for other tools or paths without an extension", async () => {
    const { pi } = rootSession();
    await emitAll(pi, "tool_call", { toolName: "bash", input: { path: "a.py" } });
    await emitAll(pi, "tool_call", { toolName: "lsp", input: { operation: "workspaceSymbol", query: "x" } });
    await emitAll(pi, "tool_call", { toolName: "read", input: { path: "Makefile" } });
    await emitAll(pi, "tool_call", { toolName: "read" });
    expect(ensureServerForFile).not.toHaveBeenCalled();
  });
});

describe("worker sessions", () => {
  function workerSession(diagnosticsAfterEdit = true) {
    const root = new Orchestrator(makePi());
    root.cwd = dir;
    root.config = normalizeConfigDurations(getDefaultConfig());
    root.config.lsp.diagnosticsAfterEdit = diagnosticsAfterEdit;
    root.config.images.enabled = false;
    const pi = makePi();
    registerWorkerExtension(root, pi);
    return { root, pi };
  }

  it("registers pi-pi's own tools in the worker", () => {
    const { pi } = workerSession();
    const names = pi.registerTool.mock.calls.map((call: any[]) => call[0].name);
    expect(names).toEqual(expect.arrayContaining(["lsp", "load_skill", "vcc_recall", "recall_tool_output", "web_search", "web_fetch"]));
    // The root's own concerns stay out of a worker.
    expect(names).not.toContain("Agent");
    expect(names).not.toContain("ask_user");
  });

  it("binds the lsp tool to whatever language servers the root session holds now", async () => {
    const { root, pi } = workerSession();
    const lsp = tool(pi, "lsp");
    writeFileSync(join(dir, "a.ts"), "x\n");
    await expect(lsp.execute("id", { operation: "diagnostics", filePath: "a.ts" })).rejects.toThrow("not available in this session");
    root.lsp = stubLsp(dir) as any;
    await expect(lsp.execute("id", { operation: "diagnostics", filePath: "a.ts" })).rejects.toThrow("No language server is configured for .ts files");
  });

  it("appends the root's diagnostics to a worker's successful edit", async () => {
    const { root, pi } = workerSession();
    const lsp = stubLsp(dir);
    root.lsp = lsp as any;
    expect(await appended(pi, editEvent("a.ts"))).toBe('\n\n<diagnostics file="a.ts">\nERROR 1:1 bad thing\n</diagnostics>');
    expect(await appended(pi, editEvent("a.ts", { isError: true }))).toBeUndefined();
    lsp.diagnosticsAfterEdit.mockResolvedValueOnce(null);
    expect(await appended(pi, editEvent("a.ts"))).toBeUndefined();
  });

  it("leaves worker edits alone when diagnosticsAfterEdit is off, and warms nothing", async () => {
    const { root, pi } = workerSession(false);
    const lsp = stubLsp(dir);
    root.lsp = lsp as any;
    expect(await appended(pi, editEvent("a.ts"))).toBeUndefined();
    await emitAll(pi, "tool_call", { toolName: "read", input: { path: "a.ts" } });
    expect(lsp.diagnosticsAfterEdit).not.toHaveBeenCalled();
    expect(lsp.warm).not.toHaveBeenCalled();
  });

  it("warms the root's servers when a worker reads a file", async () => {
    const { root, pi } = workerSession();
    const lsp = stubLsp(dir);
    root.lsp = lsp as any;
    await emitAll(pi, "tool_call", { toolName: "read", input: { path: "a.ts" } });
    expect(lsp.warm).toHaveBeenCalledWith("a.ts");
  });
});
