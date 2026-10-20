import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneTranscripts, TranscriptStore, transcriptRoots } from "./transcripts.js";

let cwd: string;
let cache: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pp-transcripts-"));
  cache = mkdtempSync(join(tmpdir(), "pp-transcripts-cache-"));
  mkdirSync(join(cwd, ".pp"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("TranscriptStore", () => {
  it("writes a pi session file per worker, one line per message, private to the user", async () => {
    const warn = vi.fn();
    const store = new TranscriptStore(cwd, "sess/1", warn, cache);
    store.open("explore-1");
    store.append("explore-1", { role: "user", content: "task" });
    store.append("explore-1", { role: "assistant", content: [{ type: "text", text: "done" }] });
    store.append("explore-1", { nope: true });
    await store.drain("explore-1");
    const file = store.fileFor("explore-1")!;
    expect(file).toBe(join(cwd, ".pp", "workers", "sess_1", "explore-1.jsonl"));
    const [header, first, second, ...rest] = lines(file);
    expect(header).toMatchObject({ type: "session", version: 3, cwd });
    expect(first).toMatchObject({ type: "message", parentId: null, message: { role: "user", content: "task" } });
    expect(second.parentId).toBe(first.id);
    expect(typeof second.timestamp).toBe("string");
    expect(rest).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cwd, ".pp", ".gitignore"), "utf8")).toBe("*\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it("never edits an existing .gitignore, and moves transcripts out of the project when it does not ignore them", async () => {
    writeFileSync(join(cwd, ".pp", ".gitignore"), "logs/\n");
    const warn = vi.fn();
    const store = new TranscriptStore(cwd, "s", warn, cache);
    store.append("w-1", { role: "user", content: "x" });
    await store.drain("w-1");
    expect(readFileSync(join(cwd, ".pp", ".gitignore"), "utf8")).toBe("logs/\n");
    expect(store.fileFor("w-1")!.startsWith(cache)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/outside the project/));
    writeFileSync(join(cwd, ".pp", ".gitignore"), "state/\nworkers/\n");
    const kept = new TranscriptStore(cwd, "s2", vi.fn(), cache);
    kept.open("w-1");
    expect(kept.fileFor("w-1")!.startsWith(join(cwd, ".pp"))).toBe(true);
  });

  it("does not reuse a file left by an earlier session with the same worker id", async () => {
    const first = new TranscriptStore(cwd, "s", vi.fn(), cache);
    first.append("w-1", { role: "user", content: "one" });
    await first.drain("w-1");
    const second = new TranscriptStore(cwd, "s", vi.fn(), cache);
    second.append("w-1", { role: "user", content: "two" });
    await second.drain("w-1");
    expect(second.fileFor("w-1")).not.toBe(first.fileFor("w-1"));
    expect(lines(first.fileFor("w-1")!)).toHaveLength(2);
  });

  it("turns itself off for a worker when the disk refuses, without throwing", async () => {
    writeFileSync(join(cwd, ".pp", "workers"), "not a directory");
    const store = new TranscriptStore(cwd, "s", vi.fn(), cache);
    store.append("w-1", { role: "user", content: "x" });
    await store.drain("w-1");
    expect(store.fileFor("w-1")).toBeUndefined();
    expect(() => store.append("w-1", { role: "user", content: "y" })).not.toThrow();
  });

  it("stops at the size cap with a marker line", async () => {
    const store = new TranscriptStore(cwd, "s", vi.fn(), cache);
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 25; i++) store.append("w-1", { role: "assistant", content: [{ type: "text", text: big }] });
    await store.drain("w-1");
    const file = join(cwd, ".pp", "workers", "s", "w-1.jsonl");
    const all = lines(file);
    expect(all.at(-1)).toMatchObject({ type: "custom", customType: "pi-pi-truncated" });
    expect(statSync(file).size).toBeLessThan(21 * 1024 * 1024);
    expect(store.fileFor("w-1")).toBeUndefined();
  });
});

describe("pruneTranscripts", () => {
  it("removes session folders untouched for a week and keeps recent ones", async () => {
    const [root] = transcriptRoots(cwd, cache);
    const old = join(root!, "old");
    const fresh = join(root!, "fresh");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "w.jsonl"), "{}\n");
    writeFileSync(join(fresh, "w.jsonl"), "{}\n");
    const longAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(join(old, "w.jsonl"), longAgo, longAgo);
    utimesSync(old, longAgo, longAgo);
    await pruneTranscripts([root!, join(cache, "missing")]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
