import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebToolStateForTest, callExa, registerExaTools } from "./exa.js";

function mockFetchText(text: string, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  })) as any;
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  __resetWebToolStateForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callExa additional branches", () => {
  it("skips malformed SSE data lines and returns the next valid payload", async () => {
    const body = [
      "data: {not valid json",
      `data: ${JSON.stringify({ result: { content: [{ text: "recovered" }] } })}`,
    ].join("\n");
    mockFetchText(body);
    await expect(callExa("web_search_exa", {})).resolves.toBe("recovered");
  });

  it("skips SSE lines without a data: prefix", async () => {
    const body = [
      "event: message",
      "",
      `data: ${JSON.stringify({ result: { content: [{ text: "after prelude" }] } })}`,
    ].join("\n");
    mockFetchText(body);
    await expect(callExa("web_search_exa", {})).resolves.toBe("after prelude");
  });

  it("returns an empty-string text result from a JSON payload (text != null)", async () => {
    mockFetchText(JSON.stringify({ result: { content: [{ text: "" }] } }));
    await expect(callExa("web_search_exa", {})).resolves.toBe("");
  });

  it("falls through SSE with no text and returns raw JSON body content", async () => {
    const body = `data: ${JSON.stringify({ result: { content: [{}] } })}`;
    mockFetchText(body);
    await expect(callExa("web_search_exa", {})).resolves.toBe(body);
  });

  it("sends a well-formed JSON-RPC body to the Exa endpoint", async () => {
    const fn = mockFetchText(JSON.stringify({ result: { content: [{ text: "x" }] } }));
    await callExa("web_fetch_exa", { urls: ["http://a"] });
    const [url, opts] = fn.mock.calls[0];
    expect(url).toBe("https://mcp.exa.ai/mcp");
    expect(opts.method).toBe("POST");
    const parsed = JSON.parse(opts.body);
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params.name).toBe("web_fetch_exa");
    expect(parsed.params.arguments).toEqual({ urls: ["http://a"] });
  });
});

function makePi() {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool: vi.fn((def: any) => tools.set(def.name, def)),
  };
}

describe("registerExaTools", () => {
  it("registers exactly the two Exa tools", () => {
    const pi = makePi();
    registerExaTools(pi as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect([...pi.tools.keys()].sort()).toEqual(["exa_fetch", "exa_search"]);
  });

  it("exa_search returns ok content on success and applies the default numResults", async () => {
    const fn = mockFetchText(JSON.stringify({ result: { content: [{ text: "results!" }] } }));
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "cats" });
    expect(res.content[0].text).toBe("results!");
    expect(res.isError).toBeUndefined();
    const args = JSON.parse(fn.mock.calls[0][1].body).params.arguments;
    expect(args).toEqual({ query: "cats", numResults: 5 });
  });

  it("exa_search falls through to Tavily when Exa throws", async () => {
    mockFetchText(JSON.stringify({ error: { message: "boom" } }));
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "cats" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("No results found.");
  });

  it("exa_fetch passes urls and default maxCharacters, returns ok content", async () => {
    const fn = mockFetchText(JSON.stringify({ result: { content: [{ text: "page" }] } }));
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"] });
    expect(res.content[0].text).toBe("page");
    const args = JSON.parse(fn.mock.calls[0][1].body).params.arguments;
    expect(args).toEqual({ urls: ["http://x"], maxCharacters: 3000 });
  });

  it("exa_fetch falls through a non-rate-limit Exa error to the rest of the chain (no sticky lockout)", async () => {
    // A 500 on every hop: Exa 500 (not a rate limit) falls through WITHOUT
    // marking Exa limited; Tavily 500 throws a non-rate-limit error and falls
    // through; Jina 500 yields a per-url "Failed to fetch" result string. The
    // chain does NOT abort with an error result on a plain 500.
    mockFetchText("nope", { ok: false, status: 500 });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"], maxCharacters: 10 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("Failed to fetch");
  });

  it("exa_fetch keyed-Exa: sends Authorization when EXA_API_KEY is set", async () => {
    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-key-xyz";
    try {
      const fn = mockFetchText(JSON.stringify({ result: { content: [{ text: "keyed ok" }] } }));
      const pi = makePi();
      registerExaTools(pi as any);
      const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"], maxCharacters: 10 });
      expect(res.content[0].text).toBe("keyed ok");
      // First fetch call is Exa; assert the Authorization header was attached.
      const firstCallInit = fn.mock.calls[0][1];
      expect(firstCallInit.headers.Authorization).toBe("Bearer exa-key-xyz");
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = prev;
    }
  });
});
