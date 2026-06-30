import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-infra-"));
  tempDirs.push(dir);
  return dir;
}

async function loadFlantInfraModule(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("./flant-infra.js");
}

function collectModelSpecs(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.model === "string") out.push(node.model);
    for (const nested of Object.values(node)) {
      walk(nested);
    }
  };
  walk(value);
  return out;
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("flant-infra", () => {
  it("registerFlantProviders is idempotent across repeated calls", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const registered = new Map<string, unknown>();
    const pi = {
      registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
      unregisterProvider: vi.fn((name: string) => registered.delete(name)),
    } as any;

    const models = ["claude-opus-4-6", "gpt-5"];
    mod.registerFlantProviders(pi, models, {});
    mod.registerFlantProviders(pi, models, {});

    expect(registered.size).toBe(2);
    expect([...registered.keys()].sort()).toEqual(["pp-flant-anthropic", "pp-flant-openai"]);
  });

  it("does not register the sub provider when subscription is disabled", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const registered = new Map<string, unknown>();
    const pi = {
      registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
      unregisterProvider: vi.fn((name: string) => registered.delete(name)),
    } as any;

    mod.registerFlantProviders(pi, ["claude-opus-4-8", "gpt-5"], {}, { subscription: false });
    expect([...registered.keys()].sort()).toEqual(["pp-flant-anthropic", "pp-flant-openai"]);
  });

  it("registers the sub provider with sub/ models when subscription enabled and credentials present", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-test-token", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const prevKey = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "sk-gateway-test";
    try {
      const mod = await loadFlantInfraModule(dir);
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["claude-opus-4-8", "claude-haiku-4-5", "gpt-5"], {}, { subscription: true });

      expect([...registered.keys()].sort()).toEqual(["pp-flant-anthropic", "pp-flant-anthropic-sub", "pp-flant-openai"]);
      const sub = registered.get("pp-flant-anthropic-sub");
      expect(sub.api).toBe("anthropic-messages");
      expect(sub.baseUrl).toBe("https://llm-api.flant.ru");
      expect(sub.apiKey).toBe("sk-ant-oat01-test-token");
      expect(sub.headers["x-litellm-api-key"]).toBe("Bearer sk-gateway-test");
      expect(sub.models.map((m: any) => m.id).sort()).toEqual(["sub/claude-haiku-4-5", "sub/claude-opus-4-8"]);
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("skips the sub provider when subscription enabled but OAuth token missing", async () => {
    const dir = makeTempDir();
    const prevKey = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "sk-gateway-test";
    try {
      const mod = await loadFlantInfraModule(dir);
      const registered = new Map<string, unknown>();
      const pi = {
        registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {}, { subscription: true });
      expect(registered.has("pp-flant-anthropic-sub")).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("readClaudeOAuthToken returns null for expired token", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { access: "sk-ant-oat01-old", expires: Date.now() - 1000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);
    expect(mod.readClaudeOAuthToken()).toBeNull();
  });

  it("generateDisplayName formats model ids", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    expect(mod.generateDisplayName("claude-opus-4-6")).toBe("Claude Opus 4.6");
    expect(mod.generateDisplayName("gpt-5-4-mini")).toBe("GPT 5.4 Mini");
    expect(mod.generateDisplayName("o3-mini")).toBe("O3 Mini");
    expect(mod.generateDisplayName("qwen-3-coder")).toBe("Qwen 3 Coder");
    expect(mod.generateDisplayName("api-ai-2")).toBe("API AI 2");
  });

  it("generateFlantConfig creates config with mapped model specs", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const config = mod.generateFlantConfig([
      "claude-opus-4-6",
      "gpt-5-4",
      "gpt-5-4-mini",
      "gemini-3-1-pro",
      "gemini-3-1-flash",
      "deepseek-v3",
      "grok-4",
    ]) as any;

    expect(config.agents.orchestrators.implement.model).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(config.agents.orchestrators.plan.model).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(config.agents.orchestrators.debug.model).toBe("pp-flant-openai/gpt-5-4");
    expect(config.agents.orchestrators.brainstorm.model).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(config.agents.orchestrators.review.model).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(config.agents.subagents.simple.explore.model).toBe("pp-flant-openai/gemini-3-1-flash");
    expect(config.agents.subagents.simple.librarian.model).toBe("pp-flant-openai/gemini-3-1-flash");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.opus.model).toBe("pp-flant-anthropic/claude-opus-4-6");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.gpt.model).toBe("pp-flant-openai/gpt-5-4");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.gemini.model).toBe("pp-flant-openai/gemini-3-1-pro");
  });

  it("generateFlantConfig returns empty object for empty models", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    expect(mod.generateFlantConfig([])).toEqual({});
  });

  it("generateFlantConfig with anthropic-only models uses anthropic specs", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const config = mod.generateFlantConfig(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-3-5"]);
    const specs = collectModelSpecs(config);

    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((spec) => spec.startsWith("pp-flant-anthropic/"))).toBe(true);
    expect(specs.some((spec) => spec.startsWith("pp-flant-openai/"))).toBe(false);
  });

  it("generateFlantConfig picks latest models per family", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const config = mod.generateFlantConfig([
      "claude-opus-4-5",
      "claude-opus-4-7",
      "gpt-5-3",
      "gpt-5-4",
      "gemini-3-0-pro",
      "gemini-3-1-pro",
      "gemini-3-1-flash",
      "gemini-3-1-flash-lite",
    ]) as any;

    expect(config.agents.orchestrators.implement.model).toBe("pp-flant-anthropic/claude-opus-4-7");
    expect(config.agents.orchestrators.plan.model).toBe("pp-flant-anthropic/claude-opus-4-7");
    expect(config.agents.orchestrators.debug.model).toBe("pp-flant-openai/gpt-5-4");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.gemini.model).toBe("pp-flant-openai/gemini-3-1-pro");
    expect(config.agents.subagents.simple.explore.model).toBe("pp-flant-openai/gemini-3-1-flash-lite");
  });

  it("loadFlantSettings returns defaults when file is missing", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    expect(mod.loadFlantSettings()).toEqual({
      enabled: false,
      autoUpdate: true,
      cacheTTLDays: 7,
      subscription: false,
      lastUpdated: null,
      cachedFlantModels: null,
      cachedOpenRouterData: null,
    });
  });

  it("loadFlantSettings parses valid settings file", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const settingsDir = join(dir, "extensions", "pp", "cache");
    const settingsPath = join(settingsDir, "flant-models.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        enabled: true,
        autoUpdate: false,
        cacheTTLDays: "3",
        lastUpdated: "2026-01-02T03:04:05.000Z",
        cachedFlantModels: ["gpt-5-4", 123, "claude-opus-4-6"],
        cachedOpenRouterData: {
          "gpt-5-4": {
            name: "GPT 5.4",
            context_length: 123,
            max_completion_tokens: 45,
            pricing: { prompt: 1, completion: 2, cacheRead: 3, cacheWrite: 4 },
            modality: "text",
          },
        },
      }),
      "utf-8",
    );

    expect(mod.loadFlantSettings()).toEqual({
      enabled: true,
      autoUpdate: false,
      cacheTTLDays: 3,
      subscription: false,
      lastUpdated: "2026-01-02T03:04:05.000Z",
      cachedFlantModels: ["gpt-5-4", "claude-opus-4-6"],
      cachedOpenRouterData: {
        "gpt-5-4": {
          name: "GPT 5.4",
          context_length: 123,
          max_completion_tokens: 45,
          pricing: { prompt: 1, completion: 2, cacheRead: 3, cacheWrite: 4 },
          modality: "text",
        },
      },
    });
  });

  it("saveFlantSettings and loadFlantSettings round-trip", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const settings = {
      enabled: true,
      autoUpdate: true,
      cacheTTLDays: 14,
      subscription: true,
      lastUpdated: "2026-02-01T00:00:00.000Z",
      cachedFlantModels: ["claude-opus-4-6", "gpt-5-4"],
      cachedOpenRouterData: {
        "claude-opus-4-6": {
          name: "Claude Opus 4.6",
          context_length: 200000,
          max_completion_tokens: 32000,
          pricing: { prompt: 0.01, completion: 0.02, cacheRead: 0.003, cacheWrite: 0.004 },
          modality: "text",
        },
      },
    };

    mod.saveFlantSettings(settings);

    const loaded = mod.loadFlantSettings();
    expect(loaded).toEqual(settings);
    expect(existsSync(join(dir, "extensions", "pp", "cache", "flant-models.json"))).toBe(true);
  });
});
