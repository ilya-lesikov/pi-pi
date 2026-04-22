import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

async function callExa(toolName: string, args: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  });

  const raw = await res.text();

  // SSE format: find the "data:" line with the JSON payload
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = JSON.parse(line.slice(5).trim());
    if (json.error) throw new Error(json.error.message);
    const text = json.result?.content?.[0]?.text;
    if (text) return text;
  }

  // Fallback: try parsing as plain JSON
  const json = JSON.parse(raw);
  if (json.error) throw new Error(json.error.message);
  return json.result?.content?.[0]?.text ?? raw;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

export function registerExaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "exa_search",
    label: "Exa",
    description:
      "Search the web for any topic. Returns clean text from top results. " +
      "Query tip: describe the ideal page, not keywords. " +
      "'blog post comparing React and Vue performance' not 'React vs Vue'. " +
      "Use category:people for LinkedIn, category:company for company pages.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (default: 5, max: 100)" })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const result = await callExa("web_search_exa", {
          query: params.query,
          numResults: params.numResults ?? 5,
        });
        return ok(result);
      } catch (e: any) {
        return fail(`exa_search error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "exa_fetch",
    label: "Exa",
    description:
      "Read a webpage's full content as clean markdown. " +
      "Use after exa_search when highlights are insufficient, or to read any URL. " +
      "Batch multiple URLs in one call.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to read" }),
      maxCharacters: Type.Optional(Type.Number({ description: "Max characters per page (default: 3000)" })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        const result = await callExa("web_fetch_exa", {
          urls: params.urls,
          maxCharacters: params.maxCharacters ?? 3000,
        });
        return ok(result);
      } catch (e: any) {
        return fail(`exa_fetch error: ${e.message}`);
      }
    },
  });
}
