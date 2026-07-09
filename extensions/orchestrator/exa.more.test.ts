import { afterEach, describe, expect, it, vi } from "vitest";
import { callExa, registerExaTools } from "./exa.js";

function mockFetchText(text: string, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  })) as any;
  vi.stubGlobal("fetch", fn);
  return fn;
}

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

  it("exa_search returns an error result when callExa throws", async () => {
    mockFetchText(JSON.stringify({ error: { message: "boom" } }));
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_search").execute("id", { query: "cats" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("exa_search error");
    expect(res.content[0].text).toContain("boom");
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

  it("exa_fetch returns an error result when callExa throws", async () => {
    mockFetchText("nope", { ok: false, status: 500 });
    const pi = makePi();
    registerExaTools(pi as any);
    const res = await pi.tools.get("exa_fetch").execute("id", { urls: ["http://x"], maxCharacters: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("exa_fetch error");
  });
});
