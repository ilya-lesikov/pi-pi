import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getLogger } from "./log.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const JINA_READER_URL = "https://r.jina.ai/";

/** Ceiling for the per-provider lockout, reached only after repeated limits. */
export const PROBE_COOLDOWN_MS = 10 * 60 * 1000;

/** First lockout after a single rate limit; doubles per consecutive limit. */
export const INITIAL_COOLDOWN_MS = 30 * 1000;

const EXA_RATE_LIMIT_MARKER = "hit Exa's free MCP rate limit";

type Provider = "exa" | "tavily" | "jina";

interface ProviderState {
  limitedAt?: number;
  strikes: number;
  probing: boolean;
  inflight: number;
  waiters: Array<() => void>;
}

let states: Partial<Record<Provider, ProviderState>> = {};

function stateOf(provider: Provider): ProviderState {
  let state = states[provider];
  if (!state) {
    state = { strikes: 0, probing: false, inflight: 0, waiters: [] };
    states[provider] = state;
  }
  return state;
}

export function __resetWebToolStateForTest(): void {
  states = {};
}

export function isExaRateLimited(text: string): boolean {
  return text.includes(EXA_RATE_LIMIT_MARKER);
}

// The keyless endpoints reject well before these ceilings; pi-pi fans research
// out to several in-process workers that share this module, so calls are queued
// rather than allowed to collide and spend the whole tier on rate-limit errors.
function concurrencyLimit(provider: Provider): number {
  if (provider === "exa") return process.env.EXA_API_KEY ? 8 : 3;
  if (provider === "tavily") return process.env.TAVILY_API_KEY ? 8 : 4;
  return 4;
}

async function acquire(provider: Provider): Promise<void> {
  const state = stateOf(provider);
  if (state.inflight < concurrencyLimit(provider)) {
    state.inflight++;
    return;
  }
  await new Promise<void>((resolve) => state.waiters.push(resolve));
}

/** Hands the slot straight to the next waiter so in-flight never overshoots. */
function release(provider: Provider): void {
  const state = stateOf(provider);
  const next = state.waiters.shift();
  if (next) next();
  else state.inflight--;
}

function cooldownMs(strikes: number): number {
  if (strikes < 1) return 0;
  return Math.min(INITIAL_COOLDOWN_MS * 2 ** (strikes - 1), PROBE_COOLDOWN_MS);
}

type Attempt = "skip" | "free" | "probe";

/** Claims the single probe slot when a lockout expires, so concurrent callers
 *  don't all re-trip the same limit and re-arm the cooldown for each other. */
function claimAttempt(provider: Provider, now: number): Attempt {
  const state = stateOf(provider);
  if (state.limitedAt == null) return "free";
  if (now - state.limitedAt < cooldownMs(state.strikes)) return "skip";
  if (state.probing) return "skip";
  state.probing = true;
  return "probe";
}

function skipReason(provider: Provider, now: number): string {
  const state = stateOf(provider);
  if (state.probing) return `${provider} probe in flight`;
  const left = Math.max(0, cooldownMs(state.strikes) - (now - (state.limitedAt ?? now)));
  return `${provider} cooling down ${Math.ceil(left / 1000)}s`;
}

function noteSuccess(provider: Provider): void {
  const state = stateOf(provider);
  state.limitedAt = undefined;
  state.strikes = 0;
  state.probing = false;
}

function noteLimited(provider: Provider, now: number): void {
  const state = stateOf(provider);
  state.limitedAt = now;
  state.strikes++;
  state.probing = false;
  getLogger().warn(
    { s: "web", provider, strikes: state.strikes, cooldownMs: cooldownMs(state.strikes) },
    "web provider rate limited",
  );
}

/** A non-rate-limit failure never locks a healthy provider out; it only re-arms
 *  the existing cooldown when it was the probe that failed. */
function noteFailure(provider: Provider, attempt: Attempt, now: number, err: unknown): string {
  const state = stateOf(provider);
  if (attempt === "probe") {
    state.probing = false;
    state.limitedAt = now;
  }
  const message = err instanceof Error ? err.message : String(err);
  getLogger().warn({ s: "web", provider, err: message }, "web provider call failed");
  return `${provider}: ${message}`;
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

/** Every tier refused. Carries why, because a bare lockout string leaves the
 *  caller unable to tell a rate limit from an outage. */
function unavailable(causes: string[]): Error {
  getLogger().warn({ s: "web", causes }, "web tools unavailable");
  return new Error(causes.length ? `${UNAVAILABLE}: ${causes.join("; ")}` : UNAVAILABLE);
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

async function runSearch(query: string, numResults: number): Promise<string> {
  const now = Date.now();
  const causes: string[] = [];

  const exa = claimAttempt("exa", now);
  if (exa === "skip") causes.push(skipReason("exa", now));
  else {
    await acquire("exa");
    try {
      const result = await callExa("web_search_exa", { query, numResults });
      if (!isExaRateLimited(result)) {
        noteSuccess("exa");
        return result;
      }
      noteLimited("exa", now);
    } catch (e) {
      if (e instanceof RateLimitError) noteLimited("exa", now);
      else causes.push(noteFailure("exa", exa, now, e));
    } finally {
      release("exa");
    }
  }

  const tavily = claimAttempt("tavily", now);
  if (tavily === "skip") causes.push(skipReason("tavily", now));
  else {
    await acquire("tavily");
    try {
      const result = await callTavilySearch(query, numResults);
      noteSuccess("tavily");
      return result;
    } catch (e) {
      if (e instanceof RateLimitError) noteLimited("tavily", now);
      else causes.push(noteFailure("tavily", tavily, now, e));
    } finally {
      release("tavily");
    }
  }

  throw unavailable(causes);
}

async function runFetch(urls: string[], maxCharacters: number): Promise<string> {
  const now = Date.now();
  const causes: string[] = [];

  const exa = claimAttempt("exa", now);
  if (exa === "skip") causes.push(skipReason("exa", now));
  else {
    await acquire("exa");
    try {
      const result = await callExa("web_fetch_exa", { urls, maxCharacters });
      if (!isExaRateLimited(result)) {
        noteSuccess("exa");
        return result;
      }
      noteLimited("exa", now);
    } catch (e) {
      if (e instanceof RateLimitError) noteLimited("exa", now);
      else causes.push(noteFailure("exa", exa, now, e));
    } finally {
      release("exa");
    }
  }

  const tavily = claimAttempt("tavily", now);
  if (tavily === "skip") causes.push(skipReason("tavily", now));
  else {
    await acquire("tavily");
    try {
      const result = await callTavilyExtract(urls);
      noteSuccess("tavily");
      return result;
    } catch (e) {
      if (e instanceof RateLimitError) noteLimited("tavily", now);
      else causes.push(noteFailure("tavily", tavily, now, e));
    } finally {
      release("tavily");
    }
  }

  const jina = claimAttempt("jina", now);
  if (jina === "skip") causes.push(skipReason("jina", now));
  else {
    await acquire("jina");
    try {
      const result = await callJina(urls);
      noteSuccess("jina");
      return result;
    } catch (e) {
      if (e instanceof RateLimitError) noteLimited("jina", now);
      else causes.push(noteFailure("jina", jina, now, e));
    } finally {
      release("jina");
    }
  }

  throw unavailable(causes);
}

export function registerExaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web",
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
        if (e?.message?.startsWith(UNAVAILABLE)) return fail(e.message);
        return fail(`web_search error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web",
    description:
      "Read a webpage's full content as clean markdown. " +
      "Use after web_search when highlights are insufficient, or to read any URL. " +
      "Batch multiple URLs in one call.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to read" }),
      maxCharacters: Type.Optional(Type.Number({ description: "Max characters per page (default: 3000)" })),
    }),
    async execute(_toolCallId, params: any) {
      try {
        return ok(await runFetch(params.urls, params.maxCharacters ?? 3000));
      } catch (e: any) {
        if (e?.message?.startsWith(UNAVAILABLE)) return fail(e.message);
        return fail(`web_fetch error: ${e.message}`);
      }
    },
  });
}
