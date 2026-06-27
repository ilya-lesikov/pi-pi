import { describe, it, expect, vi, afterEach } from "vitest";
import { callExa } from "./exa.js";

function mockFetchText(text: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    text: async () => text,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it("falls through and returns the raw body for a non-JSON response", async () => {
    mockFetchText("not json at all");
    await expect(callExa("web_search_exa", {})).resolves.toBe("not json at all");
  });
});
