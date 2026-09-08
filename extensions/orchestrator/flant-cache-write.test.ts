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

afterEach(() => {
  failWritesTo = null;
  delete process.env.PI_CODING_AGENT_DIR;
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
    vi.resetModules();
    const mod = await import("./flant-infra.js");
    const settings = mod.loadFlantSettings();

    failWritesTo = ".tmp";
    expect(() => mod.saveFlantSettings({ ...settings, cachedFlantModels: ["gpt-6"] })).toThrow("disk full");

    expect(JSON.parse(readFileSync(cachePath, "utf-8")).cachedFlantModels).toEqual(["gpt-5"]);
    expect(readdirSync(cacheDir).filter((file) => file.endsWith(".tmp"))).toEqual([]);

    failWritesTo = null;
    mod.saveFlantSettings({ ...settings, cachedFlantModels: ["gpt-6"] });
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).cachedFlantModels).toEqual(["gpt-6"]);
  });
});
