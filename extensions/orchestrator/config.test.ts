import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deepMerge, loadConfig, validateConfig } from "./config.js";

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
    expect(() => validateConfig({ planners: { broken: { enabled: true, model: "" } } })).toThrow(
      "config.planners.broken is enabled but has no model",
    );
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
        },
        planners: {
          good: { enabled: true, model: "provider/model-4" },
          disabled: { enabled: false },
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
        planners: {
          opus: { enabled: false },
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
    expect(config.mainModel.debug.model).toBe("openai/gpt-5.4");
    expect(config.planners.opus.enabled).toBe(false);
    expect(config.planners.opus.model).toBe("anthropic/claude-opus-4-6");
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

    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mainModel.implement.model).toBe("anthropic/claude-opus-4-6");
    expect(config.mainModel.implement.model).toBe("anthropic/claude-opus-4-6");
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
          explore: { model: "google/gemini-3.1-flash", thinking: "low" },
          librarian: { model: "google/gemini-3.1-flash", thinking: "medium" },
          task: { model: "anthropic/claude-opus-4-6", thinking: "medium" },
        },
      }),
    ).not.toThrow();
  });
});
