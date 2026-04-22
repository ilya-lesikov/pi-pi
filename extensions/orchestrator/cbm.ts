import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CBM_BIN = join(process.env.HOME ?? "", ".local", "bin", "codebase-memory-mcp");

function isCbmAvailable(): boolean {
  return existsSync(CBM_BIN);
}

function callCbm(tool: string, params: Record<string, unknown>, timeoutMs = 60000): unknown {
  const raw = execFileSync(CBM_BIN, ["cli", tool, JSON.stringify(params)], {
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const envelope = JSON.parse(raw);
  if (envelope.isError) {
    const text = envelope.content?.[0]?.text ?? "unknown error";
    throw new Error(text);
  }
  return JSON.parse(envelope.content[0].text);
}

function projectName(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "-");
}

function ensureIndexed(cwd: string): string {
  const name = projectName(cwd);
  try {
    const projects = callCbm("list_projects", {}) as { projects: Array<{ name: string }> };
    if (projects.projects.some((p) => p.name === name)) return name;
  } catch { /* fall through to index */ }

  callCbm("index_repository", { repo_path: cwd }, 300000);
  return name;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

export function registerCbmTools(pi: ExtensionAPI, cwd: string): boolean {
  if (!isCbmAvailable()) return false;

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
    }),
    async execute(_toolCallId, params: any) {
      try {
        const project = ensureIndexed(cwd);
        const p: Record<string, unknown> = { project, limit: params.limit ?? 20 };
        if (params.query) p.query = params.query;
        if (params.name_pattern) p.name_pattern = params.name_pattern;
        if (params.semantic_query) p.semantic_query = params.semantic_query;
        if (params.label) p.label = params.label;
        return ok(JSON.stringify(callCbm("search_graph", p), null, 2));
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
    }),
    async execute(_toolCallId, params: any) {
      try {
        const project = ensureIndexed(cwd);
        const p: Record<string, unknown> = { project, pattern: params.pattern, limit: params.limit ?? 20 };
        if (params.file_pattern) p.file_pattern = params.file_pattern;
        if (params.path_filter) p.path_filter = params.path_filter;
        return ok(JSON.stringify(callCbm("search_code", p), null, 2));
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
    }),
    async execute(_toolCallId, params: any) {
      try {
        const project = ensureIndexed(cwd);
        const p: Record<string, unknown> = {
          project,
          function_name: params.function_name,
          direction: params.direction ?? "both",
          depth: params.depth ?? 3,
        };
        return ok(JSON.stringify(callCbm("trace_path", p), null, 2));
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
    }),
    async execute(_toolCallId, params: any) {
      try {
        const project = ensureIndexed(cwd);
        const p: Record<string, unknown> = { project };
        if (params.base_branch) p.base_branch = params.base_branch;
        if (params.since) p.since = params.since;
        return ok(JSON.stringify(callCbm("detect_changes", p), null, 2));
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
    }),
    async execute(_toolCallId, params: any) {
      try {
        const project = ensureIndexed(cwd);
        return ok(JSON.stringify(callCbm("query_graph", { project, query: params.query }), null, 2));
      } catch (e: any) {
        return fail(`cbm_query error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "cbm_architecture",
    label: "CBM",
    description: "Get high-level architecture overview of the indexed codebase — node/edge counts, schema, structure.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const project = ensureIndexed(cwd);
        return ok(JSON.stringify(callCbm("get_architecture", { project }), null, 2));
      } catch (e: any) {
        return fail(`cbm_architecture error: ${e.message}`);
      }
    },
  });

  return true;
}
