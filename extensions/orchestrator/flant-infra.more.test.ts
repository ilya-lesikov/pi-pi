import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshAnthropicTokenMock = vi.fn();
vi.mock("@earendil-works/pi-ai/oauth", () => ({
  refreshAnthropicToken: (...args: unknown[]) => refreshAnthropicTokenMock(...args),
}));

const updateRegistryMock = vi.fn();
vi.mock("./model-registry.js", () => ({
  updateRegistryFromAvailableModels: (...args: unknown[]) => updateRegistryMock(...args),
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-more-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModule(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("./flant-infra.js");
}

function stubFetch(handler: (url: string, opts: any) => any) {
  const fn = vi.fn(async (url: string, opts: any) => handler(url, opts));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  refreshAnthropicTokenMock.mockReset();
  updateRegistryMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.FLANT_API_KEY;
  delete process.env.LLM_API_KEY;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("discoverFlantModels", () => {
  it("dedupes and filters out or/ prefixed ids", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-4-8" }, { id: "claude-opus-4-8" }, { id: "or/skip" }, { id: 5 }] }),
    }));
    await expect(mod.discoverFlantModels("k")).resolves.toEqual(["claude-opus-4-8"]);
  });

  it("throws on a non-ok HTTP status", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(mod.discoverFlantModels("k")).rejects.toThrow("503");
  });
});

describe("fetchOpenRouterMetadata", () => {
  it("returns {} when no model ids map to OpenRouter ids", async () => {
    const mod = await loadModule(makeTempDir());
    const fn = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await expect(mod.fetchOpenRouterMetadata(["totally-unknown-model"])).resolves.toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps diverse flant ids to openrouter ids and pulls metadata", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "anthropic/claude-opus-4.8",
            name: "Claude Opus",
            context_length: 250000,
            top_provider: { max_completion_tokens: 64000 },
            pricing: { prompt: 1, completion: 2, input_cache_read: 3, input_cache_write: 4 },
            architecture: { modality: "text+image" },
          },
          { id: "openai/gpt-5", name: "GPT 5" },
          { id: "deepseek/deepseek-v3" },
          { id: "x-ai/grok-4" },
          { id: "qwen/qwen-3-coder" },
          { id: "perplexity/sonar-pro" },
          { id: "openai/o3-mini" },
          { id: "google/gemini-3.1-pro-preview" },
        ],
      }),
    }));
    const out = await mod.fetchOpenRouterMetadata([
      "claude-opus-4-8",
      "gpt-5",
      "deepseek-v3",
      "grok-4",
      "qwen-3-coder",
      "sonar-pro",
      "o3-mini",
      "gemini-3.1-pro",
      "unmapped-thing",
    ]);
    expect(out["claude-opus-4-8"]).toMatchObject({
      name: "Claude Opus",
      context_length: 250000,
      max_completion_tokens: 64000,
      modality: "text+image",
    });
    expect(out["claude-opus-4-8"].pricing).toEqual({ prompt: 1, completion: 2, cacheRead: 3, cacheWrite: 4 });
    expect(out["gpt-5"].name).toBe("GPT 5");
    expect(out["deepseek-v3"]).toBeTruthy();
    expect(out["grok-4"]).toBeTruthy();
    expect(out["qwen-3-coder"]).toBeTruthy();
    expect(out["sonar-pro"]).toBeTruthy();
    expect(out["o3-mini"]).toBeTruthy();
    expect(out["gemini-3.1-pro"]).toBeTruthy();
  });

  it("throws when OpenRouter returns a non-ok status", async () => {
    const mod = await loadModule(makeTempDir());
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(mod.fetchOpenRouterMetadata(["claude-opus-4-8"])).rejects.toThrow("500");
  });
});

describe("probeSubscriptionCleared", () => {
  function writeAuth(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-x", refresh: "rt", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
  }

  it("returns error when credentials are missing", async () => {
    const dir = makeTempDir();
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns ok on a 200 response", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    const fn = stubFetch(() => ({ ok: true, status: 200 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("ok");
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.model).toBe("sub/claude-haiku-4-5");
  });

  it("returns rate_limited on a 429", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 429 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("rate_limited");
  });

  it("returns error on an unexpected status and on a thrown fetch", async () => {
    const dir = makeTempDir();
    writeAuth(dir);
    process.env.LLM_API_KEY = "gw";
    const mod = await loadModule(dir);
    stubFetch(() => ({ ok: false, status: 500 }));
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
    stubFetch(() => { throw new Error("net"); });
    await expect(mod.probeSubscriptionCleared("sub/claude-haiku-4-5")).resolves.toBe("error");
  });
});

describe("updateFlantInfra", () => {
  function makePi() {
    const registered = new Map<string, unknown>();
    return {
      registered,
      registerProvider: vi.fn((n: string, c: unknown) => registered.set(n, c)),
      unregisterProvider: vi.fn((n: string) => registered.delete(n)),
    } as any;
  }

  it("fails when no cache and no FLANT_API_KEY", async () => {
    const mod = await loadModule(makeTempDir());
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("FLANT_API_KEY");
  });

  it("discovers models, saves cache, and registers providers on success", async () => {
    const dir = makeTempDir();
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch((url: string) => {
      if (url.includes("llm-api.flant.ru/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-4-8" }, { id: "gpt-5" }] }) };
      }
      if (url.includes("openrouter.ai")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    });
    const pi = makePi();
    const res = await mod.updateFlantInfra(pi);
    expect(res.ok).toBe(true);
    expect(res.models).toContain("claude-opus-4-8");
    expect([...pi.registered.keys()].sort()).toEqual(["pp-flant-anthropic", "pp-flant-openai"]);
  });

  it("falls back to cached models when discovery throws", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        enabled: true,
        cachedFlantModels: ["claude-opus-4-8"],
        cachedOpenRouterData: {},
      }),
      "utf-8",
    );
    process.env.FLANT_API_KEY = "flant-k";
    const mod = await loadModule(dir);
    stubFetch(() => { throw new Error("discovery down"); });
    const res = await mod.updateFlantInfra(makePi());
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["claude-opus-4-8"]);
  });
});

describe("initFlantSync / initFlantOnStartup", () => {
  function makePi() {
    return { registerProvider: vi.fn(), unregisterProvider: vi.fn() } as any;
  }

  it("initFlantSync is a no-op when disabled", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = makePi();
    mod.initFlantSync(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(mod.getFlantGeneratedConfig()).toBeNull();
  });

  it("initFlantSync registers from cache when enabled", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({ enabled: true, cachedFlantModels: ["claude-opus-4-8"], cachedOpenRouterData: {} }),
      "utf-8",
    );
    const mod = await loadModule(dir);
    const pi = makePi();
    mod.initFlantSync(pi);
    expect(pi.registerProvider).toHaveBeenCalled();
    expect(mod.getFlantGeneratedConfig()).not.toBeNull();
  });

  it("initFlantOnStartup is a no-op when disabled", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = makePi();
    await mod.initFlantOnStartup(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("initFlantOnStartup skips update when autoUpdate is off", async () => {
    const dir = makeTempDir();
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({ enabled: true, autoUpdate: false, subscription: false }),
      "utf-8",
    );
    const mod = await loadModule(dir);
    const pi = makePi();
    await mod.initFlantOnStartup(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });
});

describe("unregisterFlantProviders", () => {
  it("unregisters all three providers via the passed pi", async () => {
    const mod = await loadModule(makeTempDir());
    const pi = { unregisterProvider: vi.fn(), registerProvider: vi.fn() } as any;
    mod.unregisterFlantProviders(pi);
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-anthropic");
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-openai");
    expect(pi.unregisterProvider).toHaveBeenCalledWith("pp-flant-anthropic-sub");
  });

  it("is a no-op when no pi is set", async () => {
    const mod = await loadModule(makeTempDir());
    expect(() => mod.unregisterFlantProviders()).not.toThrow();
  });
});
