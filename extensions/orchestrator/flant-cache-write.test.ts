import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The cache write is fault-injected here rather than in the other flant suites:
// mocking node:fs applies to a whole file, and every other test needs the real one.
let failWritesTo: string | null = null;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: actual,
    writeFileSync: (file: any, data: any, options?: any) => {
      if (failWritesTo && String(file).includes(failWritesTo)) throw new Error("disk full");
      return actual.writeFileSync(file, data, options);
    },
  };
});

const tempDirs: string[] = [];

const savedGatewayKeys = { LLM_API_KEY: process.env.LLM_API_KEY, FLANT_API_KEY: process.env.FLANT_API_KEY };

afterEach(() => {
  failWritesTo = null;
  vi.unstubAllGlobals();
  delete process.env.PI_CODING_AGENT_DIR;
  for (const [key, value] of Object.entries(savedGatewayKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// An interrupted in-place rewrite leaves truncated JSON behind, and a cache that
// does not parse registers NO flant providers at extension load — early enough
// that the host cannot restore the session's model and warns about it.
describe("flant cache writes", () => {
  it("keeps the previous cache readable when the write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-write-"));
    tempDirs.push(dir);
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "flant-models.json");
    writeFileSync(cachePath, JSON.stringify({ lastUpdated: null, cachedFlantModels: ["gpt-5"], cachedOpenRouterData: {} }), "utf-8");

    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.LLM_API_KEY = "gw";
    vi.resetModules();
    const mod = await import("./flant-infra.js");
    expect(mod.loadLlmApiCache().cachedFlantModels).toEqual(["gpt-5"]);
    // The cache is written only by a refresh, so drive one with the gateway
    // listing a different catalog than the one on disk.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-6" }] }) };
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "openai/gpt-6", name: "GPT 6", context_length: 400000 }] }) };
      }
      throw new Error(`unexpected ${url}`);
    }));
    const pi = { registerProvider: vi.fn(), unregisterProvider: vi.fn() } as any;

    failWritesTo = ".tmp";
    // A failed write must not fail the refresh itself: the catalog it fetched
    // is still registered for this session, only the disk keeps the old one.
    const failed = await mod.updateFlantInfra(pi, { force: true });
    expect(failed.ok).toBe(true);

    expect(JSON.parse(readFileSync(cachePath, "utf-8")).cachedFlantModels).toEqual(["gpt-5"]);
    expect(mod.loadLlmApiCache().cachedFlantModels).toEqual(["gpt-5"]);
    expect(readdirSync(cacheDir).filter((file) => file.endsWith(".tmp"))).toEqual([]);

    failWritesTo = null;
    const ok = await mod.updateFlantInfra(pi, { force: true });
    expect(ok).toMatchObject({ ok: true, models: ["gpt-6"] });
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).cachedFlantModels).toEqual(["gpt-6"]);
    expect(mod.loadLlmApiCache().cachedFlantModels).toEqual(["gpt-6"]);
    expect(readdirSync(cacheDir).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });
});
