import { describe, expect, it } from "vitest";
import { searchEntries } from "./search.js";
import type { RenderedEntry } from "./session.js";

const entry = (index: number, summary: string, role = "user", files?: string[]): RenderedEntry => ({ index, role, summary, ...(files && { files }) });
const indices = (hits: RenderedEntry[]) => hits.map((hit) => hit.index);

describe("searchEntries", () => {
  it("returns every entry unchanged for a blank query", () => {
    const entries = [entry(0, "a"), entry(1, "b")];
    expect(searchEntries(entries, [], "   ")).toBe(entries);
    expect(searchEntries(entries, [])).toBe(entries);
  });

  it("matches British and American spellings of the same word", () => {
    const entries = [
      entry(0, "authorisation failed"),
      entry(1, "the colour is wrong"),
      entry(2, "analyze the logs"),
      entry(3, "the catalog entry"),
      entry(4, "a computer program"),
      entry(5, "license expired"),
      entry(6, "organize imports"),
    ];
    const find = (query: string) => indices(searchEntries(entries, [], query));
    expect(find("authorization")).toEqual([0]);
    expect(find("color")).toEqual([1]);
    expect(find("analyse")).toEqual([2]);
    expect(find("catalogue")).toEqual([3]);
    expect(find("programme")).toEqual([4]);
    expect(find("licence")).toEqual([5]);
    expect(find("organise")).toEqual([6]);
  });

  it("treats a query with metacharacters as one regex over role, text and files", () => {
    const entries = [entry(0, "fail at build"), entry(1, "nothing"), entry(2, "x", "assistant", ["/src/app.ts"])];
    expect(indices(searchEntries(entries, [], "fail.*build"))).toEqual([0]);
    expect(indices(searchEntries(entries, [], "app\\.ts"))).toEqual([2]);
    expect(indices(searchEntries(entries, [], "^assistant"))).toEqual([2]);
  });

  it("falls back to a literal match for an invalid regex", () => {
    const entries = [entry(0, "call foo( with paren"), entry(1, "foo")];
    expect(indices(searchEntries(entries, [], "foo("))).toEqual([0]);
  });

  it("caps an oversized regex to a literal of its head", () => {
    const head = "a".repeat(64);
    const entries = [entry(0, `${head} tail`), entry(1, "b")];
    expect(indices(searchEntries(entries, [], `${head}${"(".repeat(300)}`))).toEqual([0]);
  });

  it("stops a regex search at fifty hits", () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry(i, `hit ${i}`));
    expect(searchEntries(entries, [], "hit.")).toHaveLength(50);
  });

  it("caps a term search at fifty hits", () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry(i, `hit ${i}`));
    expect(searchEntries(entries, [], "hit")).toHaveLength(50);
  });

  it("searches the full message text, reasoning included, and snippets around the first matching line", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    lines[5] = "the needle is here";
    const messages: any[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: lines.join("\n") }] }];
    const [hit] = searchEntries([entry(0, "short summary", "assistant")], messages, "needle");
    expect(hit!.snippet).toBe("...(4 lines above)\nline 3\nline 4\nthe needle is here\nline 6\nline 7\n...(2 lines below)");
    expect(hit!.matchCount).toBe(1);
    expect(indices(searchEntries([entry(0, "short summary", "assistant")], messages, "secret"))).toEqual([0]);
  });

  it("leaves no snippet when the match is only in the role or files", () => {
    const [hit] = searchEntries([entry(0, "text", "assistant", ["/a/needle.ts"])], [], "needle");
    expect(hit!.snippet).toBeUndefined();
  });

  it("searches bash executions by command and output", () => {
    const messages: any[] = [{ role: "bashExecution", command: "make deploy", output: "ok" }];
    expect(indices(searchEntries([entry(0, "$ make", "bash")], messages, "deploy"))).toEqual([0]);
  });

  it("drops stopwords but keeps the query when it is all stopwords", () => {
    const entries = [entry(0, "what is this"), entry(1, "deploy the thing")];
    expect(indices(searchEntries(entries, [], "the deploy"))).toEqual([1]);
    expect(indices(searchEntries(entries, [], "what this"))).toEqual([0]);
  });

  it("requires two of three or more meaningful terms to match", () => {
    const entries = [entry(0, "alpha only"), entry(1, "alpha beta"), entry(2, "gamma beta alpha")];
    expect(indices(searchEntries(entries, [], "alpha beta gamma")).sort()).toEqual([1, 2]);
  });

  it("ranks by relevance and drops hits scoring far below the best", () => {
    const filler = "word ".repeat(200);
    const entries = [
      entry(0, `${filler} rare`),
      entry(1, "rare rare rare common"),
      ...Array.from({ length: 20 }, (_, i) => entry(i + 2, `common ${filler}`)),
    ];
    const hits = indices(searchEntries(entries, [], "rare common"));
    expect(hits[0]).toBe(1);
    expect(hits).not.toContain(2);
  });
});
