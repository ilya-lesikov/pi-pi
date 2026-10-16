import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LspClient } from "./client.js";
import { formatCallHierarchy, formatCodeActions, formatDiagnostics, formatDocumentSymbols, formatEditDiagnostics, formatHover, formatIncomingCalls, formatLocations, formatOutgoingCalls, formatWorkspaceSymbols } from "./format.js";
import type { LspManager } from "./manager.js";
import { serversForFile, type ServerDef } from "./servers.js";
import { LSP_OPERATIONS, type CallHierarchyItem, type Diagnostic, type LspOperation, type SymbolInformation } from "./types.js";

interface LspParams {
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
}

const POSITION_OPERATIONS = new Set<LspOperation>(["hover", "goToDefinition", "findReferences", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls", "codeActions"]);
// Answers that depend on the whole project wait for the server to finish indexing it.
const PROJECT_WIDE = new Set<LspOperation>(["findReferences", "goToImplementation", "incomingCalls", "outgoingCalls", "workspaceSymbol"]);
const CAPABILITIES: Record<LspOperation, string> = {
  diagnostics: "",
  hover: "hoverProvider",
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  goToImplementation: "implementationProvider",
  documentSymbol: "documentSymbolProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  prepareCallHierarchy: "callHierarchyProvider",
  incomingCalls: "callHierarchyProvider",
  outgoingCalls: "callHierarchyProvider",
  codeActions: "codeActionProvider",
};

const DIAGNOSTICS_WAIT_MS = 10_000;
const CODE_ACTION_DIAGNOSTICS_WAIT_MS = 3_000;
/** What an edit may wait for its diagnostics; only servers already running are asked. */
export const EDIT_DIAGNOSTICS_BUDGET_MS = 1_500;

const DESCRIPTION = [
  "Interact with Language Server Protocol servers for code intelligence.",
  "",
  "Supported operations:",
  "  goToDefinition    — find where a symbol is defined",
  "  findReferences    — find all references to a symbol",
  "  hover             — get type info and documentation for a symbol",
  "  diagnostics       — get type errors and lint warnings for a file",
  "  documentSymbol    — get all symbols in a file (with line:column positions)",
  "  workspaceSymbol   — search for symbols across the workspace",
  "  goToImplementation — find implementations of an interface/abstract method",
  "  prepareCallHierarchy — get call hierarchy item at a position",
  "  incomingCalls     — find callers of a function/method (auto-prepares hierarchy)",
  "  outgoingCalls     — find callees of a function/method (auto-prepares hierarchy)",
  "  codeActions       — get quick fixes and refactoring suggestions",
  "",
  "Parameters:",
  "  operation (required) — one of the operations above",
  "  filePath  — file path relative to project root (required for most operations)",
  "  line      — line number, 1-indexed (required for position-based operations)",
  "  character — column number, 1-indexed (required for position-based operations)",
  "  query     — search string (required for workspaceSymbol)",
  "",
  "Tips:",
  "  — Position the character in the middle of the symbol name for best results.",
  "  — Use hover before goToDefinition to quickly check signatures and docs.",
].join("\n");

const PROMPT_GUIDELINES = [
  "lsp line and character params are 1-indexed — use the values from the read tool or rg output directly.",
  "lsp `hover` is the fastest way to get a function signature, type params, and doc comment — prefer it over `goToDefinition` for quick type inspection.",
  "lsp `documentSymbol` returns line:column positions for each symbol — use those values directly for follow-up lsp operations.",
  "For lsp position-based operations, place the character in the **middle** of the symbol name, not at the first character.",
  "lsp `incomingCalls` and `outgoingCalls` automatically prepare the call hierarchy — no need to call `prepareCallHierarchy` first.",
  "lsp `workspaceSymbol` searches the project the server for `filePath` serves; pass a file to pick the language.",
  "Use lsp for type info, macro-generated symbols, and cross-module navigation. Use rg for simple text search and file discovery — it is faster and needs no server.",
];

const PARAMETERS = Type.Object({
  operation: Type.Unsafe<LspOperation>({ type: "string", enum: [...LSP_OPERATIONS], description: "The LSP operation to run" }),
  filePath: Type.Optional(Type.String({ description: "File path relative to project root" })),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed)" })),
  query: Type.Optional(Type.String({ description: "Search query (for workspaceSymbol)" })),
});

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function displayPath(manager: LspManager, absolute: string): string {
  const rel = relative(manager.cwd, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

/** Why no server can answer for this file, in terms the model can act on. */
function noServer(manager: LspManager, absolute: string, operation: LspOperation, tried: string[]): string {
  const ext = extname(absolute) || "(no extension)";
  const configured = serversForFile(manager.servers(), absolute);
  if (configured.length === 0) return `No language server is configured for ${ext} files.`;
  const missing = configured.filter((def) => !manager.commandPath(def));
  if (missing.length === configured.length) {
    return `No language server for ${ext} is installed: ${missing.map((def) => `${def.name} needs ${def.command[0]} on PATH`).join("; ")}.`;
  }
  return `No running language server for ${ext} supports ${operation}${tried.length ? ` (tried ${tried.join(", ")})` : ""}.`;
}

async function capableClient(manager: LspManager, absolute: string, operation: LspOperation, signal?: AbortSignal): Promise<LspClient> {
  const errors: string[] = [];
  const tried: string[] = [];
  for (const def of manager.available(absolute)) {
    if (signal?.aborted) break;
    try {
      const client = await manager.client(def, absolute);
      tried.push(def.name);
      if (client.hasCapability(CAPABILITIES[operation])) return client;
    } catch (error: any) {
      errors.push(error?.message ?? String(error));
    }
  }
  throw new Error([noServer(manager, absolute, operation, tried), ...errors].join("\n"));
}

function requireFile(manager: LspManager, params: LspParams): string {
  if (!params.filePath) throw new Error(`Operation '${params.operation}' requires filePath`);
  const absolute = manager.absolute(params.filePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`File not found: ${params.filePath}`);
  return absolute;
}

function position(params: LspParams): { line: number; character: number } {
  if (params.line === undefined) throw new Error(`Operation '${params.operation}' requires line`);
  if (params.character === undefined) throw new Error(`Operation '${params.operation}' requires character`);
  return { line: Math.max(0, Math.floor(params.line) - 1), character: Math.max(0, Math.floor(params.character) - 1) };
}

async function prepare(client: LspClient, operation: LspOperation, signal?: AbortSignal, syncedUri?: string): Promise<string> {
  client.refreshOpenDocuments(syncedUri);
  if (!PROJECT_WIDE.has(operation)) return "";
  return await client.waitForIndexing(signal) ? `\n\n(${client.def.name} is still indexing the project; results may be incomplete.)` : "";
}

async function diagnostics(manager: LspManager, absolute: string, signal?: AbortSignal): Promise<string> {
  const shown = displayPath(manager, absolute);
  const groups: Array<{ source: string; diagnostics: Diagnostic[] }> = [];
  const notes: string[] = [];
  const defs = manager.available(absolute);
  if (defs.length === 0) throw new Error(noServer(manager, absolute, "diagnostics", []));
  await Promise.all(defs.map(async (def) => {
    try {
      const client = await manager.client(def, absolute);
      const result = await client.diagnostics(absolute, DIAGNOSTICS_WAIT_MS, signal);
      if (!result.reported) notes.push(`${def.name} did not report on the current content within ${DIAGNOSTICS_WAIT_MS / 1000}s; these may be out of date`);
      groups.push({ source: def.name, diagnostics: result.items });
    } catch (error: any) {
      notes.push(error?.message ?? String(error));
    }
  }));
  if (groups.length === 0) throw new Error(notes.join("\n"));
  return formatDiagnostics(shown, groups) + (notes.length ? `\n\nNote: ${notes.join("; ")}` : "");
}

/** Without a file, the servers whose project markers sit in the workspace come first: they know the most of it. */
function workspaceServers(manager: LspManager): ServerDef[] {
  const running = new Set(manager.running().map((client) => client.def.name));
  const installed = manager.servers().filter((def) => manager.commandPath(def));
  const rooted = (def: ServerDef) => def.rootMarkers.some((marker) => !marker.startsWith("*") && existsSync(`${manager.cwd}/${marker}`));
  return [...installed.filter((def) => running.has(def.name)), ...installed.filter((def) => !running.has(def.name) && rooted(def))];
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__"]);

/** A source file the server handles, breadth-first under its root and bounded, or undefined. */
function sampleFile(root: string, extensions: string[]): string | undefined {
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < 2_000) {
    const dir = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) return join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) queue.push(join(dir, entry.name));
    }
  }
  return undefined;
}

async function workspaceSymbol(manager: LspManager, params: LspParams, signal?: AbortSignal): Promise<string> {
  if (!params.query) throw new Error("Operation 'workspaceSymbol' requires query");
  let client: LspClient;
  if (params.filePath) {
    client = await capableClient(manager, requireFile(manager, params), "workspaceSymbol", signal);
  } else {
    const candidates = workspaceServers(manager);
    if (candidates.length === 0) throw new Error("No language server is running or detected for this workspace. Pass filePath to pick the language.");
    const errors: string[] = [];
    let found: LspClient | undefined;
    for (const def of candidates) {
      try {
        const candidate = await manager.workspaceClient(def);
        if (candidate.hasCapability("workspaceSymbolProvider")) {
          found = candidate;
          break;
        }
      } catch (error: any) {
        errors.push(error?.message ?? String(error));
      }
    }
    if (!found) throw new Error(["No language server here supports workspaceSymbol.", ...errors].join("\n"));
    client = found;
  }
  // Some servers (tsserver among them) know no project until a file of it is open.
  if (client.openDocuments === 0) {
    const sample = sampleFile(client.root, client.def.extensions);
    if (sample) client.sync(sample);
  }
  const note = await prepare(client, "workspaceSymbol", signal);
  const symbols = await client.request<SymbolInformation[] | null>("workspace/symbol", { query: params.query }, signal);
  return formatWorkspaceSymbols(symbols ?? [], params.query, manager.cwd) + note;
}

async function run(manager: LspManager, params: LspParams, signal?: AbortSignal): Promise<string> {
  const { operation } = params;
  if (!LSP_OPERATIONS.includes(operation)) throw new Error(`Unknown operation: ${operation}`);
  if (operation === "workspaceSymbol") return workspaceSymbol(manager, params, signal);
  const absolute = requireFile(manager, params);
  if (operation === "diagnostics") return diagnostics(manager, absolute, signal);
  const pos = POSITION_OPERATIONS.has(operation) ? position(params) : { line: 0, character: 0 };
  const client = await capableClient(manager, absolute, operation, signal);
  const uri = client.sync(absolute);
  const note = await prepare(client, operation, signal, uri);
  const shown = displayPath(manager, absolute);
  const root = manager.cwd;
  const at = { textDocument: { uri }, position: pos };
  switch (operation) {
    case "hover":
      return formatHover(await client.request("textDocument/hover", at, signal), shown, pos.line, pos.character);
    case "goToDefinition":
      return formatLocations(await client.request("textDocument/definition", at, signal), "Definition", shown, pos.line, pos.character, root);
    case "goToImplementation":
      return formatLocations(await client.request("textDocument/implementation", at, signal), "Implementation", shown, pos.line, pos.character, root) + note;
    case "findReferences":
      return formatLocations(await client.request("textDocument/references", { ...at, context: { includeDeclaration: true } }, signal), "References", shown, pos.line, pos.character, root) + note;
    case "documentSymbol":
      return formatDocumentSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }, signal), shown, root);
    case "prepareCallHierarchy":
      return formatCallHierarchy(await client.request("textDocument/prepareCallHierarchy", at, signal), shown, pos.line, pos.character, root);
    case "incomingCalls":
    case "outgoingCalls": {
      const items = await client.request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", at, signal);
      const item = items?.[0];
      if (!item) return `No call hierarchy item at ${shown}:${pos.line + 1}:${pos.character + 1}`;
      return operation === "incomingCalls"
        ? formatIncomingCalls(await client.request("callHierarchy/incomingCalls", { item }, signal), item, root) + note
        : formatOutgoingCalls(await client.request("callHierarchy/outgoingCalls", { item }, signal), item, root) + note;
    }
    case "codeActions": {
      const known = await client.diagnostics(absolute, CODE_ACTION_DIAGNOSTICS_WAIT_MS, signal).catch(() => ({ items: client.knownDiagnostics(absolute) }));
      const onLine = known.items.filter((d) => d.range.start.line <= pos.line && d.range.end.line >= pos.line);
      const range = { start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } };
      return formatCodeActions(await client.request("textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics: onLine } }, signal), shown, pos.line);
    }
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

/** Registers the `lsp` tool on a session; worker sessions get the root session's manager through the same getter. */
export function registerLspTool(pi: ExtensionAPI, manager: () => LspManager | null): void {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: DESCRIPTION,
    promptSnippet: "Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: PARAMETERS,
    async execute(_id, params, signal) {
      const current = manager();
      if (!current) throw new Error("Language servers are not available in this session.");
      return ok(await run(current, params as LspParams, signal));
    },
  });
}

function editedPath(event: any): string | undefined {
  const input = event?.input ?? {};
  const path = input.file_path ?? input.filePath ?? input.path;
  return typeof path === "string" && path ? path : undefined;
}

/** Starts a file's language servers in the background when it is read or edited, so the edit after finds them running. */
export function registerLspWarmup(pi: ExtensionAPI, manager: () => LspManager | null, enabled: () => boolean): void {
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return;
    const path = editedPath(event);
    const current = manager();
    if (path && current && enabled()) current.warm(path);
  });
}

/**
 * What a successful edit or write broke, as the language servers already
 * running for the file see it. Never starts a server or waits past the budget:
 * a cold server's verdict is not worth stalling every edit for.
 */
export async function editDiagnostics(manager: LspManager | null, event: any, signal?: AbortSignal): Promise<string | null> {
  if ((event?.toolName !== "edit" && event?.toolName !== "write") || event.isError || !manager) return null;
  const path = editedPath(event);
  if (!path) return null;
  const items = await manager.diagnosticsAfterEdit(path, EDIT_DIAGNOSTICS_BUDGET_MS, signal).catch(() => null);
  return items ? formatEditDiagnostics(displayPath(manager, manager.absolute(path)), items) : null;
}
