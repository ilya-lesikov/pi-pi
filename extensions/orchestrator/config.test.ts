import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { deepMerge, getDefaultConfig, loadConfig, readRawConfig, removeConfigValue, resolvePreset, validateConfig, writeConfigValue } from "./config.js";

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
  it("throws for empty orchestrator model string", () => {
    expect(() =>
      validateConfig({
        agents: {
          orchestrators: {
            implement: { model: "", thinking: "high" },
          },
        },
      }),
    ).toThrow("config.agents.orchestrators.implement.model must be a non-empty string");
  });

  it("throws for invalid preset names", () => {
    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  "bad name": { agents: {} },
                },
              },
            },
          },
        },
      }),
    ).toThrow("config.agents.subagents.presetGroups.planners.presets.bad name has invalid name");
  });

  it("throws for invalid variant names", () => {
    expect(() =>
      validateConfig({
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  regular: {
                    agents: {
                      "bad name": { enabled: true, model: "provider/model", thinking: "high" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("config.agents.subagents.presetGroups.planners.presets.regular.agents.bad name has invalid name");
  });

  it("throws when commands.afterEdit is not an object", () => {
    expect(() => validateConfig({ commands: { afterEdit: [] } as any })).toThrow(
      "config.commands.afterEdit must be an object",
    );
  });

  it("throws when commands.afterEdit entry has no run", () => {
    expect(() => validateConfig({ commands: { afterEdit: { cmd: { run: "", globs: ["*.ts"] } } } })).toThrow(
      "config.commands.afterEdit.cmd.run must be a non-empty string",
    );
  });

  it("throws when commands.afterImplement entry has no run", () => {
    expect(() => validateConfig({ commands: { afterImplement: { cmd: { run: "" } } } })).toThrow(
      "config.commands.afterImplement.cmd.run must be a non-empty string",
    );
  });

  it("throws for invalid duration values", () => {
    expect(() => validateConfig({ performance: { commands: { afterEdit: -1 } } })).toThrow(
      "config.performance.commands.afterEdit must be a valid duration",
    );
  });

  it("throws for invalid injectAgentsMd value", () => {
    expect(() => validateConfig({ general: { injectAgentsMd: "yes" } })).toThrow(
      "config.general.injectAgentsMd",
    );
  });

  it("accepts valid partial config", () => {
    expect(() =>
      validateConfig({
        general: { autoCommit: false, injectAgentsMd: false },
        commands: {
          afterEdit: { fmt: { run: "npm run fmt", globs: ["**/*.ts"] } },
          afterImplement: { test: { run: "npm test" } },
        },
        performance: { commands: { afterEdit: "30s" } },
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
        agents: {
          orchestrators: {
            implement: { model: "custom/implement", thinking: "low" },
          },
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  regular: {
                    agents: {
                      opus: { enabled: false, model: "anthropic/claude-opus-latest", thinking: "high" },
                    },
                  },
                },
              },
            },
          },
        },
        commands: {
          afterImplement: { lint: { run: "npm run lint" } },
        },
        performance: {
          commands: {
            afterEdit: 1234,
          },
        },
        general: {
          autoCommit: false,
        },
      }),
      "utf-8",
    );

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(config.agents.orchestrators.implement.model).toBe("custom/implement");
    expect(config.agents.orchestrators.plan.model).toBe("anthropic/claude-opus-latest");
    expect(config.agents.orchestrators.debug.model).toBe("openai/gpt-latest");
    const planners = resolvePreset(config, "planners");
    expect(planners.opus.enabled).toBe(false);
    expect(planners.opus.model).toBe("anthropic/claude-opus-latest");
    expect(config.commands.afterEdit).toEqual({});
    expect(config.commands.afterImplement).toEqual({ lint: { run: "npm run lint" } });
    expect(config.performance.commands.afterEdit).toBe(1234);
    expect(config.performance.commands.afterImplement).toBe(300000);
    expect(config.general.autoCommit).toBe(false);
    expect(config.general.injectAgentsMd).toBe(true);
  });

  it("defaults injectAgentsMd to true and honors an explicit override", () => {
    const cwd = makeTempDir();
    const defaults = loadConfig(cwd, "/nonexistent/global/config.json");
    expect(defaults.general.injectAgentsMd).toBe(true);

    const cwd2 = makeTempDir();
    const ppDir = join(cwd2, ".pp");
    mkdirSync(ppDir, { recursive: true });
    writeFileSync(join(ppDir, "config.json"), JSON.stringify({ general: { injectAgentsMd: false } }), "utf-8");
    const overridden = loadConfig(cwd2, "/nonexistent/global/config.json");
    expect(overridden.general.injectAgentsMd).toBe(false);
  });

  it("creates default config when config.json does not exist", () => {
    const cwd = makeTempDir();
    const configPath = join(cwd, ".pp", "config.json");

    const config = loadConfig(cwd, "/nonexistent/global/config.json");

    expect(existsSync(configPath)).toBe(false);
    expect(config.agents.orchestrators.implement.model).toBe("anthropic/claude-opus-latest");
    expect(config.agents.orchestrators.plan.model).toBe("anthropic/claude-opus-latest");
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
    writeFileSync(configPath, JSON.stringify({ performance: { commands: { afterEdit: -1 } } }), "utf-8");

    expect(() => loadConfig(cwd, "/nonexistent/global/config.json")).toThrow("config.performance.commands.afterEdit must be a valid duration");
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
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  deep: {
                    enabled: true,
                    agents: {
                      custom: { enabled: true, model: "provider/model-deep", thinking: "high" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                default: "deep",
              },
            },
          },
        },
      }),
      "utf-8",
    );

    const config = loadConfig(cwd, globalConfigPath);

    expect(config.agents.subagents.presetGroups.planners.default).toBe("deep");
    expect(resolvePreset(config, "planners")).toEqual(config.agents.subagents.presetGroups.planners.presets.deep.agents);
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
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  regular: {
                    enabled: true,
                    agents: {
                      custom: { enabled: true, model: "provider/model-regular", thinking: "high" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                default: "missing",
              },
            },
          },
        },
      }),
      "utf-8",
    );

    expect(() => loadConfig(cwd, globalConfigPath)).toThrow(
      'config.agents.subagents.presetGroups.planners.default "missing" does not exist',
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
});

describe("config write helpers", () => {
  it("getDefaultConfig returns deep clones", () => {
    const first = getDefaultConfig();
    const second = getDefaultConfig();

    first.agents.orchestrators.implement.model = "custom/model";
    first.commands.afterEdit["cmd-1"] = { run: "echo test", globs: ["*.ts"] };

    expect(second.agents.orchestrators.implement.model).toBe("anthropic/claude-opus-latest");
    expect(second.commands.afterEdit).toEqual({});
  });

  it("readRawConfig returns empty object when file does not exist", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    expect(readRawConfig(filePath)).toEqual({});
  });

  it("writeConfigValue creates parent dirs and writes nested key", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    writeConfigValue(filePath, ["agents", "subagents", "presetGroups", "planners", "presets", "regular", "agents", "custom"], {
      enabled: true,
      model: "x/y",
      thinking: "high",
    });
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.agents.subagents.presetGroups.planners.presets.regular.agents.custom).toEqual({
      enabled: true,
      model: "x/y",
      thinking: "high",
    });
  });

  it("removeConfigValue removes nested key, prunes empty parents, and keeps file", () => {
    const filePath = join(makeTempDir(), ".pp", "config.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        agents: {
          subagents: {
            presetGroups: {
              planners: {
                presets: {
                  regular: {
                    agents: {
                      a: { enabled: true },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    removeConfigValue(filePath, ["agents", "subagents", "presetGroups", "planners", "presets", "regular", "agents", "a"]);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toEqual({});
    expect(existsSync(filePath)).toBe(true);
  });
});
