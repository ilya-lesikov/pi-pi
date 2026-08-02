import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __resetWebToolStateForTest,
  callExa,
  isExaRateLimited,
  normalizeTavilyExtract,
  normalizeTavilySearch,
  PROBE_COOLDOWN_MS,
  registerExaTools,
} from "./exa.js";

function mockFetchText(text: string, init: { ok?: boolean; status?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  } as Response);
}

beforeEach(() => {
  __resetWebToolStateForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.TAVILY_API_KEY;
});

describe("callExa error handling", () => {
  it("throws on an SSE error payload even when the message lacks the word 'error'", async () => {
    mockFetchText(`data: ${JSON.stringify({ error: { message: "rate limit exceeded" } })}\n`);
    await expect(callExa("web_search_exa", {})).rejects.toThrow("rate limit exceeded");
  });

  it("returns text from a normal SSE success response", async () => {
    mockFetchText(`data: ${JSON.stringify({ result: { content: [{ text: "hello world" }] } })}\n`);
    await expect(callExa("web_search_exa", {})).resolves.toBe("hello world");
  });

  it("returns text from a non-SSE JSON success response", async () => {
    mockFetchText(JSON.stringify({ result: { content: [{ text: "plain json" }] } }));
    await expect(callExa("web_search_exa", {})).resolves.toBe("plain json");
  });

  it("throws on a non-SSE JSON error payload lacking the word 'error'", async () => {
    mockFetchText(JSON.stringify({ error: { message: "quota reached" } }));
    await expect(callExa("web_search_exa", {})).rejects.toThrow("quota reached");
  });

  it("falls through and returns the raw body for a non-JSON OK response", async () => {
    mockFetchText("not json at all", { ok: true, status: 200 });
    await expect(callExa("web_search_exa", {})).resolves.toBe("not json at all");
  });

  it("throws on a non-JSON body when the HTTP response is not ok", async () => {
    mockFetchText("rate limited", { ok: false, status: 429 });
    await expect(callExa("web_search_exa", {})).rejects.toThrow("Exa HTTP 429");
  });
});

const EXA_URL = "https://mcp.exa.ai/mcp";
const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";

type FakeResp = { ok?: boolean; status?: number; body: string };

function makePi() {
  const tools = new Map<string, any>();
  return { tools, registerTool: vi.fn((def: any) => tools.set(def.name, def)) };
}

function exaSseText(text: string): string {
  return `data: ${JSON.stringify({ result: { content: [{ text }] } })}\n`;
}

function routeFetch(routes: (url: string, opts: any) => FakeResp) {
  const fn = vi.fn(async (url: string, opts: any) => {
    const r = routes(url, opts);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body,
    };
  }) as any;
  vi.stubGlobal("fetch", fn);
  return fn;
}

const EXA_LIMIT_TEXT =
  "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.";

describe("isExaRateLimited", () => {
  it("detects the Exa free-tier rate-limit marker in a result string", () => {
    expect(isExaRateLimited(EXA_LIMIT_TEXT)).toBe(true);
    expect(isExaRateLimited("normal results here")).toBe(false);
  });
});

describe("normalizeTavilySearch", () => {
  it("normalizes results (and an answer) into clean text", () => {
    const out = normalizeTavilySearch({
      answer: "The capital is Paris.",
      results: [
        { title: "T1", url: "http://a", content: "snippet a", score: 0.9 },
        { title: "T2", url: "http://b", content: "snippet b" },
      ],
    });
    expect(out).toContain("Answer: The capital is Paris.");
    expect(out).toContain("Title: T1");
    expect(out).toContain("URL: http://a");
    expect(out).toContain("snippet a");
    expect(out).toContain("Title: T2");
    expect(out).toContain("snippet b");
  });

  it("prefers raw_content over content and returns a fallback for empty results", () => {
    const out = normalizeTavilySearch({ results: [{ url: "http://a", content: "c", raw_content: "RAW" }] });
    expect(out).toContain("RAW");
    expect(out).not.toContain("\nc");
    expect(normalizeTavilySearch({ results: [] })).toBe("No results found.");
  });
});

describe("normalizeTavilyExtract", () => {
  it("normalizes extract results and failed_results", () => {
    const out = normalizeTavilyExtract({
      results: [{ url: "http://a", raw_content: "page a body" }],
      failed_results: [{ url: "http://b", error: "timeout" }],
    });
    expect(out).toContain("URL: http://a");
    expect(out).toContain("page a body");
    expect(out).toContain("URL: http://b");
    expect(out).toContain("Failed to extract: timeout");
  });

  it("returns a fallback for empty extract", () => {
    expect(normalizeTavilyExtract({ results: [] })).toBe("No content extracted.");
  });
});

describe("exa_search fallback chain", () => {
  it("falls to Tavily and returns normalized text when Exa returns the rate-limit string", async () => {
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      if (url === TAVILY_SEARCH)
        return { body: JSON.stringify({ results: [{ title: "TT", url: "http://z", content: "tav body" }] }) };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "q" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("tav body");
    expect(fn.mock.calls.map((c: any[]) => c[0])).toEqual([EXA_URL, TAVILY_SEARCH]);
  });

  it("falls through to Tavily when the Exa call throws", async () => {
    routeFetch((url) => {
      if (url === EXA_URL) return { ok: false, status: 500, body: "boom" };
      if (url === TAVILY_SEARCH)
        return { body: JSON.stringify({ results: [{ url: "http://z", content: "recovered" }] }) };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "q" });
    expect(res.content[0].text).toContain("recovered");
  });

  it("never calls Jina for search", async () => {
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      if (url === TAVILY_SEARCH) return { status: 429, ok: false, body: "limited" };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("web tools temporarily unavailable");
    for (const c of fn.mock.calls) expect((c[0] as string).startsWith("https://r.jina.ai/")).toBe(false);
  });
});

describe("Tavily auth headers", () => {
  it("uses the keyless header when TAVILY_API_KEY is not set", async () => {
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      return { body: JSON.stringify({ results: [] }) };
    });
    const pi = makePi();
    registerExaTools(pi as any);
    await pi.tools.get("exa_search").execute("id", { query: "q" });
    const tavCall = fn.mock.calls.find((c: any[]) => c[0] === TAVILY_SEARCH);
    expect(tavCall[1].headers["X-Tavily-Access-Mode"]).toBe("keyless");
    expect(tavCall[1].headers.Authorization).toBeUndefined();
  });

  it("uses a Bearer Authorization header when TAVILY_API_KEY is set", async () => {
    process.env.TAVILY_API_KEY = "tvly-secret";
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      return { body: JSON.stringify({ results: [] }) };
    });
    const pi = makePi();
    registerExaTools(pi as any);
    await pi.tools.get("exa_search").execute("id", { query: "q" });
    const tavCall = fn.mock.calls.find((c: any[]) => c[0] === TAVILY_SEARCH);
    expect(tavCall[1].headers.Authorization).toBe("Bearer tvly-secret");
    expect(tavCall[1].headers["X-Tavily-Access-Mode"]).toBeUndefined();
  });
});

describe("exa_fetch fallback chain", () => {
  it("falls Exa -> Tavily -> Jina and uses Jina only for fetch", async () => {
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      if (url === TAVILY_EXTRACT) return { status: 429, ok: false, body: "limited" };
      if (url.startsWith("https://r.jina.ai/")) return { body: "jina page content" };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"] });
    expect(res.content[0].text).toContain("jina page content");
    const urls = fn.mock.calls.map((c: any[]) => c[0]);
    expect(urls[0]).toBe(EXA_URL);
    expect(urls[1]).toBe(TAVILY_EXTRACT);
    expect(urls[2]).toBe("https://r.jina.ai/http://x");
  });

  it("concatenates multiple urls with per-url separators via Jina", async () => {
    routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      if (url === TAVILY_EXTRACT) return { status: 429, ok: false, body: "limited" };
      if (url === "https://r.jina.ai/http://a") return { body: "AAA" };
      if (url === "https://r.jina.ai/http://b") return { body: "BBB" };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://a", "http://b"] });
    expect(res.content[0].text).toContain("URL: http://a");
    expect(res.content[0].text).toContain("AAA");
    expect(res.content[0].text).toContain("URL: http://b");
    expect(res.content[0].text).toContain("BBB");
    expect(res.content[0].text).toContain("---");
  });
});

describe("all tiers exhausted", () => {
  it("returns 'web tools temporarily unavailable' for fetch when every tier is limited", async () => {
    routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(EXA_LIMIT_TEXT) };
      if (url === TAVILY_EXTRACT) return { status: 429, ok: false, body: "limited" };
      if (url.startsWith("https://r.jina.ai/")) return { status: 429, ok: false, body: "limited" };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("web tools temporarily unavailable");
  });
});

describe("cooldown re-probe", () => {
  it("skips the higher tier within the cooldown window and re-probes after it elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let exaHealthy = false;
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { body: exaSseText(exaHealthy ? "exa is back" : EXA_LIMIT_TEXT) };
      if (url === TAVILY_SEARCH)
        return { body: JSON.stringify({ results: [{ url: "http://z", content: "tavily result" }] }) };
      throw new Error(`unexpected url ${url}`);
    });
    const pi = makePi();
    registerExaTools(pi as any);

    let res = await pi.tools.get("exa_search").execute("id", { query: "q1" });
    expect(res.content[0].text).toContain("tavily result");
    expect(fn.mock.calls.filter((c: any[]) => c[0] === EXA_URL).length).toBe(1);

    exaHealthy = true;
    vi.setSystemTime(PROBE_COOLDOWN_MS - 1);
    res = await pi.tools.get("exa_search").execute("id", { query: "q2" });
    expect(res.content[0].text).toContain("tavily result");
    expect(fn.mock.calls.filter((c: any[]) => c[0] === EXA_URL).length).toBe(1);

    vi.setSystemTime(PROBE_COOLDOWN_MS);
    res = await pi.tools.get("exa_search").execute("id", { query: "q3" });
    expect(res.content[0].text).toContain("exa is back");
    expect(fn.mock.calls.filter((c: any[]) => c[0] === EXA_URL).length).toBe(2);
  });
});
