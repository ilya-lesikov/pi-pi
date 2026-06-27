import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getLogger } from "./log.js";

function findCbmBin(): string | null {
  try {
    return execFileSync("which", ["codebase-memory-mcp"], { encoding: "utf-8", stdio: "pipe" }).trim() || null;
  } catch {
    return null;
  }
}

const CBM_BIN_KEY = Symbol.for("pi-pi:cbm-bin");

function getCbmBin(): string | null {
  if ((globalThis as any)[CBM_BIN_KEY] !== undefined) return (globalThis as any)[CBM_BIN_KEY];
  const bin = findCbmBin();
  (globalThis as any)[CBM_BIN_KEY] = bin;
  return bin;
}

function isCbmAvailable(): boolean {
  return getCbmBin() !== null;
}

const CBM_DAEMON_KEY = Symbol.for("pi-pi:cbm-daemon");

function getGlobalDaemon(): CbmDaemon | null {
  return (globalThis as any)[CBM_DAEMON_KEY] ?? null;
}

function setGlobalDaemon(daemon: CbmDaemon): void {
  (globalThis as any)[CBM_DAEMON_KEY] = daemon;
}

export class CbmDaemon {
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private indexedProjects = new Set<string>();

  start(): void {
    if (this.proc) return;

    this.proc = spawn(getCbmBin()!, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.unref();
    (this.proc.stdout as any)?.unref?.();
    (this.proc.stdin as any)?.unref?.();
    (this.proc.stderr as any)?.unref?.();

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) getLogger().error({ s: "cbm", stderr: text }, "CBM daemon stderr");
    });

    this.proc.on("exit", () => this.cleanup());
    this.proc.on("error", (err) => {
      getLogger().error({ s: "cbm", err: err.message }, "CBM daemon error");
      this.cleanup();
    });

    this.initPromise = this.initialize();
  }

  cleanup(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CBM daemon exited"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.initialized = false;
    this.initPromise = null;
    this.indexedProjects.clear();
  }

  stop(): void {
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.cleanup();
  }

  private async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-pi", version: "1.0" },
    });
    this.initialized = true;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      }
    } catch {
      // ignore unparseable lines (e.g. log output on stderr)
    }
  }

  private rpc(method: string, params: Record<string, unknown>, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        return reject(new Error("CBM daemon not running"));
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CBM call timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private async ensureReady(): Promise<void> {
    if (!this.proc) this.start();
    if (this.initPromise) await this.initPromise;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    await this.ensureReady();
    const result = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (result?.isError) {
      throw new Error(result.content?.[0]?.text ?? "unknown CBM error");
    }
    const text = result?.content?.[0]?.text;
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  hasIndexed(cwd: string): boolean {
    return this.indexedProjects.has(projectName(cwd));
  }

  async ensureIndexed(cwd: string): Promise<string> {
    const name = projectName(cwd);
    if (this.indexedProjects.has(name)) return name;

    try {
      const projects = (await this.callTool("list_projects", {})) as { projects: Array<{ name: string }> };
      if (projects.projects.some((p) => p.name === name)) {
        this.indexedProjects.add(name);
        return name;
      }
    } catch { /* fall through to index */ }

    await this.callTool("index_repository", { repo_path: cwd }, 300000);
    this.indexedProjects.add(name);
    return name;
  }
}

function projectName(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "-");
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

export function registerCbmTools(pi: ExtensionAPI, cwd: string): boolean {
  if (!isCbmAvailable()) return false;

  let daemon = getGlobalDaemon();
  if (!daemon) {
    daemon = new CbmDaemon();
    daemon.start();
    setGlobalDaemon(daemon);
  }

  pi.registerTool({
    name: "cbm_search",
    label: "CBM",
    description:
      "Search the codebase knowledge graph. Use `query` for natural-language BM25 search, " +
      "`name_pattern` for regex on symbol names, or `semantic_query` (array of keywords) for " +
      "vector similarity. Returns symbols with name, file_path, label, in_degree, out_degree.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural-language BM25 search (e.g. 'deploy release chart')" })),
      name_pattern: Type.Optional(Type.String({ description: "Regex pattern on symbol names" })),
      semantic_query: Type.Optional(Type.Array(Type.String(), { description: "Array of keywords for vector similarity search" })),
      label: Type.Optional(Type.String({ description: "Filter by node type: Function, Method, Interface, Class, Type, Route" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to search. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        const p: Record<string, unknown> = { project, limit: params.limit ?? 20 };
        if (params.query) p.query = params.query;
        if (params.name_pattern) p.name_pattern = params.name_pattern;
        if (params.semantic_query) p.semantic_query = params.semantic_query;
        if (params.label) p.label = params.label;
        return ok(JSON.stringify(await daemon.callTool("search_graph", p), null, 2));
      } catch (e: any) {
        return fail(`cbm_search error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_search_code",
    label: "CBM",
    description:
      "Graph-augmented grep: searches code text then deduplicates matches into containing " +
      "functions with structural metadata (in_degree, out_degree, label). Better than raw grep " +
      "for understanding which functions contain a pattern.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text pattern to search for" }),
      file_pattern: Type.Optional(Type.String({ description: "Glob filter (e.g. '*.go', '*.ts')" })),
      path_filter: Type.Optional(Type.String({ description: "Regex filter on file paths (e.g. '^pkg/')" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to search. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        const p: Record<string, unknown> = { project, pattern: params.pattern, limit: params.limit ?? 20 };
        if (params.file_pattern) p.file_pattern = params.file_pattern;
        if (params.path_filter) p.path_filter = params.path_filter;
        return ok(JSON.stringify(await daemon.callTool("search_code", p), null, 2));
      } catch (e: any) {
        return fail(`cbm_search_code error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_trace",
    label: "CBM",
    description:
      "Trace call chains through the code graph. Find who calls a function (inbound) or " +
      "what a function calls (outbound). Useful for understanding dependencies and impact.",
    parameters: Type.Object({
      function_name: Type.String({ description: "Function name to trace" }),
      direction: Type.Optional(Type.String({ description: "inbound, outbound, or both (default: both)" })),
      depth: Type.Optional(Type.Number({ description: "Max traversal depth (default: 3)" })),
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to search. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        const p: Record<string, unknown> = {
          project,
          function_name: params.function_name,
          direction: params.direction ?? "both",
          depth: params.depth ?? 3,
        };
        return ok(JSON.stringify(await daemon.callTool("trace_path", p), null, 2));
      } catch (e: any) {
        return fail(`cbm_trace error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_changes",
    label: "CBM",
    description:
      "Detect code changes from git diff and map to affected symbols with blast radius. " +
      "Shows which functions/types are impacted by uncommitted or branch changes.",
    parameters: Type.Object({
      base_branch: Type.Optional(Type.String({ description: "Compare against this branch (default: main)" })),
      since: Type.Optional(Type.String({ description: "Git ref or date (e.g. HEAD~5, v0.5.0)" })),
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to search. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        const p: Record<string, unknown> = { project };
        if (params.base_branch) p.base_branch = params.base_branch;
        if (params.since) p.since = params.since;
        return ok(JSON.stringify(await daemon.callTool("detect_changes", p), null, 2));
      } catch (e: any) {
        return fail(`cbm_changes error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_query",
    label: "CBM",
    description:
      "Execute a Cypher-like graph query for complex multi-hop patterns. " +
      "Example: MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name = 'main' RETURN g.name, g.file_path LIMIT 10",
    parameters: Type.Object({
      query: Type.String({ description: "Cypher query string" }),
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to search. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        return ok(JSON.stringify(await daemon.callTool("query_graph", { project, query: params.query }), null, 2));
      } catch (e: any) {
        return fail(`cbm_query error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_architecture",
    label: "CBM",
    description: "Get high-level architecture overview of the indexed codebase — node/edge counts, schema, structure.",
    parameters: Type.Object({
      project_path: Type.Optional(Type.String({ description: "Absolute path to the repo to inspect. Defaults to root project." })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const targetCwd = params.project_path ?? cwd;
        const project = await daemon.ensureIndexed(targetCwd);
        return ok(JSON.stringify(await daemon.callTool("get_architecture", { project }), null, 2));
      } catch (e: any) {
        return fail(`cbm_architecture error: ${e.message}`);
      }
    },
  });

  return true;
}
