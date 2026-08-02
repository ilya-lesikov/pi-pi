import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const JINA_READER_URL = "https://r.jina.ai/";

export const PROBE_COOLDOWN_MS = 10 * 60 * 1000;

const EXA_RATE_LIMIT_MARKER = "hit Exa's free MCP rate limit";

type Provider = "exa" | "tavily" | "jina";

let limitedAt: Partial<Record<Provider, number>> = {};

export function __resetWebToolStateForTest(): void {
  limitedAt = {};
}

export function isExaRateLimited(text: string): boolean {
  return text.includes(EXA_RATE_LIMIT_MARKER);
}

function markLimited(provider: Provider, now: number): void {
  limitedAt[provider] = now;
}

function shouldTry(provider: Provider, now: number): boolean {
  const at = limitedAt[provider];
  if (at == null) return true;
  return now - at >= PROBE_COOLDOWN_MS;
}

function exaHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  // Keyed Exa (EXA_API_KEY) has a much higher ceiling than the keyless free MCP
  // endpoint; prefer it when present.
  const key = process.env.EXA_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export async function callExa(toolName: string, args: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: exaHeaders(),
    body,
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 429) throw new RateLimitError(`Exa HTTP 429`);
  const raw = await res.text();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let json: any;
    try {
      json = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    const text = json.result?.content?.[0]?.text;
    if (text) return text;
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${raw.slice(0, 200)}`);
    return raw;
  }
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  const text = json.result?.content?.[0]?.text;
  if (text != null) return text;
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${raw.slice(0, 200)}`);
  return raw;
}

class RateLimitError extends Error {}

function tavilyAuthHeaders(): Record<string, string> {
  const key = process.env.TAVILY_API_KEY;
  if (key) return { Authorization: `Bearer ${key}` };
  return { "X-Tavily-Access-Mode": "keyless" };
}

async function tavilyPost(url: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...tavilyAuthHeaders(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const raw = await res.text();
  if (res.status === 429 || res.status === 432 || res.status === 433) {
    throw new RateLimitError(`Tavily HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${raw.slice(0, 200)}`);

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Tavily returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

export function normalizeTavilySearch(json: any): string {
  const parts: string[] = [];
  if (typeof json?.answer === "string" && json.answer.trim()) {
    parts.push(`Answer: ${json.answer.trim()}`);
  }
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  for (const r of results) {
    const seg: string[] = [];
    if (r?.title) seg.push(`Title: ${r.title}`);
    if (r?.url) seg.push(`URL: ${r.url}`);
    const content = r?.raw_content ?? r?.content;
    if (content) seg.push(content);
    if (seg.length) parts.push(seg.join("\n"));
  }
  if (!parts.length) return "No results found.";
  return parts.join("\n\n---\n\n");
}

export function normalizeTavilyExtract(json: any): string {
  const parts: string[] = [];
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  for (const r of results) {
    const content = r?.raw_content ?? r?.content ?? "";
    parts.push(`URL: ${r?.url ?? "(unknown)"}\n\n${content}`);
  }
  const failed: any[] = Array.isArray(json?.failed_results) ? json.failed_results : [];
  for (const f of failed) {
    parts.push(`URL: ${f?.url ?? "(unknown)"}\n\nFailed to extract: ${f?.error ?? "unknown error"}`);
  }
  if (!parts.length) return "No content extracted.";
  return parts.join("\n\n---\n\n");
}

export async function callTavilySearch(query: string, maxResults: number): Promise<string> {
  const json = await tavilyPost(TAVILY_SEARCH_URL, { query, max_results: maxResults });
  return normalizeTavilySearch(json);
}

export async function callTavilyExtract(urls: string[]): Promise<string> {
  const json = await tavilyPost(TAVILY_EXTRACT_URL, { urls });
  return normalizeTavilyExtract(json);
}

export async function callJina(urls: string[]): Promise<string> {
  const parts: string[] = [];
  for (const url of urls) {
    const res = await fetch(`${JINA_READER_URL}${url}`, {
      method: "GET",
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    if (res.status === 429) throw new RateLimitError(`Jina HTTP 429`);
    if (!res.ok) {
      parts.push(`URL: ${url}\n\nFailed to fetch: Jina HTTP ${res.status}`);
      continue;
    }
    parts.push(`URL: ${url}\n\n${raw}`);
  }
  return parts.join("\n\n---\n\n");
}

const UNAVAILABLE = "web tools temporarily unavailable";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

async function runSearch(query: string, numResults: number): Promise<string> {
  const now = Date.now();

  if (shouldTry("exa", now)) {
    try {
      const result = await callExa("web_search_exa", { query, numResults });
      if (!isExaRateLimited(result)) return result;
      markLimited("exa", now);
    } catch (e) {
      // Only a rate limit marks Exa limited (sticky 10-min lockout). Any other
      // failure (network blip, 5xx, malformed SSE) just falls through to the
      // next tier WITHOUT the sticky penalty.
      if (e instanceof RateLimitError) markLimited("exa", now);
    }
  }

  if (shouldTry("tavily", now)) {
    try {
      return await callTavilySearch(query, numResults);
    } catch (e) {
      // Rate limit -> sticky; any other Tavily error just falls through to the
      // terminal unavailable result rather than aborting the chain.
      if (e instanceof RateLimitError) markLimited("tavily", now);
    }
  }

  throw new Error(UNAVAILABLE);
}

async function runFetch(urls: string[], maxCharacters: number): Promise<string> {
  const now = Date.now();

  if (shouldTry("exa", now)) {
    try {
      const result = await callExa("web_fetch_exa", { urls, maxCharacters });
      if (!isExaRateLimited(result)) return result;
      markLimited("exa", now);
    } catch (e) {
      // Only a rate limit marks Exa limited; other errors fall through.
      if (e instanceof RateLimitError) markLimited("exa", now);
    }
  }

  if (shouldTry("tavily", now)) {
    try {
      return await callTavilyExtract(urls);
    } catch (e) {
      // Rate limit -> sticky; any other Tavily error falls through to Jina
      // rather than aborting the Exa->Tavily->Jina chain.
      if (e instanceof RateLimitError) markLimited("tavily", now);
    }
  }

  if (shouldTry("jina", now)) {
    try {
      return await callJina(urls);
    } catch (e) {
      if (e instanceof RateLimitError) markLimited("jina", now);
    }
  }

  throw new Error(UNAVAILABLE);
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
        return ok(await runSearch(params.query, params.numResults ?? 5));
      } catch (e: any) {
        if (e?.message === UNAVAILABLE) return fail(UNAVAILABLE);
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
        return ok(await runFetch(params.urls, params.maxCharacters ?? 3000));
      } catch (e: any) {
        if (e?.message === UNAVAILABLE) return fail(UNAVAILABLE);
        return fail(`exa_fetch error: ${e.message}`);
      }
    },
  });
}
