import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DiagnosticSeverity,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type Command,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type MarkedString,
  type Range,
  type SymbolInformation,
} from "./types.js";

const MAX_LOCATIONS = 100;
const MAX_SYMBOL_LINES = 300;
const MAX_DIAGNOSTICS = 100;
const MAX_CODE_ACTIONS = 30;
const MAX_WORKSPACE_SYMBOLS = 50;

const SYMBOL_KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum",
  "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key",
  "null", "enum-member", "struct", "event", "operator", "type-param",
];

const kindLabel = (kind: number): string => SYMBOL_KINDS[kind - 1] ?? `kind(${kind})`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const pos = (line: number, character: number): string => `${line + 1}:${character + 1}`;
const showing = (shown: number, total: number): string => (total > shown ? `\n\n(showing ${shown} of ${total})` : "");

// A missing severity is left to the client by the spec; treat it as an error so it is never hidden.
const severityOf = (d: Diagnostic): number => d.severity ?? DiagnosticSeverity.Error;

function severityLabel(severity: number): string {
  return ["ERROR", "WARN", "INFO", "HINT"][severity - 1] ?? "UNKNOWN";
}

function fmtRange(range: Range): string {
  const { start, end } = range;
  return start.line === end.line
    ? `line ${pos(start.line, start.character)}-${end.character + 1}`
    : `lines ${pos(start.line, start.character)}-${pos(end.line, end.character)}`;
}

export function relativePath(uri: string, root: string): string {
  // Two-plus letters so a Windows drive path is not mistaken for a scheme.
  const scheme = /^([a-zA-Z][\w+.-]+):/.exec(uri)?.[1];
  if (scheme && scheme.toLowerCase() !== "file") return uri;
  // A drive-letter root means a Windows workspace even when this process is not on Windows (and in tests).
  const windows = process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(root);
  const p = windows ? path.win32 : path.posix;
  let abs: string;
  try {
    abs = scheme ? fileURLToPath(uri, { windows }) : uri;
  } catch {
    return uri;
  }
  const rel = p.relative(p.resolve(root), p.resolve(abs));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return abs;
  return rel;
}

// ── Diagnostics ──

export function formatDiagnostics(filePath: string, groups: Array<{ source: string; diagnostics: Diagnostic[] }>): string {
  const all = groups.flatMap((g) => g.diagnostics);
  if (all.length === 0) return `${filePath}: No diagnostics — all clean ✓`;

  const errors = all.filter((d) => severityOf(d) === DiagnosticSeverity.Error).length;
  const warnings = all.filter((d) => severityOf(d) === DiagnosticSeverity.Warning).length;
  const other = all.length - errors - warnings;
  const summary: string[] = [];
  if (errors) summary.push(plural(errors, "error"));
  if (warnings) summary.push(plural(warnings, "warning"));
  if (other) summary.push(`${other} info/hint`);

  const lines = [`Diagnostics for ${filePath}: ${summary.join(", ")}`];
  let shown = 0;
  for (const group of groups) {
    if (group.diagnostics.length === 0 || shown >= MAX_DIAGNOSTICS) continue;
    lines.push("", `── ${group.source} ──`);
    for (const [i, d] of group.diagnostics.entries()) {
      if (shown >= MAX_DIAGNOSTICS) break;
      shown++;
      const src = d.source ? `[${d.source}]` : "";
      const code = d.code !== undefined && d.code !== "" ? `(${d.code})` : "";
      lines.push(`${i + 1}. ${severityLabel(severityOf(d))} ${fmtRange(d.range)} ${src}${code}`.trimEnd());
      lines.push(`   ${d.message}`);
      if (d.codeDescription?.href) lines.push(`   Docs: ${d.codeDescription.href}`);
    }
  }
  if (all.length > shown) lines.push("", `… ${all.length - shown} more`);
  return lines.join("\n");
}

export function formatEditDiagnostics(relPath: string, diagnostics: Diagnostic[], limit = 20): string | null {
  const seen = new Set<string>();
  const kept = diagnostics
    .filter((d) => severityOf(d) <= DiagnosticSeverity.Warning)
    .filter((d) => {
      const key = JSON.stringify([d.range, d.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => severityOf(a) - severityOf(b) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  if (kept.length === 0) return null;

  const lines = kept.slice(0, limit).map((d) => {
    const tag = [d.source, d.code].filter((part) => part !== undefined && part !== "").join(" ");
    const message = d.message.replace(/\s*\r?\n\s*/g, " ");
    return `${severityLabel(severityOf(d))} ${pos(d.range.start.line, d.range.start.character)}${tag ? ` [${tag}]` : ""} ${message}`;
  });
  if (kept.length > limit) lines.push(`… ${kept.length - limit} more`);
  return `<diagnostics file="${relPath}">\n${lines.join("\n")}\n</diagnostics>`;
}

// ── Hover ──

function markedString(s: MarkedString): string {
  return typeof s === "string" ? s : `\`\`\`${s.language}\n${s.value}\n\`\`\``;
}

export function formatHover(hover: Hover | null, filePath: string, line: number, character: number): string {
  const at = `${filePath}:${pos(line, character)}`;
  const contents = hover?.contents;
  let text = "";
  if (Array.isArray(contents)) text = contents.map(markedString).join("\n\n");
  else if (typeof contents === "string") text = contents;
  else if (contents && "kind" in contents) text = contents.value;
  else if (contents) text = markedString(contents);
  text = text.trim();
  return text ? `Hover at ${at}:\n\n${text}` : `No hover information at ${at}`;
}

// ── Locations ──

export function formatLocations(
  result: Location | Location[] | LocationLink[] | null,
  kind: string,
  filePath: string,
  line: number,
  character: number,
  root: string,
): string {
  const at = `${filePath}:${pos(line, character)}`;
  const raw: Array<Location | LocationLink> = result ? (Array.isArray(result) ? result : [result]) : [];
  const entries = raw.map((loc) => {
    const [uri, start] = "targetUri" in loc ? [loc.targetUri, loc.targetSelectionRange.start] : [loc.uri, loc.range.start];
    return { path: relativePath(uri, root), line: start.line, character: start.character };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.character - b.character));
  const unique = [...new Set(entries.map((e) => `${e.path}:${pos(e.line, e.character)}`))];
  if (unique.length === 0) return `No ${kind} found for symbol at ${at}`;

  const listed = unique.slice(0, MAX_LOCATIONS).map((l, i) => `${i + 1}. ${l}`);
  return `${kind} for symbol at ${at} (${plural(unique.length, "result")}):\n\n${listed.join("\n")}${showing(listed.length, unique.length)}`;
}

// ── Symbols ──

function symbolLocation(sym: SymbolInformation, root: string): string {
  const p = relativePath(sym.location.uri, root);
  return "range" in sym.location ? `${p}:${pos(sym.location.range.start.line, sym.location.range.start.character)}` : p;
}

function symbolInfoLine(sym: SymbolInformation, i: number, root: string): string {
  const container = sym.containerName ? ` in ${sym.containerName}` : "";
  return `${i + 1}. ${sym.name} (${kindLabel(sym.kind)}) ${symbolLocation(sym, root)}${container}`;
}

function symbolTree(symbols: DocumentSymbol[], depth: number, out: string[]): void {
  for (const sym of symbols) {
    const detail = sym.detail ? ` — ${sym.detail}` : "";
    const { line, character } = sym.selectionRange.start;
    out.push(`${"  ".repeat(depth)}${sym.name} (${kindLabel(sym.kind)}) line ${pos(line, character)}${detail}`);
    if (sym.children?.length) symbolTree(sym.children, depth + 1, out);
  }
}

export function formatDocumentSymbols(symbols: Array<DocumentSymbol | SymbolInformation> | null, filePath: string, root: string): string {
  if (!symbols?.length) return `No symbols found in ${filePath}`;
  if ("selectionRange" in symbols[0]) {
    const lines: string[] = [];
    symbolTree(symbols as DocumentSymbol[], 0, lines);
    const shown = lines.slice(0, MAX_SYMBOL_LINES);
    return `Symbols in ${filePath} (${symbols.length} top-level):\n\n${shown.join("\n")}${showing(shown.length, lines.length)}`;
  }
  const shown = (symbols as SymbolInformation[]).slice(0, MAX_SYMBOL_LINES).map((s, i) => symbolInfoLine(s, i, root));
  return `Symbols in ${filePath} (${symbols.length}):\n\n${shown.join("\n")}${showing(shown.length, symbols.length)}`;
}

export function formatWorkspaceSymbols(symbols: SymbolInformation[], query: string, root: string): string {
  if (symbols.length === 0) return `No workspace symbols matching "${query}"`;
  const shown = symbols.slice(0, MAX_WORKSPACE_SYMBOLS).map((s, i) => symbolInfoLine(s, i, root));
  return `Workspace symbols matching "${query}" (${symbols.length}):\n\n${shown.join("\n")}${showing(shown.length, symbols.length)}`;
}

// ── Call hierarchy ──

function callItem(item: CallHierarchyItem, root: string): string {
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `${item.name} (${kindLabel(item.kind)}) ${relativePath(item.uri, root)}:${item.selectionRange.start.line + 1}${detail}`;
}

function callList(items: CallHierarchyItem[], root: string): string {
  const shown = items.slice(0, MAX_LOCATIONS).map((item, i) => `${i + 1}. ${callItem(item, root)}`);
  return `${shown.join("\n")}${showing(shown.length, items.length)}`;
}

export function formatCallHierarchy(items: CallHierarchyItem[] | null, filePath: string, line: number, character: number, root: string): string {
  const at = `${filePath}:${pos(line, character)}`;
  if (!items?.length) return `No call hierarchy item at ${at}`;
  return `Call hierarchy at ${at}:\n\n${callList(items, root)}`;
}

export function formatIncomingCalls(calls: CallHierarchyIncomingCall[] | null, target: CallHierarchyItem, root: string): string {
  if (!calls?.length) return `No incoming calls to ${target.name}`;
  return `Incoming calls to ${target.name} (${calls.length}):\n\n${callList(calls.map((c) => c.from), root)}`;
}

export function formatOutgoingCalls(calls: CallHierarchyOutgoingCall[] | null, source: CallHierarchyItem, root: string): string {
  if (!calls?.length) return `No outgoing calls from ${source.name}`;
  return `Outgoing calls from ${source.name} (${calls.length}):\n\n${callList(calls.map((c) => c.to), root)}`;
}

// ── Code actions ──

function codeAction(action: CodeAction | Command, i: number): string {
  // A bare Command carries its id as a string in `command`; a CodeAction nests a Command object there.
  const command = typeof action.command === "string" ? (action as Command) : action.command;
  const { kind, isPreferred, edit } = action as CodeAction;
  const lines = [`${i + 1}. ${action.title}${kind ? ` [${kind}]` : ""}${isPreferred ? " ★ preferred" : ""}`];

  const files = new Set(Object.keys(edit?.changes ?? {}));
  let edits = Object.values(edit?.changes ?? {}).reduce((n, list) => n + list.length, 0);
  for (const change of edit?.documentChanges ?? []) {
    if (change.textDocument) files.add(change.textDocument.uri);
    edits += change.edits?.length ?? 0;
  }
  if (edits > 0) lines.push(`   Changes: ${plural(edits, "edit")} across ${plural(files.size, "file")}`);
  else if (command) lines.push(`   command: ${command.title}`);
  return lines.join("\n");
}

export function formatCodeActions(actions: Array<CodeAction | Command> | null, filePath: string, line: number): string {
  const at = `${filePath}:${line + 1}`;
  if (!actions?.length) return `No code actions available at ${at}`;
  const shown = actions.slice(0, MAX_CODE_ACTIONS).map(codeAction);
  return `Code actions at ${at} (${actions.length} available):\n\n${shown.join("\n\n")}${showing(shown.length, actions.length)}`;
}
