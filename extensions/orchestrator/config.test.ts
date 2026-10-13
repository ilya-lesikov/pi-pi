import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { deepMerge, getDefaultConfig, loadConfig, mergeConfigLayers, migrateConfigFile, readRawConfig, readScopedRoutingSettings, removeConfigValue, validateConfig, writeConfigValue } from "./config.js";
import { migrateConfigLayer, migrateModelRef } from "./config-migration.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deepMerge", () => {
  it("merges nested objects while replacing arrays and nulls", () => {
    const target = {
      nested: { left: 1, keep: true },
      arr: [1, 2, 3],
      nullable: "value",
      emptyObjectTarget: { keep: "yes" },
    };

    const source = {
      nested: { right: 2 },
      arr: [99],
      nullable: null,
      emptyObjectTarget: {},
    };

    const merged = deepMerge(target, source);

    expect(merged).toEqual({
      nested: { left: 1, keep: true, right: 2 },
      arr: [99],
      nullable: null,
      emptyObjectTarget: { keep: "yes" },
    });
  });
});

describe("validateConfig", () => {
  it("throws for empty main agent model string", () => {
    expect(() => validateConfig({ agents: { main: { model: "", thinking: "high" } } })).toThrow(
      "config.agents.main.model must be a non-empty string",
    );
  });

  it("rejects a turn limit on the main agent", () => {
    expect(() => validateConfig({ agents: { main: { model: "x/y", thinking: "high", maxTurns: 5 } } })).toThrow(
      "config.agents.main.maxTurns is not supported",
    );
  });

  it("throws for an invalid logLevel and tracing value", () => {
    expect(() => validateConfig({ general: { logLevel: "loud" } })).toThrow("config.general.logLevel");
    expect(() => validateConfig({ general: { tracing: "yes" } as any })).toThrow("config.general.tracing");
  });

  it("defaults promptcap to enabled with no declared sizes, and accepts an override", () => {
    const d = getDefaultConfig();
    expect(d.promptcap).toEqual({ enabled: true, perModel: {} });
    expect(() =>
      validateConfig({ promptcap: { enabled: false, maxPromptTokens: 200000, perModel: { "gpt-5.6-sol": { contextWindow: 400000 } } } }),
    ).not.toThrow();
  });

  it("rejects an out-of-range promptcap size", () => {
    expect(() => validateConfig({ promptcap: { maxPromptTokens: 10 } })).toThrow("config.promptcap.maxPromptTokens");
    expect(() => validateConfig({ promptcap: { contextWindow: 10 } })).toThrow("config.promptcap.contextWindow");
    expect(() => validateConfig({ promptcap: { perModel: { m: { maxPromptTokens: 1 } } } })).toThrow("config.promptcap.perModel.m.maxPromptTokens");
  });

  it("defaults every provider on, in subscription-first order, and validates the sections", () => {
    const d = getDefaultConfig();
    expect(d.providers.order).toEqual(["claude-sub", "codex", "copilot", "llm-api"]);
    expect(d.providers["claude-sub"]).toEqual({ enabled: true, route: ["llm-api", "direct"] });
    expect(d.providers.fallback).toEqual({ auto: true, retryAfterMinutes: 10 });
    expect(d.models.claude).toEqual({ override: null, pins: {} });
    expect(() => validateConfig({ providers: { order: ["copilot", "claude-sub"] } })).not.toThrow();
    expect(() => validateConfig({ providers: { order: ["copilot", "copilot"] } })).toThrow("config.providers.order");
    expect(() => validateConfig({ providers: { order: ["bogus"] } })).toThrow("config.providers.order");
    expect(() => validateConfig({ providers: { "claude-sub": { route: [] } } })).toThrow("config.providers.claude-sub.route");
    expect(() => validateConfig({ providers: { fallback: { retryAfterMinutes: 0 } } })).toThrow("config.providers.fallback.retryAfterMinutes");
    expect(() => validateConfig({ models: { claude: { override: { provider: "zai", model: "glm-5.3", slots: { opus: "glm-5.3" } } } } })).not.toThrow();
    expect(() => validateConfig({ models: { claude: { override: { provider: "zai", model: "glm-5.3", slots: { astra: "x" } } } } })).toThrow("not a claude slot");
    expect(() => validateConfig({ models: { claude: { override: { provider: "zai/x", model: "glm" } } } })).toThrow("provider name");
    expect(() => validateConfig({ models: { gemini: {} } })).toThrow("not a family");
  });

  it("defaults contextInjection with all six toggles on and validates toggles", () => {
    const d = getDefaultConfig();
    expect(d.contextInjection).toEqual({
      globalAgents: true, globalClaude: true,
      ancestorAgents: true, ancestorClaude: true,
      projectAgents: true, projectClaude: true,
    });
    expect(() => validateConfig({ contextInjection: { globalClaude: "yes" } as any })).toThrow("config.contextInjection.globalClaude");
  });

  it("defaults skills to discovery-on for all three layers and validates its shape", () => {
    const d = getDefaultConfig();
    expect(d.skills).toEqual({ loadBundled: true, loadGlobal: true, loadProject: true });
    expect(() => validateConfig({ skills: { loadBundled: false, loadGlobal: false, loadProject: true } })).not.toThrow();
    expect(() => validateConfig({ skills: { loadBundled: "yes" } as any })).toThrow("config.skills.loadBundled");
    expect(() => validateConfig({ skills: { loadProject: 1 } as any })).toThrow("config.skills.loadProject");
  });

  it("round-trips the promptcap section through deep-merge", () => {
    const merged = deepMerge(getDefaultConfig() as any, { promptcap: { maxPromptTokens: 250000 } });
    expect(merged.promptcap.maxPromptTokens).toBe(250000);
    expect(merged.promptcap.enabled).toBe(true);
  });

  it("accepts a valid partial config", () => {
    expect(() =>
      validateConfig({
        general: { logLevel: "debug", tracing: true },
        agents: { main: { model: "provider/model", thinking: "xhigh" } },
        performance: { internals: { subagentStale: "30s" } },
      }),
    ).not.toThrow();
  });

  it("rejects invalid maxConcurrentSubagents values", () => {
    for (const bad of [0, -1, 1.5, 1025, "7"]) {
      expect(() => validateConfig({ agents: { maxConcurrentSubagents: bad } as any })).toThrow(
        "config.agents.maxConcurrentSubagents must be an integer between 1 and 1024",
      );
    }
  });

  it("accepts valid maxConcurrentSubagents values", () => {
    for (const good of [1, 7, 1024]) {
      expect(() => validateConfig({ agents: { maxConcurrentSubagents: good } })).not.toThrow();
    }
  });

  it("no longer knows about removed sections", () => {
    const d = getDefaultConfig() as Record<string, any>;
    expect(d.agents.orchestrators).toBeUndefined();
    expect(d.agents.subagents.presetGroups).toBeUndefined();
    expect(d.commands.afterImplement).toBeUndefined();
    expect(d.performance.commands.afterImplement).toBeUndefined();
    expect(d.performance.internals.taskLockStale).toBeUndefined();
    expect(d.performance.internals.taskLockRefresh).toBeUndefined();
    expect((d.skills as Record<string, unknown>).disabled).toBeUndefined();
  });

  it("validates afterEdit command entries", () => {
    expect(() => validateConfig({ commands: { afterEdit: { fmt: { run: "prettier -w ${file}", globs: ["*.ts"], enabled: true } } } })).not.toThrow();
    expect(() => validateConfig({ commands: { afterEdit: { fmt: { run: "" } } } })).toThrow();
    expect(() => validateConfig({ commands: { afterEdit: { fmt: { run: "x", globs: [""] } } } })).toThrow();
    // A single layer may carry only the leaf it overrides; `run` is required on
    // the merged result, so the /pp menu can scope globs/enabled per project.
    expect(() => validateConfig({ commands: { afterEdit: { fmt: { globs: ["*.ts"] } } } })).not.toThrow();
    expect(() => mergeConfigLayers({ commands: { afterEdit: { fmt: { run: "prettier -w ${file}" } } } }, { commands: { afterEdit: { fmt: { globs: ["*.ts"] } } } })).not.toThrow();
    expect(() => mergeConfigLayers(null, { commands: { afterEdit: { fmt: { globs: ["*.ts"] } } } })).toThrow(/afterEdit.fmt.run/);
    expect(() => validateConfig({ performance: { commands: { afterEdit: "30s" } } })).not.toThrow();
    expect(() => validateConfig({ performance: { commands: { afterEdit: "bogus" } } })).toThrow();
  });
});

describe("readScopedRoutingSettings", () => {
  it("returns defaults with no files and creates NO .pp directory", () => {
    const cwd = makeTempDir();
    const s = readScopedRoutingSettings(cwd, "/nonexistent/global/config.json");
    expect(s.providers).toEqual(getDefaultConfig().providers);
    expect(existsSync(join(cwd, ".pp"))).toBe(false);
  });

  it("folds global then project (project wins), reading legacy flant keys migrated", () => {
    const globalDir = makeTempDir();
    const globalPath = join(globalDir, "global-config.json");
    writeFileSync(globalPath, JSON.stringify({ flant: { copilotEnabled: false, switchBackIntervalMinutes: 30 } }), "utf-8");
    const cwd = makeTempDir();
    const globalOnly = readScopedRoutingSettings(cwd, globalPath);
    expect(globalOnly.providers.copilot.enabled).toBe(false);
    expect(globalOnly.providers.fallback.retryAfterMinutes).toBe(30);
    expect(existsSync(join(cwd, ".pp"))).toBe(false);

    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ providers: { fallback: { retryAfterMinutes: 5 } } }), "utf-8");
    const merged = readScopedRoutingSettings(cwd, globalPath);
    expect(merged.providers.copilot.enabled).toBe(false);
    expect(merged.providers.fallback.retryAfterMinutes).toBe(5);
  });
});

describe("family override layering", () => {
  it("replaces a lower layer's override whole, and null cancels it", () => {
    const global = { models: { claude: { override: { provider: "zai", model: "glm-5.3", slots: { haiku: "glm-5.3-flash" } } } } };
    const replaced = mergeConfigLayers(global, { models: { claude: { override: { provider: "kimi-coding", model: "kimi-k3" } } } });
    expect(replaced.models.claude.override).toEqual({ provider: "kimi-coding", model: "kimi-k3" });
    const cancelled = mergeConfigLayers(global, { models: { claude: { override: null } } });
    expect(cancelled.models.claude.override).toBeNull();
    expect(mergeConfigLayers(global, null).models.claude.override).toEqual(global.models.claude.override);
  });

  it("ranks a provider an order list leaves out last, rather than dropping it", () => {
    expect(mergeConfigLayers({ providers: { order: ["copilot", "codex"] } }, null).providers.order).toEqual(["copilot", "codex", "claude-sub", "llm-api"]);
  });
});

describe("migration from the provider-tier schema", () => {
  it("maps model lines the old resolver moved between tiers onto slots, and keeps real pins", () => {
    expect(migrateModelRef("pp-flant-anthropic-sub/sub/claude-opus-5-5")).toBe("claude/opus");
    expect(migrateModelRef("pp-flant-openai/gpt-6-astra-pro")).toBe("gpt/astra:pro");
    expect(migrateModelRef("anthropic/claude-fable-latest")).toBe("claude/fable");
    expect(migrateModelRef("openai/gpt-luna-latest")).toBe("gpt/luna");
    expect(migrateModelRef("pp-flant-anthropic/claude-haiku-latest")).toBe("claude/haiku");
    expect(migrateModelRef("github-copilot/claude-opus-4.8")).toBe("github-copilot/claude-opus-4.8");
    expect(migrateModelRef("openai-codex/gpt-6-astra")).toBe("openai-codex/gpt-6-astra");
    expect(migrateModelRef("pp-flant-openai/gemini-3.1-pro")).toBe("pp-flant-openai/gemini-3.1-pro");
  });

  // Once a layer is on the new schema, a provider/model in it is a pin someone
  // chose — reading it as an old tier-routed spec would move it onto a slot.
  it("leaves a stamped layer's pins alone", () => {
    const layer = { schema: 2, agents: { main: { model: "pp-flant-openai/gpt-6-astra-pro", thinking: "high" } } };
    expect(migrateConfigLayer(layer)).toEqual({ config: layer, changed: false });
  });

  it("keeps an explicit gateway enable, so a project can still turn it back on", () => {
    const merged = mergeConfigLayers({ flant: { enabled: false } }, { flant: { enabled: true } });
    expect(merged.providers["llm-api"].enabled).toBe(true);
    expect(merged.providers["claude-sub"].route).toEqual(["llm-api", "direct"]);
  });

  it("moves flant.* onto providers.* without overriding what the layer already sets", () => {
    const { config, changed } = migrateConfigLayer({
      flant: { enabled: false, subscription: false, copilotEnabled: true, autoRateLimitFallback: false, switchBackIntervalMinutes: 20, cacheTTLDays: 7 },
      providers: { copilot: { enabled: false } },
      agents: { main: { model: "pp-flant-anthropic-sub/sub/claude-opus-5", thinking: "high" } },
    });
    expect(changed).toBe(true);
    expect(config.flant).toBeUndefined();
    expect(config.providers).toEqual({
      copilot: { enabled: false },
      "claude-sub": { enabled: false, route: ["direct"] },
      "llm-api": { enabled: false, cacheTTLDays: 7 },
      fallback: { auto: false, retryAfterMinutes: 20 },
    });
    expect(config.agents.main.model).toBe("claude/opus");
    expect(migrateConfigLayer(config).changed).toBe(false);
  });

  it("rewrites the global file once, keeping the original beside it", () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    const original = JSON.stringify({ flant: { enabled: true, copilotEnabled: true } });
    writeFileSync(path, original, "utf-8");
    expect(migrateConfigFile(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      providers: { copilot: { enabled: true }, "llm-api": { enabled: true }, "claude-sub": { route: ["llm-api", "direct"] } },
      schema: 2,
    });
    expect(readFileSync(`${path}.pre-routing.bak`, "utf-8")).toBe(original);
    writeFileSync(path, JSON.stringify({ flant: { codexEnabled: false } }), "utf-8");
    expect(migrateConfigFile(path)).toBe(true);
    expect(readFileSync(`${path}.pre-routing.bak`, "utf-8")).toBe(original);
    expect(migrateConfigFile(path)).toBe(false);
  });

  it("leaves a project file alone on load and migrates it on the first write", () => {
    const cwd = makeTempDir();
    const path = join(cwd, ".pp", "config.json");
    mkdirSync(dirname(path), { recursive: true });
    const original = JSON.stringify({ flant: { copilotEnabled: false }, agents: { task: undefined, main: { model: "pp-flant-anthropic-sub/sub/claude-opus-5", thinking: "high" } } });
    writeFileSync(path, original, "utf-8");
    const config = loadConfig(cwd, "/nonexistent/global/config.json");
    expect(config.providers.copilot.enabled).toBe(false);
    expect(config.agents.main.model).toBe("claude/opus");
    expect(readFileSync(path, "utf-8")).toBe(original);
    writeConfigValue(path, ["general", "logLevel"], "debug");
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.flant).toBeUndefined();
    expect(written.providers.copilot.enabled).toBe(false);
    expect(written.agents.main.model).toBe("claude/opus");
    expect(readFileSync(`${path}.pre-routing.bak`, "utf-8")).toBe(original);
  });
});

describe("loadConfig", () => {
  it("loads existing config.json and deep merges with defaults", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const configPath = join(ppDir, "config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          main: { model: "custom/main", thinking: "low" },
          subagents: {
            simple: { explore: { model: "custom/explore", thinking: "medium" } },
            pools: { advisors: [{ enabled: true, model: "custom/advisor", thinking: "high" }] },
          },
        },
        general: { logLevel: "debug" },
      }),
      "utf-8",
    );

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(config.agents.main).toEqual({ model: "custom/main", thinking: "low" });
    expect(config.agents.subagents.simple.explore).toEqual({ model: "custom/explore", thinking: "medium" });
    expect(config.agents.subagents.simple.task.model).toBe("claude/opus");
    expect(config.agents.subagents.pools.advisors).toEqual([{ enabled: true, model: "custom/advisor", thinking: "high" }]);
    expect(config.agents.subagents.pools.reviewers.length).toBe(2);
    expect(config.general.logLevel).toBe("debug");
    expect(config.general.tracing).toBe(false);
  });

  it("merges global under project scope", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const globalConfigPath = join(cwd, "global-config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(globalConfigPath, JSON.stringify({ agents: { main: { model: "global/model", thinking: "high" }, maxConcurrentSubagents: 3 } }), "utf-8");
    writeFileSync(join(ppDir, "config.json"), JSON.stringify({ agents: { main: { thinking: "xhigh" } } }), "utf-8");

    const config = loadConfig(cwd, globalConfigPath);

    expect(config.agents.main).toEqual({ model: "global/model", thinking: "xhigh" });
    expect(config.agents.maxConcurrentSubagents).toBe(3);
  });

  it("defaults the internals durations and normalizes overrides to ms", () => {
    const cwd = makeTempDir();
    const defaults = loadConfig(cwd, "/nonexistent/global/config.json");
    expect(defaults.performance.internals.mainTurnStale).toBe(600000);
    expect(defaults.performance.internals.subagentStale).toBe(0);

    const cwd2 = makeTempDir();
    const ppDir = join(cwd2, ".pp");
    mkdirSync(ppDir, { recursive: true });
    writeFileSync(join(ppDir, "config.json"), JSON.stringify({ performance: { internals: { mainTurnStale: "90s", subagentStale: 1234 } } }), "utf-8");
    const overridden = loadConfig(cwd2, "/nonexistent/global/config.json");
    expect(overridden.performance.internals.mainTurnStale).toBe(90000);
    expect(overridden.performance.internals.subagentStale).toBe(1234);
  });

  it("rejects invalid internals durations", () => {
    expect(() => validateConfig({ performance: { internals: { mainTurnStale: "soon" } } })).toThrow(
      "config.performance.internals.mainTurnStale",
    );
    expect(() => validateConfig({ performance: { internals: { subagentStale: -1 } } })).toThrow(
      "config.performance.internals.subagentStale",
    );
  });

  it("accepts optional per-worker turn limits and rejects invalid values", () => {
    expect(() => validateConfig({
      agents: {
        subagents: {
          simple: { explore: { maxTurns: 12 } },
          pools: { reviewers: [{ maxTurns: 0 }] },
        },
      },
    })).not.toThrow();
    expect(() => validateConfig({
      agents: { subagents: { simple: { task: { maxTurns: -1 } } } },
    })).toThrow("config.agents.subagents.simple.task.maxTurns");
    expect(() => validateConfig({
      agents: { subagents: { pools: { advisors: [{ maxTurns: 1.5 }] } } },
    })).toThrow("config.agents.subagents.pools.advisors[0].maxTurns");
  });

  it("creates no config file when config.json does not exist", () => {
    const cwd = makeTempDir();
    const configPath = join(cwd, ".pp", "config.json");

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(existsSync(configPath)).toBe(false);
    expect(config.agents.main.model).toBe("claude/opus");
  });

  it("throws parse errors with config file path", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const configPath = join(ppDir, "config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(configPath, "{broken", "utf-8");

    expect(() => loadConfig(cwd, "/nonexistent/global/config.json")).toThrow(`Failed to parse ${configPath}`);
  });

  it("propagates validation errors", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const configPath = join(ppDir, "config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ performance: { internals: { subagentStale: -1 } } }), "utf-8");

    expect(() => loadConfig(cwd, "/nonexistent/global/config.json")).toThrow("config.performance.internals.subagentStale");
  });

  it("rejects a merged config whose pool entry lost its model", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    mkdirSync(ppDir, { recursive: true });
    writeFileSync(join(ppDir, "config.json"), JSON.stringify({ agents: { subagents: { pools: { reviewers: [{ enabled: true, thinking: "high" }] } } } }), "utf-8");

    expect(() => loadConfig(cwd, "/nonexistent/global/config.json")).toThrow(
      "config.agents.subagents.pools.reviewers[0].model must be a non-empty string",
    );
  });
});

describe("config regressions", () => {
  it("skips dangerous keys during deep merge", () => {
    deepMerge({}, { __proto__: { polluted: true } } as Record<string, any>);
    deepMerge({}, { constructor: { pollutedByConstructor: true }, prototype: { pollutedByPrototype: true } });

    const plainObject: Record<string, unknown> = {};
    expect((plainObject as any).polluted).toBeUndefined();
    expect((plainObject as any).pollutedByConstructor).toBeUndefined();
    expect((plainObject as any).pollutedByPrototype).toBeUndefined();
  });

  it("deep copies arrays during merge", () => {
    const target = {};
    const source = { items: [{ a: 1 }] };

    const merged = deepMerge(target, source);
    source.items[0].a = 999;

    expect(merged.items[0].a).toBe(1);
  });

  it("rejects empty simple subagent model and accepts valid simple subagent config", () => {
    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            simple: {
              explore: { model: "", thinking: "low" },
            },
          },
        },
      }),
    ).toThrow("config.agents.subagents.simple.explore.model must be a non-empty string");

    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            simple: {
              explore: { model: "google/gemini-flash-latest", thinking: "low" },
              librarian: { model: "google/gemini-flash-latest", thinking: "medium" },
              task: { model: "anthropic/claude-opus-latest", thinking: "medium" },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("validates dynamic pool entries and rejects a non-array pool", () => {
    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            pools: { advisors: { model: "x/y", thinking: "high" } },
          },
        },
      }),
    ).toThrow("config.agents.subagents.pools.advisors must be an array");

    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            pools: { advisors: [{ model: "", thinking: "high" }] },
          },
        },
      }),
    ).toThrow("config.agents.subagents.pools.advisors[0].model must be a non-empty string");

    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            pools: { advisors: [{ enabled: "false", model: "x/y", thinking: "high" }] },
          },
        },
      }),
    ).toThrow("config.agents.subagents.pools.advisors[0].enabled must be a boolean");

    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            pools: {
              advisors: [{ enabled: true, model: "anthropic/claude-fable-latest", thinking: "high" }],
              reviewers: [{ enabled: false, model: "openai/gpt-latest", thinking: "high" }],
              deepDebuggers: [{ enabled: true, model: "openai/gpt-latest", thinking: "high" }],
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("default config ships enabled astra+fable pools and no fixed advisor role", () => {
    const config = getDefaultConfig();
    const pools = config.agents.subagents.pools;
    for (const key of ["advisors", "reviewers", "deepDebuggers"] as const) {
      expect(pools[key]).toEqual([
        { enabled: true, model: "gpt/astra:pro", thinking: "high" },
        { enabled: true, model: "claude/fable", thinking: "high" },
      ]);
    }
    expect("advisor" in (config.agents.subagents.simple as Record<string, unknown>)).toBe(false);
  });

  it("default config sets maxConcurrentSubagents to 7", () => {
    expect(getDefaultConfig().agents.maxConcurrentSubagents).toBe(7);
  });
});

describe("config write helpers", () => {
  it("getDefaultConfig returns deep clones", () => {
    const first = getDefaultConfig();
    const second = getDefaultConfig();

    first.agents.main.model = "custom/model";
    first.agents.subagents.pools.advisors.push({ model: "extra/model", thinking: "low" });

    expect(second.agents.main.model).toBe("claude/opus");
    expect(second.agents.subagents.pools.advisors.length).toBe(2);
  });

  it("readRawConfig returns empty object when file does not exist", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    expect(readRawConfig(filePath)).toEqual({});
  });

  it("writeConfigValue creates parent dirs and writes nested key", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    writeConfigValue(filePath, ["agents", "subagents", "pools", "advisors"], [{ enabled: true, model: "x/y", thinking: "high" }]);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.agents.subagents.pools.advisors).toEqual([{ enabled: true, model: "x/y", thinking: "high" }]);
  });

  it("removeConfigValue removes nested key, prunes empty parents, and keeps file", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        agents: {
          subagents: {
            simple: {
              explore: { model: "x/y", thinking: "low" },
            },
          },
        },
      }),
      "utf-8",
    );
    removeConfigValue(filePath, ["agents", "subagents", "simple", "explore"]);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toEqual({ schema: 2 });
    expect(existsSync(filePath)).toBe(true);
  });
});
