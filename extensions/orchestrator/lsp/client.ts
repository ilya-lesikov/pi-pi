import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection, methodNotFound } from "./connection.js";
import { languageIdFor, type ServerDef } from "./servers.js";
import type { Diagnostic } from "./types.js";

export interface ClientTimeouts {
  request: number;
  initialize: number;
  /** How long a workspace-wide request waits for the server to finish indexing. */
  indexing: number;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = { request: 30_000, initialize: 60_000, indexing: 20_000 };

// Pushed diagnostics arrive in bursts (a clearing empty set, then the real one),
// so a publication counts once nothing newer has followed it for this long.
const DIAGNOSTICS_SETTLE_MS = 300;
const MAX_OPEN_DOCUMENTS = 64;

export type ClientState = "starting" | "running" | "stopped" | "failed";

interface OpenDocument {
  version: number;
  text: string;
  mtimeMs: number;
  /** When the server was last sent new content for it. */
  changedAt: number;
}

interface Published {
  items: Diagnostic[];
  version?: number;
  at: number;
}

export interface DiagnosticsResult {
  items: Diagnostic[];
  /** False when the server reported nothing for the file within the wait. */
  reported: boolean;
}

/** URIs name the same file in more than one spelling (percent-encoding, drive-letter case). */
export function normalizeUri(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try {
    const path = fileURLToPath(uri);
    const href = pathToFileURL(path).href;
    return process.platform === "win32" ? href.toLowerCase() : href;
  } catch {
    return uri;
  }
}

export function fileUri(path: string): string {
  return pathToFileURL(path).href;
}

function settingsAt(settings: Record<string, unknown> | undefined, section: string | undefined): unknown {
  if (!settings) return null;
  if (!section) return settings;
  let value: unknown = settings;
  for (const key of section.split(".")) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}

/** One language server process serving one workspace root. */
export class LspClient {
  state: ClientState = "starting";
  lastError: string | undefined;
  startedAt = 0;
  private connection: Connection | undefined;
  private capabilities: Record<string, any> = {};
  private ready: Promise<void> | undefined;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly published = new Map<string, Published>();
  private readonly pulled = new Map<string, { resultId?: string; items: Diagnostic[] }>();
  private readonly listeners = new Set<() => void>();
  private readonly progress = new Set<string | number>();
  private sawProgress = false;

  constructor(
    readonly def: ServerDef,
    readonly root: string,
    private readonly command: string,
    private readonly timeouts: ClientTimeouts = DEFAULT_TIMEOUTS,
    private readonly onExit: (client: LspClient) => void = () => {},
  ) {}

  get pid(): number | undefined {
    return this.connection?.pid;
  }

  stderr(): string[] {
    return this.connection?.stderr() ?? [];
  }

  hasCapability(name: string): boolean {
    return !!this.capabilities[name];
  }

  /** Spawns and initializes the server once; later calls share the same start. */
  start(): Promise<void> {
    this.ready ??= this.initialize().catch((error) => {
      this.state = "failed";
      this.lastError = error?.message ?? String(error);
      const stderr = this.stderr();
      this.connection?.kill("SIGKILL");
      throw new Error(`${this.def.name} language server failed to start: ${this.lastError}${stderr.length ? `\n${stderr.slice(-5).join("\n")}` : ""}`);
    });
    return this.ready;
  }

  private async initialize(): Promise<void> {
    this.startedAt = Date.now();
    const connection = new Connection({
      command: this.command,
      args: this.def.command.slice(1),
      cwd: this.root,
      env: this.def.env,
      onRequest: (method, params) => this.onServerRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onExit: (code) => {
        if (this.state === "running" || this.state === "starting") {
          this.state = "failed";
          this.lastError = `exited unexpectedly${code !== null ? ` with code ${code}` : ""}`;
        }
        this.notifyListeners();
        this.onExit(this);
      },
    });
    this.connection = connection;
    const rootUri = fileUri(this.root);
    const result = await connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "pi-pi" },
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
      initializationOptions: this.def.initializationOptions,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: false },
          symbol: { dynamicRegistration: false },
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true, codeDescriptionSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
            isPreferredSupport: true,
          },
        },
      },
    }, this.timeouts.initialize);
    this.capabilities = result?.capabilities ?? {};
    connection.notify("initialized", {});
    if (this.def.settings) connection.notify("workspace/didChangeConfiguration", { settings: this.def.settings });
    this.state = "running";
  }

  private onServerRequest(method: string, params: any): unknown {
    switch (method) {
      // An unanswered configuration request leaves several servers waiting
      // forever; the answer must be one entry per item asked for.
      case "workspace/configuration":
        return (params?.items ?? []).map((item: any) => settingsAt(this.def.settings, item?.section));
      case "workspace/workspaceFolders":
        return [{ uri: fileUri(this.root), name: basename(this.root) }];
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
        return null;
      case "workspace/applyEdit":
        return { applied: false, failureReason: "pi-pi does not apply server edits" };
      case "window/showDocument":
        return { success: false };
      default:
        throw methodNotFound(method);
    }
  }

  private onNotification(method: string, params: any): void {
    if (method === "textDocument/publishDiagnostics" && typeof params?.uri === "string") {
      this.published.set(normalizeUri(params.uri), {
        items: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        version: typeof params.version === "number" ? params.version : undefined,
        at: Date.now(),
      });
      this.notifyListeners();
      return;
    }
    if (method === "$/progress" && params?.token !== undefined) {
      const kind = params.value?.kind;
      if (kind === "begin") {
        this.sawProgress = true;
        this.progress.add(params.token);
      } else if (kind === "end") {
        this.progress.delete(params.token);
      }
      this.notifyListeners();
    }
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Resolves when `ready()` holds, the client dies, or `timeoutMs` passes; returns whether it holds. */
  private until(ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", finish);
        resolvePromise(ready());
      };
      const check = () => { if (ready() || this.state !== "running") finish(); };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.listeners.add(check);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Whether the server is still indexing after waiting up to the indexing timeout. */
  async waitForIndexing(signal?: AbortSignal): Promise<boolean> {
    // A server announces indexing only after it has initialized; give a fresh
    // one a moment to start reporting before taking silence for idleness.
    if (!this.sawProgress && Date.now() - this.startedAt < 3_000) {
      await this.until(() => this.sawProgress, 3_000 - (Date.now() - this.startedAt), signal);
    }
    return !await this.until(() => this.progress.size === 0, this.timeouts.indexing, signal);
  }

  /**
   * Gives the server the file's current content: opened on first use, a full
   * replacement when it changed on disk, and saved where the server wants it.
   * Returns the document's URI.
   */
  sync(filePath: string): string {
    const connection = this.requireConnection();
    const path = resolve(filePath);
    const uri = fileUri(path);
    const key = normalizeUri(uri);
    const stat = statSync(path);
    const open = this.documents.get(key);
    if (open && open.mtimeMs === stat.mtimeMs) {
      this.documents.delete(key);
      this.documents.set(key, open);
      return uri;
    }
    const text = readFileSync(path, "utf8");
    if (!open) {
      connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageIdFor(path), version: 1, text } });
      this.documents.set(key, { version: 1, text, mtimeMs: stat.mtimeMs, changedAt: Date.now() });
      this.closeOldest();
      return uri;
    }
    open.mtimeMs = stat.mtimeMs;
    if (open.text === text) return uri;
    open.version++;
    open.text = text;
    open.changedAt = Date.now();
    this.documents.delete(key);
    this.documents.set(key, open);
    this.pulled.delete(key);
    connection.notify("textDocument/didChange", { textDocument: { uri, version: open.version }, contentChanges: [{ text }] });
    const sync = this.capabilities.textDocumentSync;
    if (sync && typeof sync === "object" && sync.save) {
      connection.notify("textDocument/didSave", { textDocument: { uri }, ...(sync.save.includeText ? { text } : {}) });
    }
    return uri;
  }

  get openDocuments(): number {
    return this.documents.size;
  }

  /** Re-sends every open document that changed on disk since it was last sent. */
  refreshOpenDocuments(): void {
    for (const key of [...this.documents.keys()]) {
      try {
        this.sync(fileURLToPath(key));
      } catch {
        this.closeDocument(key);
      }
    }
  }

  private closeDocument(key: string): void {
    if (!this.documents.delete(key)) return;
    this.connection?.notify("textDocument/didClose", { textDocument: { uri: key } });
  }

  private closeOldest(): void {
    while (this.documents.size > MAX_OPEN_DOCUMENTS) {
      const oldest = this.documents.keys().next().value as string;
      this.closeDocument(oldest);
    }
  }

  /**
   * The file's diagnostics after its current content was sent: pulled where
   * the server supports it, otherwise the push that follows the change, once
   * the burst has settled.
   */
  async diagnostics(filePath: string, waitMs: number, signal?: AbortSignal): Promise<DiagnosticsResult> {
    const uri = this.sync(filePath);
    const key = normalizeUri(uri);
    if (this.capabilities.diagnosticProvider) {
      const previous = this.pulled.get(key);
      const report = await this.request("textDocument/diagnostic", { textDocument: { uri }, previousResultId: previous?.resultId }, signal, Math.max(waitMs, 1_000));
      const items: Diagnostic[] = report?.kind === "unchanged" ? previous?.items ?? [] : Array.isArray(report?.items) ? report.items : [];
      this.pulled.set(key, { resultId: report?.resultId, items });
      return { items, reported: true };
    }
    const document = this.documents.get(key)!;
    const fresh = () => {
      const published = this.published.get(key);
      if (!published) return false;
      return published.version !== undefined ? published.version >= document.version : published.at >= document.changedAt;
    };
    const deadline = Date.now() + waitMs;
    if (!await this.until(fresh, waitMs, signal)) return { items: this.published.get(key)?.items ?? [], reported: this.published.has(key) };
    for (;;) {
      const seen = this.published.get(key)!.at;
      const quiet = Math.min(DIAGNOSTICS_SETTLE_MS - (Date.now() - seen), deadline - Date.now());
      if (quiet <= 0) break;
      await this.until(() => this.published.get(key)!.at !== seen, quiet, signal);
      if (this.published.get(key)!.at === seen || signal?.aborted) break;
    }
    return { items: this.published.get(key)!.items, reported: true };
  }

  /** The diagnostics already known for a file, without waiting. */
  knownDiagnostics(filePath: string): Diagnostic[] {
    const key = normalizeUri(fileUri(resolve(filePath)));
    return this.pulled.get(key)?.items ?? this.published.get(key)?.items ?? [];
  }

  request<T = any>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = this.timeouts.request): Promise<T> {
    return this.requireConnection().request<T>(method, params, timeoutMs, signal);
  }

  private requireConnection(): Connection {
    if (this.state !== "running" || !this.connection?.alive) throw new Error(`${this.def.name} language server is not running${this.lastError ? ` (${this.lastError})` : ""}`);
    return this.connection;
  }

  /** Asks the server to shut down, then makes sure it is gone. */
  async shutdown(): Promise<void> {
    const connection = this.connection;
    const wasRunning = this.state === "running";
    this.state = "stopped";
    this.notifyListeners();
    if (!connection?.alive) return;
    if (wasRunning) {
      try {
        await connection.request("shutdown", null, 2_000);
        connection.notify("exit", null);
      } catch {}
      await connection.waitForExit(1_000);
    }
    if (connection.alive) {
      connection.kill("SIGTERM");
      await connection.waitForExit(1_000);
    }
    if (connection.alive) connection.kill("SIGKILL");
  }
}
