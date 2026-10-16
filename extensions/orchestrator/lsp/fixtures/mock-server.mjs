// A scriptable language server for the lsp tests. Behaviour is chosen through
// MOCK_LSP_* environment variables; every message it receives is appended to
// MOCK_LSP_LOG as one JSON line, so a test can see what the client sent.
import { appendFileSync } from "node:fs";

const env = process.env;
const mode = new Set((env.MOCK_LSP_MODE ?? "").split(",").filter(Boolean));
const log = (entry) => { if (env.MOCK_LSP_LOG) appendFileSync(env.MOCK_LSP_LOG, JSON.stringify(entry) + "\n"); };

if (mode.has("crash-on-start")) {
  process.stderr.write("mock: refusing to start\n");
  process.exit(3);
}

let buffer = Buffer.alloc(0);
let nextId = 1000;
const pending = new Map();
const documents = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function diagnosticsFor(text) {
  const items = [];
  text.split("\n").forEach((line, index) => {
    const at = line.indexOf("ERROR");
    if (at >= 0) items.push({ range: { start: { line: index, character: at }, end: { line: index, character: at + 5 } }, severity: 1, source: "mock", message: `bad thing on line ${index + 1}` });
    const warn = line.indexOf("WARN");
    if (warn >= 0) items.push({ range: { start: { line: index, character: warn }, end: { line: index, character: warn + 4 } }, severity: 2, source: "mock", message: "suspicious" });
    const hint = line.indexOf("HINT");
    if (hint >= 0) items.push({ range: { start: { line: index, character: hint }, end: { line: index, character: hint + 4 } }, severity: 4, source: "mock", message: "a hint" });
  });
  return items;
}

function publish(uri) {
  const doc = documents.get(uri);
  if (!doc) return;
  const diagnostics = diagnosticsFor(doc.text);
  if (mode.has("push-stale-first")) {
    // The clearing empty publication some servers send before the real one.
    send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
    setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } }), 100);
    return;
  }
  const delay = Number(env.MOCK_LSP_PUBLISH_DELAY ?? 0);
  const message = { method: "textDocument/publishDiagnostics", params: { uri, version: mode.has("versioned") ? doc.version : undefined, diagnostics } };
  if (delay) setTimeout(() => send(message), delay);
  else send(message);
}

async function handle(message) {
  log(message);
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      if (mode.has("ask-configuration")) {
        const answer = await request("workspace/configuration", { items: [{ section: "mock" }, { section: "mock.nested" }, { section: "absent" }] });
        log({ configurationAnswer: answer });
      }
      if (mode.has("progress")) {
        await request("window/workDoneProgress/create", { token: "index" });
        send({ method: "$/progress", params: { token: "index", value: { kind: "begin", title: "indexing" } } });
        setTimeout(() => send({ method: "$/progress", params: { token: "index", value: { kind: "end" } } }), Number(env.MOCK_LSP_INDEX_MS ?? 500));
      }
      if (mode.has("unknown-request")) {
        const answer = await request("custom/somethingElse", {});
        log({ unknownAnswer: answer });
      }
      const capabilities = {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: !mode.has("no-workspace-symbol"),
        codeActionProvider: true,
        callHierarchyProvider: true,
      };
      if (mode.has("pull")) capabilities.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false };
      send({ id, result: { capabilities } });
      return;
    }
    case "initialized":
      return;
    case "shutdown":
      if (mode.has("ignore-shutdown")) return;
      send({ id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    case "textDocument/didOpen":
      documents.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version });
      if (!mode.has("pull") && !mode.has("silent")) publish(params.textDocument.uri);
      return;
    case "textDocument/didChange":
      documents.set(params.textDocument.uri, { text: params.contentChanges[0].text, version: params.textDocument.version });
      if (mode.has("crash-on-change")) process.exit(7);
      if (!mode.has("pull") && !mode.has("silent")) publish(params.textDocument.uri);
      return;
    case "textDocument/didSave":
    case "textDocument/didClose":
    case "workspace/didChangeConfiguration":
    case "$/cancelRequest":
      return;
    case "textDocument/diagnostic": {
      const doc = documents.get(params.textDocument.uri);
      send({ id, result: { kind: "full", resultId: String(doc?.version ?? 0), items: diagnosticsFor(doc?.text ?? "") } });
      return;
    }
    case "textDocument/hover":
      if (mode.has("hang-hover")) return;
      if (mode.has("error-stack")) {
        send({ id, error: { code: -32603, message: "No Project.\nError: No Project.\n    at one\n    at two\n    at three" } });
        return;
      }
      send({ id, result: { contents: { kind: "markdown", value: `hover ${params.position.line}:${params.position.character}` } } });
      return;
    case "textDocument/definition":
      send({ id, result: [{ targetUri: params.textDocument.uri, targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, targetSelectionRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }] });
      return;
    case "textDocument/references":
      send({ id, result: mode.has("progress-empty") ? [] : [{ uri: params.textDocument.uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } } }] });
      return;
    case "textDocument/documentSymbol":
      send({ id, result: [{ name: "main", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } }] });
      return;
    case "workspace/symbol":
      send({ id, result: [{ name: `sym_${params.query}`, kind: 12, location: { uri: `file://${env.MOCK_LSP_ROOT ?? "/"}/a.mock`.replace("//a.mock", "/a.mock"), range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } } }] });
      return;
    case "textDocument/prepareCallHierarchy":
      send({ id, result: [{ name: "main", kind: 12, uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }, selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } }] });
      return;
    case "callHierarchy/incomingCalls":
      send({ id, result: [{ from: { ...params.item, name: "caller" }, fromRanges: [] }] });
      return;
    case "callHierarchy/outgoingCalls":
      send({ id, result: [{ to: { ...params.item, name: "callee" }, fromRanges: [] }] });
      return;
    case "textDocument/codeAction":
      send({ id, result: [{ title: `fix (${params.context.diagnostics.length} diagnostics)`, kind: "quickfix", isPreferred: true }] });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `mock: no ${method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
    buffer = buffer.subarray(headerEnd + 4 + length);
    void handle(JSON.parse(body));
  }
});
