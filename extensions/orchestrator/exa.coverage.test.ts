import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebToolStateForTest, callExa, INITIAL_COOLDOWN_MS, registerExaTools } from "./exa.js";

const EXA_URL = "https://mcp.exa.ai/mcp";
const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";

type FakeResp = { ok?: boolean; status?: number; body: string } | Error;

function routeFetch(routes: (url: string) => FakeResp) {
  const fn = vi.fn(async (url: string) => {
    const r = routes(url);
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function tools() {
  const registered = new Map<string, any>();
  registerExaTools({ registerTool: (def: any) => registered.set(def.name, def) } as any);
  return { search: registered.get("web_search"), fetch: registered.get("web_fetch") };
}

const text = (res: any) => res.content[0].text as string;
const calls = (fn: ReturnType<typeof routeFetch>, prefix: string) => fn.mock.calls.filter((c: any[]) => String(c[0]).startsWith(prefix)).length;

beforeEach(() => __resetWebToolStateForTest());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("callExa JSON payloads", () => {
  it("returns a JSON body without text when the response is ok, and fails when it is not", async () => {
    routeFetch(() => ({ body: JSON.stringify({ result: {} }) }));
    await expect(callExa("web_search_exa", {})).resolves.toBe('{"result":{}}');
    routeFetch(() => ({ ok: false, status: 500, body: JSON.stringify({ result: {} }) }));
    await expect(callExa("web_search_exa", {})).rejects.toThrow('Exa HTTP 500: {"result":{}}');
  });
});

describe("web_fetch fallback chain", () => {
  it("serves from Tavily extract when Exa is rate limited by HTTP 429", async () => {
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { ok: false, status: 429, body: "" };
      if (url === TAVILY_EXTRACT) return { body: JSON.stringify({ results: [{ url: "http://a", raw_content: "page a" }] }) };
      throw new Error(`unexpected ${url}`);
    });
    const res = await tools().fetch.execute("id", { urls: ["http://a"] });
    expect(text(res)).toBe("URL: http://a\n\npage a");
    expect(calls(fn, "https://r.jina.ai/")).toBe(0);
  });

  it("skips locked-out tiers on the next call and says so when Jina fails too", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let jina: FakeResp = { ok: false, status: 429, body: "" };
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return { ok: false, status: 429, body: "" };
      if (url === TAVILY_EXTRACT) return { ok: false, status: 432, body: "" };
      return jina;
    });
    const { fetch } = tools();
    await fetch.execute("id", { urls: ["http://a"] });
    vi.setSystemTime(1000);
    jina = new Error("socket hang up");
    const res = await fetch.execute("id", { urls: ["http://a"] });
    expect(text(res)).toBe("web tools temporarily unavailable: exa cooling down 29s; tavily cooling down 29s; jina cooling down 29s");
    expect(calls(fn, EXA_URL)).toBe(1);
    vi.setSystemTime(INITIAL_COOLDOWN_MS);
    const probed = await fetch.execute("id", { urls: ["http://a"] });
    expect(text(probed)).toContain("jina: socket hang up");
  });

  it("re-arms the cooldown when a probe fails for a reason other than a limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let exa: FakeResp = { ok: false, status: 429, body: "" };
    const fn = routeFetch((url) => {
      if (url === EXA_URL) return exa;
      if (url === TAVILY_SEARCH) return { body: JSON.stringify({ results: [{ url: "http://t", content: "from tavily" }] }) };
      throw new Error(`unexpected ${url}`);
    });
    const { search } = tools();
    await search.execute("id", { query: "q" });
    vi.setSystemTime(INITIAL_COOLDOWN_MS);
    exa = new Error("ECONNRESET");
    expect(text(await search.execute("id", { query: "q" }))).toContain("from tavily");
    expect(calls(fn, EXA_URL)).toBe(2);
    vi.setSystemTime(INITIAL_COOLDOWN_MS + 1000);
    await search.execute("id", { query: "q" });
    expect(calls(fn, EXA_URL)).toBe(2);
  });

  it("reports Tavily returning something that is not JSON", async () => {
    routeFetch((url) => {
      if (url === EXA_URL) return { ok: false, status: 429, body: "" };
      if (url === TAVILY_SEARCH) return { body: "<html>oops</html>" };
      throw new Error(`unexpected ${url}`);
    });
    expect(text(await tools().search.execute("id", { query: "q" }))).toBe("web tools temporarily unavailable: tavily: Tavily returned non-JSON: <html>oops</html>");
  });
});
