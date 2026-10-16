import { resolve } from "node:path";
import { DEFAULT_TIMEOUTS, LspClient, type ClientTimeouts } from "./client.js";
import { findRoot, resolveServers, serversForFile, which, type ServerConfig, type ServerDef } from "./servers.js";
import type { Diagnostic } from "./types.js";

export interface ServerLayers {
  global?: Record<string, ServerConfig>;
  project?: Record<string, ServerConfig>;
  trusted: boolean;
}

export interface ServerReport {
  name: string;
  command: string;
  resolvedPath: string | null;
  extensions: string[];
  running: boolean;
  probe: "ok" | "failed" | "skipped";
  error?: string;
  stderr: string[];
}

export interface LspDescription {
  rootPath: string;
  servers: ServerReport[];
  missing: Array<{ name: string; command: string[]; extensions: string[] }>;
  errors: string[];
  untrusted: string[];
}

interface Backoff {
  failures: number;
  retryAt: number;
  error: string;
  stderr: string[];
}

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Owns the root session's language servers: one process per server and
 * project root, started on first use, restarted after a crash no sooner than
 * its backoff allows, and all stopped with the session.
 */
export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly backoff = new Map<string, Backoff>();
  private readonly paths = new Map<string, string>();
  private resolved: ReturnType<typeof resolveServers> | undefined;
  private closed = false;

  constructor(
    readonly cwd: string,
    private readonly layers: () => ServerLayers,
    private readonly timeouts: ClientTimeouts = DEFAULT_TIMEOUTS,
    private readonly now: () => number = Date.now,
  ) {}

  private config(): ReturnType<typeof resolveServers> {
    if (!this.resolved) {
      const { global, project, trusted } = this.layers();
      this.resolved = resolveServers(global, project, trusted);
    }
    return this.resolved;
  }

  servers(): ServerDef[] {
    return this.config().servers;
  }

  /** The executable a server runs, looked up again while it is missing so a server installed mid-session is found. */
  commandPath(def: ServerDef): string | null {
    const cached = this.paths.get(def.name);
    if (cached) return cached;
    const found = which(def.command[0]!, { ...process.env, ...def.env });
    if (found) this.paths.set(def.name, found);
    return found;
  }

  absolute(filePath: string): string {
    return resolve(this.cwd, filePath.replace(/^@/, ""));
  }

  /** Servers configured for the file whose command is installed. */
  available(filePath: string): ServerDef[] {
    return serversForFile(this.servers(), filePath).filter((def) => this.commandPath(def));
  }

  running(): LspClient[] {
    return [...this.clients.values()].filter((client) => client.state === "running");
  }

  /** The started client for a server and the file's project root. */
  async client(def: ServerDef, filePath: string): Promise<LspClient> {
    return this.clientAt(def, findRoot(this.absolute(filePath), this.cwd, def.rootMarkers));
  }

  /** The started client for a server rooted at the workspace itself, for questions about no file in particular. */
  async workspaceClient(def: ServerDef): Promise<LspClient> {
    const running = this.running().find((client) => client.def.name === def.name && client.root === resolve(this.cwd));
    return running ?? this.clientAt(def, resolve(this.cwd));
  }

  /** The client for a server and root, if one is already running; never starts anything. */
  runningClient(def: ServerDef, filePath: string): LspClient | undefined {
    const client = this.clients.get(clientKey(def, findRoot(this.absolute(filePath), this.cwd, def.rootMarkers)));
    return client?.state === "running" ? client : undefined;
  }

  private async clientAt(def: ServerDef, root: string): Promise<LspClient> {
    if (this.closed) throw new Error("language servers are shut down for this session");
    const key = clientKey(def, root);
    const existing = this.clients.get(key);
    if (existing && (existing.state === "running" || existing.state === "starting")) {
      await existing.start();
      return existing;
    }
    const wait = this.backoff.get(key);
    if (wait && wait.retryAt > this.now()) {
      throw new Error(`${def.name} language server failed ${wait.failures} time(s); next attempt in ${Math.ceil((wait.retryAt - this.now()) / 1000)}s. Last error: ${wait.error}`);
    }
    const command = this.commandPath(def);
    if (!command) throw new Error(`${def.name} language server is not installed: ${def.command[0]} is not on PATH`);
    const client = new LspClient(def, root, command, this.timeouts, (exited) => this.onExit(key, exited));
    this.clients.set(key, client);
    try {
      await client.start();
      return client;
    } catch (error) {
      // A server that died during startup was already counted when it exited.
      if (this.clients.get(key) === client) this.recordFailure(key, client);
      throw error;
    }
  }

  private onExit(key: string, client: LspClient): void {
    if (this.clients.get(key) !== client || client.state !== "failed") return;
    this.recordFailure(key, client);
  }

  private recordFailure(key: string, client: LspClient): void {
    const previous = this.backoff.get(key);
    // A server that ran for a while before dying is not failing to start.
    const failures = previous && this.now() - client.startedAt < BACKOFF_MAX_MS ? previous.failures + 1 : 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    this.backoff.set(key, { failures, retryAt: this.now() + delay, error: client.lastError ?? "unknown error", stderr: client.stderr() });
    if (this.clients.get(key) === client) this.clients.delete(key);
  }

  /** Starts every available server for the file in the background, for an edit that will want diagnostics next time. */
  warm(filePath: string): void {
    for (const def of this.available(filePath)) void this.client(def, filePath).catch(() => {});
  }

  /** Diagnostics for a just-edited file from servers that are already running, within the budget; never starts one. */
  async diagnosticsAfterEdit(filePath: string, budgetMs: number, signal?: AbortSignal): Promise<Diagnostic[] | null> {
    const absolute = this.absolute(filePath);
    const clients = this.available(absolute).map((def) => this.runningClient(def, absolute)).filter((client): client is LspClient => !!client);
    if (clients.length === 0) return null;
    const results = await Promise.all(clients.map((client) => client.diagnostics(absolute, budgetMs, signal).catch(() => null)));
    const reported = results.filter((result) => result?.reported);
    return reported.length ? reported.flatMap((result) => result!.items) : null;
  }

  async restart(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.backoff.clear();
    this.paths.clear();
    this.resolved = undefined;
    await Promise.all(clients.map((client) => client.shutdown().catch(() => {})));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.restart();
  }

  /** For the doctor: what is configured, what resolves, and — when probing — what actually starts. */
  async describe(probe: boolean): Promise<LspDescription> {
    const { servers, errors, untrusted } = this.config();
    const reports: ServerReport[] = [];
    const missing: LspDescription["missing"] = [];
    for (const def of servers) {
      const resolvedPath = this.commandPath(def);
      if (!resolvedPath) {
        missing.push({ name: def.name, command: def.command, extensions: def.extensions });
        continue;
      }
      const client = [...this.clients.values()].find((entry) => entry.def.name === def.name && entry.state === "running");
      const base = { name: def.name, command: def.command.join(" "), resolvedPath, extensions: def.extensions, running: !!client, stderr: client?.stderr() ?? [] };
      if (client || !probe) {
        reports.push({ ...base, probe: client ? "ok" : "skipped" });
        continue;
      }
      try {
        const started = await this.clientAt(def, this.cwd);
        reports.push({ ...base, running: true, probe: "ok", stderr: started.stderr() });
      } catch (error: any) {
        reports.push({ ...base, probe: "failed", error: error?.message ?? String(error), stderr: this.backoff.get(clientKey(def, this.cwd))?.stderr ?? [] });
      }
    }
    return { rootPath: this.cwd, servers: reports, missing, errors, untrusted };
  }
}

function clientKey(def: ServerDef, root: string): string {
  return `${def.name}\0${root}`;
}
