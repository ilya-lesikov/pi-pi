import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshAnthropicTokenMock = vi.fn();
vi.mock("@earendil-works/pi-ai/oauth", () => ({
  refreshAnthropicToken: (...args: unknown[]) => refreshAnthropicTokenMock(...args),
}));

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
  refreshAnthropicTokenMock.mockReset();
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

  it("refreshSubProvider re-registers the sub provider when the token changes", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    // Start with an expired token that has a refresh token available.
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", refresh: "rt-old", expires: Date.now() - 1000 } }),
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

      // Refresh yields a fresh token, which is what the initial registration reads.
      refreshAnthropicTokenMock.mockResolvedValueOnce({ access: "sk-ant-oat01-fresh", refresh: "rt-fresh", expires: Date.now() + 3_600_000 });
      await mod.refreshClaudeOAuthToken();
      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {}, { subscription: true });
      expect(registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-fresh");

      // A no-op refresh (token unchanged) must not re-register.
      const callsBefore = pi.registerProvider.mock.calls.length;
      await mod.refreshSubProvider(pi);
      expect(pi.registerProvider.mock.calls.length).toBe(callsBefore);

      // Simulate the token expiring and a refresh minting a new one: the sub
      // provider is re-registered with the new token.
      writeFileSync(
        authPath,
        JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-expired", refresh: "rt-fresh", expires: Date.now() - 1000 } }),
        "utf-8",
      );
      refreshAnthropicTokenMock.mockResolvedValueOnce({ access: "sk-ant-oat01-rotated", refresh: "rt-rotated", expires: Date.now() + 3_600_000 });
      await mod.refreshSubProvider(pi);
      expect(registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-rotated");
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("refreshSubProvider is a no-op when subscription routing is inactive", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const pi = {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
    } as any;
    // No registerFlantProviders({ subscription: true }) call happened, so there
    // is no cached sub-provider context: refresh must do nothing.
    await mod.refreshSubProvider(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
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

  it("refreshClaudeOAuthToken returns the current token when not expired", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-fresh", refresh: "rt", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBe("sk-ant-oat01-fresh");
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });

  it("refreshClaudeOAuthToken refreshes an expired token and persists it", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", refresh: "rt-old", expires: Date.now() - 1000 } }),
      "utf-8",
    );
    const newExpires = Date.now() + 3_600_000;
    refreshAnthropicTokenMock.mockResolvedValue({ access: "sk-ant-oat01-new", refresh: "rt-new", expires: newExpires });

    const mod = await loadFlantInfraModule(dir);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBe("sk-ant-oat01-new");
    expect(refreshAnthropicTokenMock).toHaveBeenCalledWith("rt-old");

    const persisted = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(persisted.anthropic).toMatchObject({
      type: "oauth",
      access: "sk-ant-oat01-new",
      refresh: "rt-new",
      expires: newExpires,
    });
    // A subsequent synchronous read now sees the fresh token.
    expect(mod.readClaudeOAuthToken()).toBe("sk-ant-oat01-new");
  });

  it("refreshClaudeOAuthToken returns null when expired and no refresh token present", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", expires: Date.now() - 1000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBeNull();
    expect(refreshAnthropicTokenMock).not.toHaveBeenCalled();
  });

  it("refreshClaudeOAuthToken returns null when refresh fails", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-old", refresh: "rt-old", expires: Date.now() - 1000 } }),
      "utf-8",
    );
    refreshAnthropicTokenMock.mockRejectedValue(new Error("refresh boom"));
    const mod = await loadFlantInfraModule(dir);
    await expect(mod.refreshClaudeOAuthToken()).resolves.toBeNull();
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

  it("generateFlantConfig routes Claude roles through subs when subscription active", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const config = mod.generateFlantConfig(
      ["claude-opus-4-8", "claude-haiku-4-5", "gpt-5-4", "gemini-3-1-pro", "gemini-3-1-flash"],
      true,
    ) as any;

    // Claude roles -> sub provider
    expect(config.agents.orchestrators.implement.model).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(config.agents.orchestrators.plan.model).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(config.agents.orchestrators.brainstorm.model).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(config.agents.subagents.simple.task.model).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.opus.model).toBe("pp-flant-anthropic-sub/sub/claude-opus-4-8");
    // Non-Claude roles stay on the openai (company-billed) provider
    expect(config.agents.orchestrators.debug.model).toBe("pp-flant-openai/gpt-5-4");
    expect(config.agents.subagents.simple.explore.model).toBe("pp-flant-openai/gemini-3-1-flash");
    expect(config.agents.subagents.presetGroups.planners.presets.regular.agents.gpt.model).toBe("pp-flant-openai/gpt-5-4");
  });

  it("generateFlantConfig keeps Claude roles on the company provider when subscription inactive", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    const config = mod.generateFlantConfig(["claude-opus-4-8", "gpt-5-4"], false) as any;
    expect(config.agents.orchestrators.implement.model).toBe("pp-flant-anthropic/claude-opus-4-8");
  });

  it("isSubscriptionActive requires flag + oauth token + gateway key", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { access: "sk-ant-oat01-test", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const settingsDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "flant-models.json"), JSON.stringify({ enabled: true, subscription: true }), "utf-8");
    const prevKey = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "sk-gateway-test";
    try {
      const mod = await loadFlantInfraModule(dir);
      expect(mod.isSubscriptionActive()).toBe(true);
      expect(mod.isSubscriptionActive({ subscription: false } as any)).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("isSubscriptionActive is false without a gateway key", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { access: "sk-ant-oat01-test", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const prevKey = process.env.LLM_API_KEY;
    const prevFlant = process.env.FLANT_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.FLANT_API_KEY;
    try {
      const mod = await loadFlantInfraModule(dir);
      expect(mod.isSubscriptionActive({ subscription: true } as any)).toBe(false);
    } finally {
      if (prevKey !== undefined) process.env.LLM_API_KEY = prevKey;
      if (prevFlant !== undefined) process.env.FLANT_API_KEY = prevFlant;
    }
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
      switchBackIntervalMinutes: 30,
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
      switchBackIntervalMinutes: 30,
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
      switchBackIntervalMinutes: 30,
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

  it("normalizes switchBackIntervalMinutes: default when missing, parsed, floored to >=1", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const settingsDir = join(dir, "extensions", "pp", "cache");
    const settingsPath = join(settingsDir, "flant-models.json");
    mkdirSync(settingsDir, { recursive: true });

    // Missing -> default 30.
    writeFileSync(settingsPath, JSON.stringify({ enabled: true }), "utf-8");
    expect(mod.loadFlantSettings().switchBackIntervalMinutes).toBe(30);

    // String numeric -> parsed and rounded.
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, switchBackIntervalMinutes: "45" }), "utf-8");
    expect(mod.loadFlantSettings().switchBackIntervalMinutes).toBe(45);

    // Invalid / <1 -> floored to 1.
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, switchBackIntervalMinutes: 0 }), "utf-8");
    expect(mod.loadFlantSettings().switchBackIntervalMinutes).toBe(1);
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, switchBackIntervalMinutes: "nonsense" }), "utf-8");
    expect(mod.loadFlantSettings().switchBackIntervalMinutes).toBe(30);
  });
});
