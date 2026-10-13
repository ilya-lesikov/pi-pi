import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig, type RoutingSettings } from "./config.js";

const refreshAnthropicTokenMock = vi.fn();
const refreshGitHubCopilotTokenMock = vi.fn();
vi.mock("@earendil-works/pi-ai/oauth", () => ({
  refreshAnthropicToken: (...args: unknown[]) => refreshAnthropicTokenMock(...args),
  refreshGitHubCopilotToken: (...args: unknown[]) => refreshGitHubCopilotTokenMock(...args),
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-flant-infra-"));
  tempDirs.push(dir);
  return dir;
}

// Durable provider policy lives in scoped config, not the cache file.
function writeGlobalProvidersConfig(agentDir: string, providers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const cfgDir = join(agentDir, "extensions", "pp");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ providers, ...extra }), "utf-8");
}

/** Default routing settings, optionally adjusted. */
function routing(mutate?: (s: RoutingSettings) => void): RoutingSettings {
  const defaults = getDefaultConfig();
  const s = structuredClone({ providers: defaults.providers, models: defaults.models }) as RoutingSettings;
  mutate?.(s);
  return s;
}

const gatewayRouteOnly = () => routing((s) => { s.providers["claude-sub"].route = ["llm-api"]; });
const directRouteOnly = () => routing((s) => { s.providers["claude-sub"].route = ["direct"]; });

function writeClaudeAuth(dir: string, access = "sk-ant-oat01-test-token") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth", access, expires: Date.now() + 3_600_000 } }),
    "utf-8",
  );
}

function recordingPi() {
  const registered = new Map<string, any>();
  const pi = {
    registered,
    registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
    unregisterProvider: vi.fn((name: string) => registered.delete(name)),
  } as any;
  return pi;
}

async function loadFlantInfraModule(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("./flant-infra.js");
}

// The ambient shell may carry a real gateway key; every test states its own.
const savedGatewayKeys = { LLM_API_KEY: process.env.LLM_API_KEY, FLANT_API_KEY: process.env.FLANT_API_KEY };
beforeEach(() => {
  delete process.env.LLM_API_KEY;
  delete process.env.FLANT_API_KEY;
});

afterEach(() => {
  refreshAnthropicTokenMock.mockReset();
  refreshGitHubCopilotTokenMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.COPILOT_GITHUB_TOKEN;
  for (const [key, value] of Object.entries(savedGatewayKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("flant-infra", () => {
  // A provider registered with a placeholder key showed up in the catalog and
  // won resolution, then failed every request on the missing key.
  it("registers no LLM API provider without a gateway key", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8", "gpt-5"], {});

    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("registers no LLM API provider when the provider is disabled, even with a key", async () => {
    const dir = makeTempDir();
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["gpt-5"], {}, { settings: routing((s) => { s.providers["llm-api"].enabled = false; }) });

    expect(pi.registered.has("pp-flant-openai")).toBe(false);
  });

  it("registerFlantProviders is idempotent across repeated calls", async () => {
    const dir = makeTempDir();
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);

    const registered = new Map<string, unknown>();
    const pi = {
      registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
      unregisterProvider: vi.fn((name: string) => registered.delete(name)),
    } as any;

    const models = ["claude-opus-4-6", "gpt-5"];
    mod.registerFlantProviders(pi, models, {});
    mod.registerFlantProviders(pi, models, {});

    expect(registered.size).toBe(1);
    expect([...registered.keys()]).toEqual(["pp-flant-openai"]);
  });

  it("asks the gateway to pin a session to one upstream", async () => {
    const dir = makeTempDir();
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);

    const registered = new Map<string, any>();
    const pi = {
      registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
      unregisterProvider: vi.fn((name: string) => registered.delete(name)),
    } as any;

    mod.registerFlantProviders(pi, ["gpt-5"], {});

    expect(registered.get("pp-flant-openai").models[0].compat).toMatchObject({
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
  });

  it("registers regular providers with the resolved gateway key", async () => {
    const dir = makeTempDir();
    const previousLlmKey = process.env.LLM_API_KEY;
    const previousFlantKey = process.env.FLANT_API_KEY;
    process.env.LLM_API_KEY = "llm-gateway-key";
    process.env.FLANT_API_KEY = "flant-gateway-key";
    try {
      const mod = await loadFlantInfraModule(dir);
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: unknown) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["claude-opus-4-8", "gpt-5"], {}, {
        settings: routing((s) => { s.providers["claude-sub"].enabled = false; }),
      });

      expect(registered.has("pp-flant-anthropic")).toBe(false);
      expect(registered.get("pp-flant-openai").apiKey).toBe("llm-gateway-key");
    } finally {
      if (previousLlmKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previousLlmKey;
      if (previousFlantKey === undefined) delete process.env.FLANT_API_KEY;
      else process.env.FLANT_API_KEY = previousFlantKey;
    }
  });

  it("does not register the sub providers when the subscription is disabled", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["claude-opus-4-8", "gpt-5"], {}, {
      settings: routing((s) => { s.providers["claude-sub"].enabled = false; }),
    });
    expect([...pi.registered.keys()]).toEqual(["pp-flant-openai"]);
  });

  it("registers both subscription routes by default", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8", "gpt-5"], {});

    expect([...pi.registered.keys()].sort()).toEqual(["pp-claude-sub", "pp-flant-anthropic-sub", "pp-flant-openai"]);
  });

  it("registers the direct route against Anthropic with bare ids and no gateway header", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8", "claude-haiku-4-5", "gpt-5"], {}, { settings: directRouteOnly() });

    expect(pi.registered.has("pp-flant-anthropic-sub")).toBe(false);
    const direct = pi.registered.get("pp-claude-sub");
    expect(direct.api).toBe("anthropic-messages");
    expect(direct.baseUrl).toBe("https://api.anthropic.com");
    expect(direct.apiKey).toBe("sk-ant-oat01-test-token");
    expect(Object.keys(direct.headers)).toEqual(["user-agent"]);
    expect(direct.headers["user-agent"]).toMatch(/^claude-cli\/[0-9.]+ \(external, /);
    expect(direct.models.map((m: any) => m.id).sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
  });

  it("registers the direct route without any gateway key, from pi's own Claude catalog", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    const mod = await loadFlantInfraModule(dir);
    mod.setModelRegistry({
      getApiKeyForProvider: async () => undefined,
      find: () => undefined,
      getAll: () => [
        { provider: "anthropic", id: "claude-opus-5" },
        { provider: "anthropic", id: "claude-fable-5-1" },
        { provider: "openai", id: "gpt-5" },
      ],
    });
    const pi = recordingPi();

    mod.registerFlantProviders(pi, [], {}, { settings: directRouteOnly() });

    expect([...pi.registered.keys()]).toEqual(["pp-claude-sub"]);
    expect(pi.registered.get("pp-claude-sub").models.map((m: any) => m.id).sort()).toEqual(["claude-fable-5-1", "claude-opus-5"]);
  });

  it("registers only the direct route under the default route order when no gateway key is set", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8", "gpt-5"], {});

    expect([...pi.registered.keys()]).toEqual(["pp-claude-sub"]);
  });

  it("registers only the gateway route when the route excludes direct", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8"], {}, { settings: gatewayRouteOnly() });

    expect(pi.registered.has("pp-claude-sub")).toBe(false);
    expect(pi.registered.get("pp-flant-anthropic-sub").models.map((m: any) => m.id)).toEqual(["sub/claude-opus-4-8"]);
  });

  // A Claude override takes the family elsewhere: with no role pinning a
  // subscription model, nothing routes onto it, so nothing should refresh or
  // probe its credential.
  it("leaves both sub providers unregistered under a Claude override with no pinned sub spec", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const settings = routing((s) => {
      s.models.claude.override = { provider: "github-copilot", model: "claude-opus-5" };
    });
    expect(mod.isClaudeSubInUse(settings)).toBe(false);
    expect(mod.isClaudeSubInUse(settings, ["github-copilot/claude-opus-5"])).toBe(false);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8", "gpt-5"], {}, { settings });

    expect([...pi.registered.keys()]).toEqual(["pp-flant-openai"]);
    await mod.refreshSubProvider(pi);
    expect(pi.registered.has("pp-flant-anthropic-sub")).toBe(false);
    expect(pi.registered.has("pp-claude-sub")).toBe(false);
  });

  it("keeps the subscription registered under a Claude override when a role pins a sub spec", async () => {
    const dir = makeTempDir();
    writeClaudeAuth(dir);
    process.env.LLM_API_KEY = "sk-gateway-test";
    const mod = await loadFlantInfraModule(dir);
    const settings = routing((s) => {
      s.models.claude.override = { provider: "github-copilot", model: "claude-opus-5" };
    });
    expect(mod.isClaudeSubInUse(settings, ["pp-claude-sub/claude-opus-4-8"])).toBe(true);
    expect(mod.isClaudeSubInUse(settings, ["pp-flant-anthropic-sub/sub/claude-opus-4-8"])).toBe(true);
    expect(mod.isClaudeSubInUse(routing((s) => { s.providers["claude-sub"].enabled = false; }))).toBe(false);
    expect(mod.isClaudeSubInUse(routing())).toBe(true);
    const pi = recordingPi();

    mod.registerFlantProviders(pi, ["sub/claude-opus-4-8"], {}, { settings, pinnedSpecs: ["pp-claude-sub/claude-opus-4-8"] });

    expect(pi.registered.has("pp-claude-sub")).toBe(true);
    expect(pi.registered.has("pp-flant-anthropic-sub")).toBe(true);
  });

  it("hasClaudeSubCredential counts an expired login but not a missing one", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    expect(mod.hasClaudeSubCredential()).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { access: "sk-ant-oat01-old", expires: Date.now() - 1000 } }), "utf-8");
    expect(mod.hasClaudeSubCredential()).toBe(true);
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

      mod.registerFlantProviders(pi, ["claude-opus-4-8", "claude-haiku-4-5", "gpt-5"], {}, { settings: gatewayRouteOnly() });

      expect([...registered.keys()].sort()).toEqual(["pp-flant-anthropic-sub", "pp-flant-openai"]);
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

  it("registers every catalog Claude id on the sub provider and keeps sub/ ids off the openai provider", async () => {
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

      mod.registerFlantProviders(
        pi,
        ["claude-opus-4-8", "claude-fable-5", "sub/claude-opus-4-8", "gpt-5"],
        {},
        {},
      );

      const sub = registered.get("pp-flant-anthropic-sub");
      expect(sub.models.map((m: any) => m.id).sort()).toEqual(["sub/claude-fable-5", "sub/claude-opus-4-8"]);
      expect(registered.has("pp-flant-anthropic")).toBe(false);
      const openai = registered.get("pp-flant-openai");
      expect(openai.models.map((m: any) => m.id)).toEqual(["gpt-5"]);
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("registers sub models with their real context window instead of the fallback", async () => {
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

      mod.registerFlantProviders(
        pi,
        ["sub/claude-fable-5-1"],
        {
          "claude-fable-5-1": {
            name: "Claude Fable 5.1",
            context_length: 1_000_000,
            max_completion_tokens: 128_000,
            pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
            modality: "text",
          },
        },
        {},
      );

      const sub = registered.get("pp-flant-anthropic-sub");
      expect(sub.models[0]).toMatchObject({ id: "sub/claude-fable-5-1", contextWindow: 1_000_000, maxTokens: 128_000 });
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("takes the window from pi's catalog when the gateway's metadata has none", async () => {
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
      mod.setModelRegistry({
        getApiKeyForProvider: async () => undefined,
        find: (provider: string, modelId: string) =>
          provider === "anthropic" && modelId === "claude-opus-5"
            ? { contextWindow: 1_000_000, maxTokens: 128_000 }
            : undefined,
      });
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["sub/claude-opus-5"], {});

      expect(registered.get("pp-flant-anthropic-sub").models[0]).toMatchObject({
        id: "sub/claude-opus-5",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("carries pi's claude capabilities onto the sub models, minus the unusable fallback list", async () => {
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
      mod.setModelRegistry({
        getApiKeyForProvider: async () => undefined,
        find: (provider: string, modelId: string) =>
          provider === "anthropic" && modelId === "claude-opus-5"
            ? {
                compat: {
                  forceAdaptiveThinking: true,
                  supportsTemperature: false,
                  supportsMidConvoEffort: true,
                  allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-4-8" }],
                },
                thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
              }
            : undefined,
      });
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["sub/claude-opus-5"], {});

      const model = registered.get("pp-flant-anthropic-sub").models[0];
      expect(model.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoEffort: true });
      expect(model.compat).not.toHaveProperty("allowedFallbackModels");
      expect(model.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("omits compat entirely when the only inherited setting is the unusable fallback list", async () => {
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
      mod.setModelRegistry({
        getApiKeyForProvider: async () => undefined,
        find: (provider: string, modelId: string) =>
          provider === "anthropic" && modelId === "claude-fable-5-1"
            ? { compat: { allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-4-8" }] } }
            : undefined,
      });
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["sub/claude-fable-5-1"], {});

      const model = registered.get("pp-flant-anthropic-sub").models[0];
      expect(model.id).toBe("sub/claude-fable-5-1");
      expect(model).not.toHaveProperty("compat");
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("leaves sub models untouched when pi's catalog does not know the claude id", async () => {
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
      mod.setModelRegistry({ getApiKeyForProvider: async () => undefined, find: () => undefined });
      const registered = new Map<string, any>();
      const pi = {
        registerProvider: vi.fn((name: string, config: any) => registered.set(name, config)),
        unregisterProvider: vi.fn((name: string) => registered.delete(name)),
      } as any;

      mod.registerFlantProviders(pi, ["sub/claude-unreleased-9"], {});

      const model = registered.get("pp-flant-anthropic-sub").models[0];
      expect(model.id).toBe("sub/claude-unreleased-9");
      expect(model.compat).toBeUndefined();
      expect(model.thinkingLevelMap).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  it("falls back to all claude models for the sub provider when the model list has no sub/ ids", async () => {
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

      mod.registerFlantProviders(pi, ["claude-opus-4-8", "claude-haiku-4-5", "gpt-5"], {});

      const sub = registered.get("pp-flant-anthropic-sub");
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

      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {});
      expect(registered.has("pp-flant-anthropic-sub")).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevKey;
    }
  });

  // pi restores the session's model from what extensions registered at load
  // time, before anything can refresh the token. Skipping registration there
  // drops every sub/ model from the catalog and the session lands on an
  // unrelated model with a "could not restore" warning.
  it("registers the sub provider with an expired token so the catalog is complete", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-expired", refresh: "rt", expires: Date.now() - 1000 } }),
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

      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {});

      const sub = registered.get("pp-flant-anthropic-sub");
      expect(sub.apiKey).toBe("sk-ant-oat01-expired");
      expect(sub.models.map((m: any) => m.id)).toEqual(["sub/claude-opus-4-8"]);

      // The stale registration is replaced as soon as a refresh succeeds.
      refreshAnthropicTokenMock.mockResolvedValueOnce({ access: "sk-ant-oat01-rotated", refresh: "rt2", expires: Date.now() + 3_600_000 });
      await mod.refreshSubProvider(pi);
      expect(registered.get("pp-flant-anthropic-sub").apiKey).toBe("sk-ant-oat01-rotated");
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
      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {});
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

  it("refreshSubProvider unregisters the sub provider when the token is gone", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-live", refresh: "rt", expires: Date.now() + 3_600_000 } }),
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
      mod.registerFlantProviders(pi, ["claude-opus-4-8"], {});
      expect(registered.has("pp-flant-anthropic-sub")).toBe(true);

      // Credentials revoked: the refresh cannot mint a token any more.
      writeFileSync(authPath, JSON.stringify({}), "utf-8");
      await mod.refreshSubProvider(pi);

      // Leaving it registered would keep the now-dead token as a literal apiKey.
      expect(registered.has("pp-flant-anthropic-sub")).toBe(false);
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

  it("activates the Copilot tier from OAuth credentials created by /login", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "github-copilot": { type: "oauth", access: "tid=test;exp=1", refresh: "ghu_test", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);

    expect(mod.readCopilotOAuthToken()).toBe("tid=test;exp=1");
    expect(mod.isCopilotActive(routing())).toBe(true);
  });

  it("refreshes expired Copilot OAuth credentials and persists them for pi", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ "github-copilot": { type: "oauth", access: "expired", refresh: "ghu_refresh", expires: Date.now() - 1, enterpriseUrl: "github.example.com" } }),
      "utf-8",
    );
    refreshGitHubCopilotTokenMock.mockResolvedValue({
      access: "tid=fresh;exp=2",
      refresh: "ghu_refresh",
      expires: Date.now() + 3_600_000,
      enterpriseUrl: "github.example.com",
    });
    const mod = await loadFlantInfraModule(dir);

    await expect(mod.refreshCopilotOAuthToken()).resolves.toBe("tid=fresh;exp=2");
    expect(refreshGitHubCopilotTokenMock).toHaveBeenCalledWith("ghu_refresh", "github.example.com");
    expect(JSON.parse(readFileSync(authPath, "utf-8"))["github-copilot"].access).toBe("tid=fresh;exp=2");
    expect(mod.isCopilotActive(routing())).toBe(true);
  });

  it("activates the ChatGPT tier from a live OAuth credential", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);

    expect(mod.readCodexOAuthToken()).toBe("codex-access");
    expect(mod.isCodexActive(routing())).toBe(true);
  });

  // Disabling the tier here would route the work elsewhere, so the request
  // that renews the token would never be made and the login would never come
  // back on its own.
  it("keeps the ChatGPT tier active on an expired access token that still has a refresh token", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "stale", refresh: "codex-refresh", expires: Date.now() - 1 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);

    expect(mod.readCodexOAuthToken()).toBeNull();
    expect(mod.isCodexActive(routing())).toBe(true);
  });

  it("deactivates the ChatGPT tier when the expired credential cannot be renewed", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "stale", expires: Date.now() - 1 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);

    expect(mod.isCodexActive(routing())).toBe(false);
    await expect(mod.refreshCodexOAuthToken()).resolves.toBeNull();
  });

  it("renews an expired ChatGPT credential through pi's registry", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": { type: "oauth", access: "stale", refresh: "codex-refresh", expires: Date.now() - 1 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);
    mod.setModelRegistry({
      getApiKeyForProvider: async (provider: string) => {
        expect(provider).toBe("openai-codex");
        writeFileSync(
          authPath,
          JSON.stringify({ "openai-codex": { type: "oauth", access: "fresh", refresh: "codex-refresh", expires: Date.now() + 3_600_000 } }),
          "utf-8",
        );
        return "fresh";
      },
    });

    await expect(mod.refreshCodexOAuthToken()).resolves.toBe("fresh");
    expect(mod.readCodexOAuthToken()).toBe("fresh");
  });

  it("keeps supporting COPILOT_GITHUB_TOKEN for the Copilot tier", async () => {
    const dir = makeTempDir();
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_test";
    const mod = await loadFlantInfraModule(dir);

    expect(mod.isCopilotActive(routing())).toBe(true);
    expect(mod.isCopilotActive(routing((s) => { s.providers.copilot.enabled = false; }))).toBe(false);
  });

  it("isCodexActive is false when the provider is disabled despite a live login", async () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "codex-access", expires: Date.now() + 3_600_000 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);
    expect(mod.isCodexActive(routing((s) => { s.providers.codex.enabled = false; }))).toBe(false);
  });

  it("loadLlmApiCache returns an empty cache when the file is missing", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);

    expect(mod.loadLlmApiCache()).toEqual({
      lastUpdated: null,
      cachedFlantModels: null,
      cachedOpenRouterData: null,
      unmappedModels: null,
    });
  });

  it("loadLlmApiCache reads only cache fields and drops malformed entries", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const metadata = {
      "gpt-5-4": {
        name: "GPT 5.4",
        context_length: 123,
        max_completion_tokens: 45,
        pricing: { prompt: 1, completion: 2, cacheRead: 3, cacheWrite: 4 },
        modality: "text",
      },
    };
    writeFileSync(
      join(cacheDir, "flant-models.json"),
      JSON.stringify({
        // A legacy cache still carrying durable policy: ignored here.
        enabled: true,
        switchBackIntervalMinutes: 30,
        lastUpdated: "2026-01-02T03:04:05.000Z",
        cachedFlantModels: ["gpt-5-4", 123, "claude-opus-4-6"],
        cachedOpenRouterData: metadata,
        unmappedModels: { "qwen3": "qwen/qwen-3" },
      }),
      "utf-8",
    );

    expect(mod.loadLlmApiCache()).toEqual({
      lastUpdated: "2026-01-02T03:04:05.000Z",
      cachedFlantModels: ["gpt-5-4", "claude-opus-4-6"],
      cachedOpenRouterData: metadata,
      unmappedModels: { "qwen3": "qwen/qwen-3" },
    });
  });

  it("loadLlmApiCache treats an unparsable cache as empty", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "flant-models.json"), "{\"cachedFlantModels\": [", "utf-8");
    expect(mod.loadLlmApiCache().cachedFlantModels).toBeNull();
  });

  it("loadRoutingSettings returns the provider defaults when no config exists", async () => {
    const dir = makeTempDir();
    const mod = await loadFlantInfraModule(dir);
    const settings = mod.loadRoutingSettings();
    expect(settings.providers["claude-sub"]).toEqual({ enabled: true, route: ["llm-api", "direct"] });
    expect(settings.providers["llm-api"]).toEqual({ enabled: true, autoUpdate: true, cacheTTLDays: 3 });
    expect(settings.providers.fallback).toEqual({ auto: true, retryAfterMinutes: 10 });
    expect(settings.models.claude.override).toBeNull();
  });

  it("loadRoutingSettings reads the providers section and binds the project layer through cwd", async () => {
    const dir = makeTempDir();
    writeGlobalProvidersConfig(dir, { "llm-api": { cacheTTLDays: 14 }, fallback: { retryAfterMinutes: 30 } });
    const projCwd = makeTempDir();
    mkdirSync(join(projCwd, ".pp"), { recursive: true });
    writeFileSync(join(projCwd, ".pp", "config.json"), JSON.stringify({ providers: { "claude-sub": { route: ["direct"] } } }), "utf-8");
    const mod = await loadFlantInfraModule(dir);

    const global = mod.loadRoutingSettings();
    expect(global.providers["llm-api"].cacheTTLDays).toBe(14);
    expect(global.providers.fallback.retryAfterMinutes).toBe(30);
    expect(global.providers["claude-sub"].route).toEqual(["llm-api", "direct"]);

    const scoped = mod.loadRoutingSettings(projCwd);
    expect(scoped.providers["claude-sub"].route).toEqual(["direct"]);
    expect(scoped.providers["llm-api"].cacheTTLDays).toBe(14);
  });

  it("loadRoutingSettings still honours a legacy flant section in memory", async () => {
    const dir = makeTempDir();
    const cfgDir = join(dir, "extensions", "pp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ flant: { enabled: false, subscription: true, switchBackIntervalMinutes: 45, cacheTTLDays: 9 } }),
      "utf-8",
    );
    const mod = await loadFlantInfraModule(dir);

    const settings = mod.loadRoutingSettings();
    expect(settings.providers["llm-api"].enabled).toBe(false);
    expect(settings.providers["llm-api"].cacheTTLDays).toBe(9);
    expect(settings.providers["claude-sub"]).toEqual({ enabled: true, route: ["direct"] });
    expect(settings.providers.fallback.retryAfterMinutes).toBe(45);
  });

  it("wiping the cache file does not change any durable setting", async () => {
    const dir = makeTempDir();
    writeGlobalProvidersConfig(dir, { "claude-sub": { route: ["direct"] }, fallback: { retryAfterMinutes: 30 } });
    const cacheDir = join(dir, "extensions", "pp", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "flant-models.json"), JSON.stringify({ cachedFlantModels: ["gpt-5-4"] }), "utf-8");
    const mod = await loadFlantInfraModule(dir);

    rmSync(join(cacheDir, "flant-models.json"), { force: true });
    const settings = mod.loadRoutingSettings();
    expect(settings.providers["claude-sub"].route).toEqual(["direct"]);
    expect(settings.providers.fallback.retryAfterMinutes).toBe(30);
    expect(mod.loadLlmApiCache().cachedFlantModels).toBeNull();
  });
});
