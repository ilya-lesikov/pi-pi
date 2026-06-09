/**
 * High-level LSP client.
 *
 * Manages the initialize handshake, document lifecycle, diagnostic collection,
 * and typed request helpers for all supported LSP operations.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LspConnection } from './protocol';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CodeActionContext,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  PublishDiagnosticsParams,
  Range,
  ResolvedServerConfig,
  SymbolInformation,
} from './types';
import { withRetry } from './retry';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a file URI for consistent map-key comparison.
 *
 * Some LSP servers (e.g. typescript-language-server on Windows) return URIs with
 * percent-encoded colons (`%3A`) and lowercase drive letters.  We decode and
 * uppercase so that `file:///d%3A/…` and `file:///D:/…` resolve to the same key.
 */
function normalizeUri(uri: string): string {
  let normalized = decodeURIComponent(uri);
  // Uppercase Windows drive letter: file:///d:/… → file:///D:/…
  normalized = normalized.replace(
    /^file:\/\/\/([a-z]):/,
    (_, letter: string) => `file:///${letter.toUpperCase()}:`,
  );
  return normalized;
}

function pathToUri(filePath: string): string {
  const abs = resolve(filePath);
  const normalized = abs.replace(/\\/g, '/');
  // Windows paths need file:///C:/... (three slashes), always uppercase drive letter
  if (/^[A-Za-z]:/.test(normalized)) {
    return `file:///${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }
  return `file://${normalized}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const decoded = decodeURIComponent(uri);
  const path = decoded.slice(7);
  // Remove leading slash before Windows drive letter: /C:/... → C:/...
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1);
  return path;
}

function languageIdForFile(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.vue': 'vue',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.zig': 'zig',
    '.zon': 'zig',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.java': 'java',
    '.rb': 'ruby',
    '.lua': 'lua',
    '.css': 'css',
    '.html': 'html',
    '.json': 'json',
    '.md': 'markdown',
  };
  return map[ext] ?? 'plaintext';
}

// ── Types ───────────────────────────────────────────────────────────────────

interface OpenDocument {
  uri: string;
  version: number;
  languageId: string;
}

/**
 * A single pending diagnostic request per URI.
 *
 * Instead of maintaining an array of waiters with individual timers, we keep one
 * pending promise per URI.  Non-empty `publishDiagnostics` notifications resolve
 * it immediately; empty ones are stored but do NOT resolve the pending — this
 * avoids the "empty-then-real" race where the server clears stale diagnostics
 * before sending real results.  A timeout passed via `Promise.race` in
 * `waitForDiagnostics` acts as a safety net for genuinely clean files.
 */
interface PendingDiagnostic {
  resolve: () => void;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class LspClient {
  private connection: LspConnection;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private openDocs = new Map<string, OpenDocument>();
  private diagnosticStore = new Map<string, Diagnostic[]>();
  private pendingDiagnostics = new Map<string, PendingDiagnostic>();
  /** URIs where we just sent didChange and haven't yet received non-empty diagnostics. */
  private invalidatedUris = new Set<string>();
  private serverCapabilities: Record<string, unknown> = {};
  private stderrLog: string[] = [];
  private initTimestamp = 0;

  readonly config: ResolvedServerConfig;
  private rootPath: string;

  constructor(config: ResolvedServerConfig, rootPath: string) {
    this.config = config;
    this.rootPath = rootPath;
    this.connection = this.createConnection();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  private createConnection(): LspConnection {
    const conn = new LspConnection(this.config.command, this.config.args, {
      cwd: this.rootPath,
      env: this.config.env,
    });

    conn.setNotificationHandler((method, params) => {
      if (method === 'textDocument/publishDiagnostics') {
        const { uri, diagnostics } = params as PublishDiagnosticsParams;
        const normalized = normalizeUri(uri);
        this.diagnosticStore.set(normalized, diagnostics);

        // Decide whether to resolve the pending promise:
        // • Non-empty diagnostics always resolve (real errors found).
        // • Empty diagnostics resolve ONLY when the URI was NOT recently
        //   invalidated by a didChange — this avoids the "empty-then-real"
        //   race where servers clear stale diagnostics before sending real ones.
        const shouldResolve = diagnostics.length > 0 || !this.invalidatedUris.has(normalized);

        if (diagnostics.length > 0) {
          this.invalidatedUris.delete(normalized);
        }

        if (shouldResolve) {
          const pending = this.pendingDiagnostics.get(normalized);
          if (pending) {
            pending.resolve();
            this.pendingDiagnostics.delete(normalized);
          }
        }
      }
    });

    conn.setServerRequestHandler((id, _method, _params) => {
      conn.sendResponse(id, null);
    });

    conn.setStderrHandler((text) => {
      this.stderrLog.push(text);
      if (this.stderrLog.length > 100) this.stderrLog.shift();
    });

    conn.setExitHandler((_code) => {
      this.initialized = false;
      this.initializePromise = null;
    });

    return conn;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.doInitialize();
    return this.initializePromise;
  }

  private async doInitialize(): Promise<void> {
    if (!this.connection.alive) {
      this.connection.spawn();
    }

    const rootUri = pathToUri(this.rootPath);

    const result = (await this.connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.rootPath,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            codeDescriptionSupport: true,
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          implementation: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
            },
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          callHierarchy: {},
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          symbol: {},
        },
      },
      workspaceFolders: [{ uri: rootUri, name: this.rootPath.split('/').pop() || 'workspace' }],
      initializationOptions: this.config.initializationOptions,
    })) as { capabilities?: Record<string, unknown> } | null;

    this.serverCapabilities = result?.capabilities ?? {};
    this.connection.sendNotification('initialized', {});
    this.initialized = true;
    this.initTimestamp = Date.now();
  }

  /** Whether the server was initialized recently (within windowMs). */
  private isRecentlyInitialized(windowMs = 30_000): boolean {
    return this.initTimestamp > 0 && Date.now() - this.initTimestamp < windowMs;
  }

  /**
   * Wrap an LSP operation with retry logic when the server was recently initialized.
   * During indexing, servers may return empty results that resolve after a short wait.
   */
  private async retryIfIndexing<T>(
    operation: () => Promise<T>,
    isEmpty: (result: T) => boolean,
  ): Promise<T> {
    if (!this.isRecentlyInitialized()) return operation();
    return withRetry(operation, isEmpty, { maxRetries: 2, delayMs: 2000 });
  }

  async shutdown(): Promise<void> {
    if (!this.connection.alive) return;

    try {
      if (this.initialized) {
        await this.connection.sendRequest('shutdown', null, 5_000);
        this.connection.sendNotification('exit', null);
      }
    } catch {
      // Best-effort
    }

    this.connection.dispose();
    this.initialized = false;
    this.initializePromise = null;
    this.openDocs.clear();
    this.diagnosticStore.clear();
    this.invalidatedUris.clear();
    this.clearAllPending();
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Check if the server advertised a specific capability. */
  hasCapability(name: string): boolean {
    return this.serverCapabilities[name] !== undefined && this.serverCapabilities[name] !== false;
  }

  // ── Document management ───────────────────────────────────────────────

  async openDocument(filePath: string): Promise<string> {
    await this.ensureInitialized();

    const uri = pathToUri(resolve(this.rootPath, filePath));
    const existing = this.openDocs.get(uri);

    const absolutePath = resolve(this.rootPath, filePath);
    const text = await readFile(absolutePath, 'utf8');
    const languageId = languageIdForFile(filePath);

    if (existing) {
      existing.version++;
      this.diagnosticStore.delete(uri); // Clear stale diagnostics before re-sync
      this.invalidatedUris.add(uri); // Mark as invalidated until real diagnostics arrive
      this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
    } else {
      const version = 1;
      this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text },
      });
      this.openDocs.set(uri, { uri, version, languageId });
    }

    // Notify the server that the file was saved — some servers (e.g. rust-analyzer)
    // only generate diagnostics after a didSave notification.
    this.connection.sendNotification('textDocument/didSave', {
      textDocument: { uri },
      text,
    });

    return uri;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  async getDiagnostics(filePath: string, timeoutMs = 10_000): Promise<Diagnostic[]> {
    const uri = await this.openDocument(filePath);
    await this.waitForDiagnostics(uri, timeoutMs);
    return this.diagnosticStore.get(uri) ?? [];
  }

  /**
   * Wait until non-empty diagnostics arrive for `uri`, or until `timeoutMs` elapses.
   *
   * If non-empty diagnostics are already in the store (e.g. from a previous
   * notification), resolves immediately.  Otherwise sets up a single pending
   * promise that the notification handler will resolve when real diagnostics
   * arrive.  `Promise.race` against a timeout ensures we don't wait forever
   * for genuinely clean files.
   */
  private async waitForDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    // Fast path: diagnostics already present and meaningful.
    // • Non-empty → file has errors, return immediately.
    // • Empty + not invalidated → genuinely clean file (e.g. first open), return.
    const existing = this.diagnosticStore.get(uri);
    if (existing !== undefined) {
      if (existing.length > 0 || !this.invalidatedUris.has(uri)) return;
    }

    // Resolve any previous pending for this URI so it doesn't leak.
    const prev = this.pendingDiagnostics.get(uri);
    if (prev) prev.resolve();

    const { promise, resolve } = Promise.withResolvers<void>();
    this.pendingDiagnostics.set(uri, { resolve });

    // Safety-net timeout: resolves the race for files with zero errors.
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });

    await Promise.race([promise, timeout]);

    clearTimeout(timer!);
    this.pendingDiagnostics.delete(uri);
  }

  private clearAllPending(): void {
    for (const pending of this.pendingDiagnostics.values()) {
      pending.resolve();
    }
    this.pendingDiagnostics.clear();
  }

  // ── Hover ─────────────────────────────────────────────────────────────

  async hover(filePath: string, position: Position): Promise<Hover | null> {
    const uri = await this.openDocument(filePath);
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('textDocument/hover', {
          textDocument: { uri },
          position,
        });
        return (result as Hover) ?? null;
      },
      (result) => result === null,
    );
  }

  // ── Definition ────────────────────────────────────────────────────────

  async definition(filePath: string, position: Position): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('textDocument/definition', {
          textDocument: { uri },
          position,
        });
        return normalizeLocations(result);
      },
      (result) => result.length === 0,
    );
  }

  // ── References ────────────────────────────────────────────────────────

  async references(filePath: string, position: Position): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('textDocument/references', {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        });
        return normalizeLocations(result);
      },
      (result) => result.length === 0,
    );
  }

  // ── Implementation ────────────────────────────────────────────────────

  async implementation(filePath: string, position: Position): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('textDocument/implementation', {
          textDocument: { uri },
          position,
        });
        return normalizeLocations(result);
      },
      (result) => result.length === 0,
    );
  }

  // ── Document Symbols ──────────────────────────────────────────────────

  async documentSymbol(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const uri = await this.openDocument(filePath);
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('textDocument/documentSymbol', {
          textDocument: { uri },
        });
        if (!Array.isArray(result)) return [];
        return result as DocumentSymbol[] | SymbolInformation[];
      },
      (result) => result.length === 0,
    );
  }

  // ── Workspace Symbols ─────────────────────────────────────────────────

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    await this.ensureInitialized();
    return this.retryIfIndexing(
      async () => {
        const result = await this.connection.sendRequest('workspace/symbol', { query });
        if (!Array.isArray(result)) return [];
        return result as SymbolInformation[];
      },
      (result) => result.length === 0,
    );
  }

  // ── Call Hierarchy ────────────────────────────────────────────────────

  async prepareCallHierarchy(filePath: string, position: Position): Promise<CallHierarchyItem[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position,
    });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyItem[];
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const result = await this.connection.sendRequest('callHierarchy/incomingCalls', { item });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyIncomingCall[];
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const result = await this.connection.sendRequest('callHierarchy/outgoingCalls', { item });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyOutgoingCall[];
  }

  // ── Code Actions ──────────────────────────────────────────────────────

  async codeActions(
    filePath: string,
    range: Range,
    context: CodeActionContext,
  ): Promise<CodeAction[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context,
    });
    if (!Array.isArray(result)) return [];
    return result as CodeAction[];
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as Location[];
  if (typeof result === 'object' && 'uri' in (result as Record<string, unknown>)) {
    return [result as Location];
  }
  return [];
}
