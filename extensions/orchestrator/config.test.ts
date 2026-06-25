import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { deepMerge, loadConfig, readRawConfig, removeConfigValue, resolvePreset, validateConfig, writeConfigValue } from "./config.js";

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
  it("throws for empty main model string", () => {
    expect(() => validateConfig({ mainModel: { implement: { model: "" } } })).toThrow(
      "config.mainModel.implement.model must be non-empty",
    );
  });

  it("throws for enabled variant without model", () => {
    expect(() => validateConfig({ presets: { planners: { regular: { broken: { enabled: true, model: "" } } } } })).toThrow(
      "config.presets.planners.regular.broken is enabled but has no model",
    );
  });

  it("throws for invalid preset names", () => {
    expect(() => validateConfig({ presets: { planners: { "bad name": { good: { enabled: false } } } } })).toThrow(
      "config.presets.planners.bad name has invalid name",
    );
  });

  it("throws for invalid variant names", () => {
    expect(() => validateConfig({ presets: { planners: { regular: { "bad name": { enabled: false } } } } })).toThrow(
      "config.presets.planners.regular.bad name has invalid name",
    );
  });

  it("allows default preset name format without checking local preset existence", () => {
    expect(() =>
      validateConfig({
        presets: {
          planners: { regular: { a: { enabled: false } } },
        },
        defaultPresets: { planners: "missing" },
      })
    ).not.toThrow();
  });

  it("throws when commands.afterEdit is not an array", () => {
    expect(() => validateConfig({ commands: { afterEdit: { run: "npm test" } } })).toThrow(
      "config.commands.afterEdit must be an array",
    );
  });

  it("throws when commands.afterEdit entry has no run", () => {
    expect(() => validateConfig({ commands: { afterEdit: [{ glob: ["*.ts"] }] } })).toThrow(
      "config.commands.afterEdit[0] must have a 'run' field",
    );
  });

  it("throws when commands.afterImplement entry has no run", () => {
    expect(() => validateConfig({ commands: { afterImplement: [{}] } })).toThrow(
      "config.commands.afterImplement[0] must have a 'run' field",
    );
  });

  it("throws for negative timeout values", () => {
    expect(() => validateConfig({ timeouts: { afterEdit: -1 } })).toThrow(
      "config.timeouts.afterEdit must be a non-negative number",
    );
  });

  it("accepts valid config", () => {
    expect(() =>
      validateConfig({
        mainModel: {
          implement: { model: "provider/model-1" },
          debug: { model: "provider/model-2" },
          brainstorm: { model: "provider/model-3" },
          review: { model: "provider/model-4" },
        },
        presets: {
          planners: {
            regular: {
              good: { enabled: true, model: "provider/model-4" },
              disabled: { enabled: false },
            },
          },
          brainstormReviewers: {
            regular: {
              good: { enabled: true, model: "provider/model-5" },
            },
          },
        },
        defaultPresets: {
          planners: "regular",
          brainstormReviewers: "regular",
        },
        commands: {
          afterEdit: [{ run: "npm test", glob: ["*.ts"] }],
          afterImplement: [{ run: "npm run build" }],
        },
        timeouts: { afterEdit: 0, afterImplement: 1 },
      }),
    ).not.toThrow();
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
        mainModel: {
          implement: { model: "custom/implement", thinking: "low" },
        },
        presets: {
          planners: {
            regular: {
              opus: { enabled: false },
            },
          },
        },
        commands: {
          afterImplement: [{ run: "npm run lint" }],
        },
        timeouts: {
          afterEdit: 1234,
        },
        autoCommit: false,
      }),
      "utf-8",
    );

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(config.mainModel.implement.model).toBe("custom/implement");
    expect(config.mainModel.debug.model).toBe("openai/gpt-latest");
    const planners = resolvePreset(config, "planners");
    expect(planners.opus.enabled).toBe(false);
    expect(planners.opus.model).toBe("anthropic/claude-opus-latest");
    expect(config.commands.afterEdit).toEqual([]);
    expect(config.commands.afterImplement).toEqual([{ run: "npm run lint" }]);
    expect(config.timeouts.afterEdit).toBe(1234);
    expect(config.timeouts.afterImplement).toBe(300000);
    expect(config.autoCommit).toBe(false);
  });

  it("creates default config when config.json does not exist", () => {
    const cwd = makeTempDir();
    const configPath = join(cwd, ".pp", "config.json");

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(existsSync(configPath)).toBe(false);
    expect(config.mainModel.implement.model).toBe("anthropic/claude-opus-latest");
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
    writeFileSync(configPath, JSON.stringify({ timeouts: { afterEdit: -1 } }), "utf-8");

    expect(() => loadConfig(cwd, "/nonexistent/global/config.json")).toThrow("config.timeouts.afterEdit must be a non-negative number");
  });

  it("allows project default preset that exists in global presets", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const projectConfigPath = join(ppDir, "config.json");
    const globalConfigPath = join(cwd, "global-config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        presets: {
          planners: {
            deep: {
              custom: { enabled: true, model: "provider/model-deep" },
            },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(projectConfigPath, JSON.stringify({ defaultPresets: { planners: "deep" } }), "utf-8");

    const config = loadConfig(cwd, globalConfigPath);

    expect(config.defaultPresets.planners).toBe("deep");
    expect(resolvePreset(config, "planners")).toEqual(config.presets.planners.deep);
  });

  it("throws when merged default preset points to missing preset", () => {
    const cwd = makeTempDir();
    const ppDir = join(cwd, ".pp");
    const projectConfigPath = join(ppDir, "config.json");
    const globalConfigPath = join(cwd, "global-config.json");

    mkdirSync(ppDir, { recursive: true });
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        presets: {
          planners: {
            regular: {
              custom: { enabled: true, model: "provider/model-regular" },
            },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(projectConfigPath, JSON.stringify({ defaultPresets: { planners: "missing" } }), "utf-8");

    expect(() => loadConfig(cwd, globalConfigPath)).toThrow(
      'config.defaultPresets.planners "missing" does not exist in merged presets',
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

  it("rejects empty agents model and accepts valid agents config", () => {
    expect(() => validateConfig({ agents: { explore: { model: "", thinking: "low" } } })).toThrow(
      "config.agents.explore.model must be a non-empty string",
    );

    expect(() =>
      validateConfig({
        agents: {
          explore: { model: "google/gemini-flash-latest", thinking: "low" },
          librarian: { model: "google/gemini-flash-latest", thinking: "medium" },
          task: { model: "anthropic/claude-opus-latest", thinking: "medium" },
        },
      }),
    ).not.toThrow();
  });
});

describe("config write helpers", () => {
  it("readRawConfig returns empty object when file does not exist", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    expect(readRawConfig(filePath)).toEqual({});
  });

  it("writeConfigValue creates parent dirs and writes nested key", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    writeConfigValue(filePath, ["presets", "planners", "regular", "custom"], { enabled: true, model: "x/y", thinking: "high" });
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.presets.planners.regular.custom).toEqual({ enabled: true, model: "x/y", thinking: "high" });
  });

  it("removeConfigValue removes nested key and keeps file", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ presets: { planners: { regular: { a: { enabled: true } } } } }), "utf-8");
    removeConfigValue(filePath, ["presets", "planners", "regular", "a"]);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.presets.planners.regular.a).toBeUndefined();
  });
});
