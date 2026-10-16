import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspManager } from "./manager.js";
import { BUILTIN_SERVERS, findRoot, resolveServers, which, type ServerConfig } from "./servers.js";
import { editDiagnostics, registerLspTool } from "./tool.js";

const MOCK = fileURLToPath(new URL("./fixtures/mock-server.mjs", import.meta.url));
const FAST = { request: 2_000, initialize: 5_000, indexing: 3_000 };

let dir: string;
let managers: LspManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pp-lsp-"));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdown()));
  rmSync(dir, { recursive: true, force: true });
});

function mockServer(mode: string[] = [], extra: ServerConfig = {}): ServerConfig {
  return {
    command: [process.execPath, MOCK],
    extensions: [".mock"],
    env: { MOCK_LSP_MODE: mode.join(","), MOCK_LSP_LOG: join(dir, "server.log"), MOCK_LSP_ROOT: dir },
    ...extra,
  };
}

function manager(servers: Record<string, ServerConfig>, options: { project?: Record<string, ServerConfig>; trusted?: boolean; now?: () => number } = {}): LspManager {
  const created = new LspManager(dir, () => ({ global: servers, project: options.project, trusted: options.trusted ?? true }), FAST, options.now);
  managers.push(created);
  return created;
}

function serverLog(): any[] {
  try {
    return readFileSync(join(dir, "server.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function write(name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function toolFor(current: LspManager) {
  let tool: any;
  registerLspTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => current);
  return async (params: Record<string, unknown>) => (await tool.execute("call", params, undefined)).content[0].text as string;
}

describe("server definitions", () => {
  it("layers global and project fields over the built-ins and adds new servers", () => {
    const { servers, errors } = resolveServers(
      { typescript: { command: ["/opt/tsls", "--stdio"] }, mock: { command: ["mock-ls"], extensions: ["mock"] } },
      { typescript: { rootMarkers: ["deno.json"] } },
      true,
    );
    const ts = servers.find((server) => server.name === "typescript")!;
    expect(ts.command).toEqual(["/opt/tsls", "--stdio"]);
    expect(ts.extensions).toEqual(BUILTIN_SERVERS.typescript!.extensions);
    expect(ts.rootMarkers).toEqual(["deno.json"]);
    expect(servers.find((server) => server.name === "mock")!.extensions).toEqual([".mock"]);
    expect(errors).toEqual([]);
  });

  it("lets either layer switch a server off, and the project switch it back on", () => {
    expect(resolveServers({ go: { enabled: false } }, undefined, true).servers.some((server) => server.name === "go")).toBe(false);
    expect(resolveServers({ go: { enabled: false } }, { go: { enabled: true } }, true).servers.some((server) => server.name === "go")).toBe(true);
  });

  it("reports a new server that lacks a command or extensions instead of launching it", () => {
    const { servers, errors } = resolveServers({ half: { extensions: [".x"] }, other: { command: ["x"] } }, undefined, true);
    expect(servers.some((server) => server.name === "half" || server.name === "other")).toBe(false);
    expect(errors).toEqual(["half: needs a non-empty command", "other: needs at least one file extension"]);
  });

  it("ignores what an untrusted project would run, but keeps what it narrows", () => {
    const { servers, untrusted, errors } = resolveServers(
      undefined,
      { python: { command: ["./evil"], env: { LD_PRELOAD: "x" }, rootMarkers: ["setup.py"] }, rogue: { command: ["./rogue"], extensions: [".r"] }, go: { enabled: false } },
      false,
    );
    const python = servers.find((server) => server.name === "python")!;
    expect(python.command).toEqual(BUILTIN_SERVERS.python!.command);
    expect(python.env).toEqual({});
    expect(python.rootMarkers).toEqual(["setup.py"]);
    expect(servers.some((server) => server.name === "rogue" || server.name === "go")).toBe(false);
    expect(untrusted.sort()).toEqual(["python", "rogue"]);
    expect(errors).toEqual([]);
  });

  it("finds the nearest marked root at or above the file, never above the workspace", () => {
    write("go.mod", "module root");
    write("svc/api/go.mod", "module api");
    write("svc/api/pkg/a.go", "");
    write("svc/other/b.go", "");
    expect(findRoot(join(dir, "svc/api/pkg/a.go"), dir, ["go.mod"])).toBe(join(dir, "svc/api"));
    expect(findRoot(join(dir, "svc/other/b.go"), dir, ["go.mod"])).toBe(dir);
    expect(findRoot("svc/api/pkg/a.go", dir, [])).toBe(dir);
    write("proj/App.csproj", "");
    write("proj/src/a.cs", "");
    expect(findRoot(join(dir, "proj/src/a.cs"), dir, ["*.csproj"])).toBe(join(dir, "proj"));
  });

  it("resolves commands on PATH and as paths without running them", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    write("bin/fake-ls", "#!/bin/sh\n");
    write("bin/not-exec", "");
    if (process.platform !== "win32") {
      chmodSync(join(bin, "fake-ls"), 0o755);
      expect(which("fake-ls", { PATH: bin })).toBe(join(bin, "fake-ls"));
      expect(which("not-exec", { PATH: bin })).toBeNull();
    }
    expect(which(process.execPath)).toBe(process.execPath);
    expect(which("definitely-not-a-real-binary-xyz", { PATH: bin })).toBeNull();
  });
});

describe("lsp tool against a live server", () => {
  it("answers position operations with 1-indexed input converted for the server", async () => {
    const file = write("a.mock", "fn main() {\n  x\n  ref()\n}\n");
    const lsp = toolFor(manager({ mock: mockServer() }));
    expect(await lsp({ operation: "hover", filePath: "a.mock", line: 2, character: 3 })).toContain("hover 1:2");
    expect(await lsp({ operation: "goToDefinition", filePath: file, line: 1, character: 4 })).toContain("a.mock:1:2");
    expect(await lsp({ operation: "findReferences", filePath: "a.mock", line: 1, character: 4 })).toContain("a.mock:3:5");
    expect(await lsp({ operation: "documentSymbol", filePath: "a.mock" })).toContain("main");
    expect(await lsp({ operation: "incomingCalls", filePath: "a.mock", line: 1, character: 10 })).toContain("caller");
    expect(await lsp({ operation: "outgoingCalls", filePath: "a.mock", line: 1, character: 10 })).toContain("callee");
    expect(await lsp({ operation: "workspaceSymbol", filePath: "a.mock", query: "foo" })).toContain("sym_foo");
    const opens = serverLog().filter((message) => message.method === "textDocument/didOpen");
    expect(opens).toHaveLength(1);
    expect(opens[0].params.textDocument.languageId).toBe("mock");
  });

  it("searches the workspace without a file through a running server, opening a file of the project first", async () => {
    write("src/a.mock", "x\n");
    const current = manager({ mock: mockServer([], { rootMarkers: ["proj.marker"] }) });
    const lsp = toolFor(current);
    await expect(lsp({ operation: "workspaceSymbol", query: "foo" })).rejects.toThrow("Pass filePath");
    write("proj.marker", "");
    expect(await lsp({ operation: "workspaceSymbol", query: "foo" })).toContain("sym_foo");
    const opened = serverLog().filter((message) => message.method === "textDocument/didOpen").map((message) => message.params.textDocument.uri);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/src\/a\.mock$/);
  });

  it("roots a fileless workspace search at the workspace even when an ancestor has the marker", async () => {
    write("proj.marker", "");
    write("pkg/proj.marker", "");
    write("pkg/src/a.mock", "x\n");
    const current = new LspManager(join(dir, "pkg"), () => ({ global: { mock: mockServer([], { rootMarkers: ["proj.marker"] }) }, trusted: true }), FAST);
    managers.push(current);
    expect(await toolFor(current)({ operation: "workspaceSymbol", query: "foo" })).toContain("sym_foo");
    const roots = serverLog().filter((message) => message.method === "initialize").map((message) => fileURLToPath(message.params.rootUri));
    expect(roots).toEqual([join(dir, "pkg")]);
  });

  it("keeps only the first lines of a server error", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer(["error-stack"]) }));
    const error = await lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 }).catch((caught) => caught);
    expect(error.message).toContain("textDocument/hover failed: No Project.");
    expect(error.message).not.toContain("at two");
  });

  it("names the operation a running server does not support", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer(["no-workspace-symbol"]) }));
    await expect(lsp({ operation: "workspaceSymbol", filePath: "a.mock", query: "q" })).rejects.toThrow("No running language server for .mock supports workspaceSymbol (tried mock)");
  });

  it("rejects missing arguments with the parameter it needs", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer() }));
    await expect(lsp({ operation: "hover", filePath: "a.mock" })).rejects.toThrow("requires line");
    await expect(lsp({ operation: "hover" })).rejects.toThrow("requires filePath");
    await expect(lsp({ operation: "workspaceSymbol" })).rejects.toThrow("requires query");
    await expect(lsp({ operation: "hover", filePath: "missing.mock", line: 1, character: 1 })).rejects.toThrow("File not found");
  });

  it("says why no server answers: none configured, or not installed", async () => {
    write("a.unknown", "x\n");
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer([], { command: ["no-such-language-server-xyz"] }) }));
    await expect(lsp({ operation: "diagnostics", filePath: "a.unknown" })).rejects.toThrow("No language server is configured for .unknown files");
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("needs no-such-language-server-xyz on PATH");
  });

  it("reports diagnostics after an edit, not the stale ones from before it", async () => {
    write("a.mock", "fine\n");
    const lsp = toolFor(manager({ mock: mockServer() }));
    expect(await lsp({ operation: "diagnostics", filePath: "a.mock" })).toContain("No diagnostics");
    write("a.mock", "fine\nERROR here\n");
    const text = await lsp({ operation: "diagnostics", filePath: "a.mock" });
    expect(text).toContain("bad thing on line 2");
    const changes = serverLog().filter((message) => message.method === "textDocument/didChange");
    expect(changes).toHaveLength(1);
    expect(changes[0].params.textDocument.version).toBe(2);
  });

  it("sends an edit the server has not seen even when the file kept its timestamp", async () => {
    const path = write("a.mock", "fine\n");
    utimesSync(path, 1_000, 1_000);
    const lsp = toolFor(manager({ mock: mockServer() }));
    await lsp({ operation: "diagnostics", filePath: "a.mock" });
    write("a.mock", "ERROR\n");
    utimesSync(path, 1_000, 1_000);
    expect(await lsp({ operation: "diagnostics", filePath: "a.mock" })).toContain("bad thing on line 1");
  });

  it("saves the file on first open as well as on change, for servers that check on save", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer() }));
    await lsp({ operation: "documentSymbol", filePath: "a.mock" });
    expect(serverLog().filter((message) => message.method === "textDocument/didSave")).toHaveLength(1);
  });

  it("does not pass off diagnostics for older content as current when the server is slow", async () => {
    write("a.mock", "ERROR\n");
    // Every report arrives 2s after the change: longer than an edit waits, shorter than the tool does.
    const current = manager({ mock: mockServer(["versioned"], { env: { MOCK_LSP_MODE: "versioned", MOCK_LSP_PUBLISH_DELAY: "2000", MOCK_LSP_LOG: join(dir, "server.log") } }) });
    const lsp = toolFor(current);
    expect(await lsp({ operation: "diagnostics", filePath: "a.mock" })).toContain("bad thing");
    write("a.mock", "fine\n");
    expect(await editDiagnostics(current, { toolName: "edit", input: { path: "a.mock" } })).toBeNull();
    const result = await current.running()[0]!.diagnostics(join(dir, "a.mock"), 100);
    expect(result.reported).toBe(false);
    expect(result.items).toHaveLength(1);
  }, 15_000);

  it("forgets a closed document's diagnostics so a reopen cannot be answered from them", async () => {
    write("a.mock", "ERROR\n");
    for (let i = 0; i < 64; i++) write(`f${i}.mock`, "x\n");
    const current = manager({ mock: mockServer() });
    const lsp = toolFor(current);
    await lsp({ operation: "diagnostics", filePath: "a.mock" });
    const client = current.running()[0]!;
    expect(client.knownDiagnostics(join(dir, "a.mock"))).toHaveLength(1);
    for (let i = 0; i < 64; i++) client.sync(join(dir, `f${i}.mock`));
    expect(client.openDocuments).toBe(64);
    expect(client.knownDiagnostics(join(dir, "a.mock"))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serverLog().some((message) => message.method === "textDocument/didClose" && message.params.textDocument.uri.endsWith("/a.mock"))).toBe(true);
  });

  it("waits out a clearing empty push for the real diagnostics", async () => {
    write("a.mock", "ERROR\n");
    const lsp = toolFor(manager({ mock: mockServer(["push-stale-first"]) }));
    expect(await lsp({ operation: "diagnostics", filePath: "a.mock" })).toContain("bad thing on line 1");
  });

  it("pulls diagnostics from a server that offers them", async () => {
    write("a.mock", "WARN\n");
    const lsp = toolFor(manager({ mock: mockServer(["pull"]) }));
    expect(await lsp({ operation: "diagnostics", filePath: "a.mock" })).toContain("suspicious");
    expect(serverLog().some((message) => message.method === "textDocument/diagnostic")).toBe(true);
  });

  it("notes a server that reports nothing within the wait instead of claiming the file is clean", async () => {
    write("a.mock", "ERROR\n");
    const current = manager({ mock: mockServer(["silent"]) });
    const client = await current.client(current.available(join(dir, "a.mock"))[0]!, "a.mock");
    const result = await client.diagnostics(join(dir, "a.mock"), 200);
    expect(result.reported).toBe(false);
  });

  it("answers the server's configuration request with one entry per item, and unknown requests with an error", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer(["ask-configuration", "unknown-request"], { settings: { mock: { nested: { on: true } } } }) }));
    await lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 });
    const log = serverLog();
    expect(log.find((entry) => entry.configurationAnswer)?.configurationAnswer.result).toEqual([{ nested: { on: true } }, { on: true }, null]);
    expect(log.find((entry) => entry.unknownAnswer)?.unknownAnswer.error.code).toBe(-32601);
  });

  it("holds project-wide queries until the server finishes indexing", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer(["progress"], { env: { MOCK_LSP_MODE: "progress", MOCK_LSP_INDEX_MS: "400", MOCK_LSP_LOG: join(dir, "server.log") } }) }));
    const started = Date.now();
    const text = await lsp({ operation: "findReferences", filePath: "a.mock", line: 1, character: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(text).not.toContain("still indexing");
  });

  it("says results may be incomplete when indexing outlasts the wait", async () => {
    write("a.mock", "x\n");
    const current = new LspManager(dir, () => ({ global: { mock: mockServer(["progress"], { env: { MOCK_LSP_MODE: "progress", MOCK_LSP_INDEX_MS: "5000" } }) }, trusted: true }), { ...FAST, indexing: 200 });
    managers.push(current);
    expect(await toolFor(current)({ operation: "findReferences", filePath: "a.mock", line: 1, character: 1 })).toContain("still indexing");
  });

  it("times out a request the server never answers and cancels it", async () => {
    write("a.mock", "x\n");
    const current = new LspManager(dir, () => ({ global: { mock: mockServer(["hang-hover"]) }, trusted: true }), { ...FAST, request: 300 });
    managers.push(current);
    await expect(toolFor(current)({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serverLog().some((message) => message.method === "$/cancelRequest")).toBe(true);
  });
});

describe("server lifecycle", () => {
  it("backs off a server that fails to start rather than respawning it on every call", async () => {
    write("a.mock", "x\n");
    let now = 1_000_000;
    const current = manager({ mock: mockServer(["crash-on-start"]) }, { now: () => now });
    const lsp = toolFor(current);
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("failed to start");
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("next attempt in");
    now += 6_000;
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("failed to start");
  });

  it("includes the server's stderr when it dies on start", async () => {
    write("a.mock", "x\n");
    const lsp = toolFor(manager({ mock: mockServer(["crash-on-start"]) }));
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow("mock: refusing to start");
  });

  it("starts a fresh process after a crash once the backoff passes", async () => {
    write("a.mock", "x\n");
    let now = 1_000_000;
    const current = manager({ mock: mockServer(["crash-on-change"]) }, { now: () => now });
    const lsp = toolFor(current);
    await lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 });
    write("a.mock", "y\n");
    await expect(lsp({ operation: "hover", filePath: "a.mock", line: 1, character: 1 })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    now += 10_000;
    write("a.mock", "z\n");
    const initializes = () => serverLog().filter((message) => message.method === "initialize").length;
    await lsp({ operation: "documentSymbol", filePath: "a.mock" });
    expect(initializes()).toBe(2);
  });

  it("runs one process per project root", async () => {
    write("one/root.marker", "");
    write("two/root.marker", "");
    write("one/a.mock", "x\n");
    write("two/b.mock", "x\n");
    const current = manager({ mock: mockServer([], { rootMarkers: ["root.marker"] }) });
    const lsp = toolFor(current);
    await lsp({ operation: "documentSymbol", filePath: "one/a.mock" });
    await lsp({ operation: "documentSymbol", filePath: "two/b.mock" });
    await lsp({ operation: "documentSymbol", filePath: "one/a.mock" });
    const roots = serverLog().filter((message) => message.method === "initialize").map((message) => fileURLToPath(message.params.rootUri));
    expect(roots.sort()).toEqual([join(dir, "one"), join(dir, "two")]);
  });

  it("shuts servers down and refuses new work once the session ends", async () => {
    write("a.mock", "x\n");
    const current = manager({ mock: mockServer() });
    const lsp = toolFor(current);
    await lsp({ operation: "documentSymbol", filePath: "a.mock" });
    const pid = current.running()[0]!.pid!;
    await current.shutdown();
    expect(serverLog().some((message) => message.method === "shutdown")).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(lsp({ operation: "documentSymbol", filePath: "a.mock" })).rejects.toThrow("shut down");
  });

  it("kills a server that ignores shutdown", async () => {
    write("a.mock", "x\n");
    const current = manager({ mock: mockServer(["ignore-shutdown"]) });
    await toolFor(current)({ operation: "documentSymbol", filePath: "a.mock" });
    const pid = current.running()[0]!.pid!;
    await current.restart();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("describes installed, missing and broken servers for the doctor", async () => {
    const current = manager({
      ...Object.fromEntries(Object.keys(BUILTIN_SERVERS).map((name) => [name, { enabled: false }])),
      mock: mockServer(),
      broken: mockServer(["crash-on-start"], { extensions: [".broken"] }),
      absent: { command: ["no-such-language-server-xyz"], extensions: [".absent"] },
    });
    const state = await current.describe(true);
    expect(state.servers.find((server) => server.name === "mock")).toMatchObject({ probe: "ok", running: true });
    const broken = state.servers.find((server) => server.name === "broken")!;
    expect(broken.probe).toBe("failed");
    expect(broken.stderr.join("\n")).toContain("refusing to start");
    expect(state.missing.map((server) => server.name)).toEqual(["absent"]);
  });
});

describe("diagnostics after an edit", () => {
  it("reports errors and warnings from a running server, and nothing when none is running", async () => {
    write("a.mock", "fine\n");
    const current = manager({ mock: mockServer() });
    const event = { toolName: "edit", input: { path: "a.mock" }, isError: false };
    expect(await editDiagnostics(current, event)).toBeNull();
    expect(current.running()).toHaveLength(0);
    await toolFor(current)({ operation: "documentSymbol", filePath: "a.mock" });
    write("a.mock", "ERROR\nWARN\nHINT\n");
    const text = await editDiagnostics(current, event);
    expect(text).toContain('<diagnostics file="a.mock">');
    expect(text).toContain("bad thing on line 1");
    expect(text).toContain("suspicious");
    expect(text).not.toContain("a hint");
    write("a.mock", "fine again\n");
    expect(await editDiagnostics(current, event)).toBeNull();
  });

  it("skips failed edits and other tools", async () => {
    write("a.mock", "ERROR\n");
    const current = manager({ mock: mockServer() });
    await toolFor(current)({ operation: "documentSymbol", filePath: "a.mock" });
    expect(await editDiagnostics(current, { toolName: "edit", input: { path: "a.mock" }, isError: true })).toBeNull();
    expect(await editDiagnostics(current, { toolName: "read", input: { path: "a.mock" }, isError: false })).toBeNull();
    expect(await editDiagnostics(null, { toolName: "write", input: { path: "a.mock" }, isError: false })).toBeNull();
  });

  it("warms the file's servers so the next edit finds them running", async () => {
    write("a.mock", "x\n");
    const current = manager({ mock: mockServer() });
    current.warm("a.mock");
    for (let i = 0; i < 50 && current.running().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(current.running()).toHaveLength(1);
  });
});
