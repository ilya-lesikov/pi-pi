import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultConfig,
  mergeConfigLayers,
  migrateConfigFile,
  normalizeConfigDurations,
  parseDuration,
  readLspServerLayers,
  removeConfigValue,
  validateConfig,
  validateMergedConfig,
  writeConfigValue,
} from "./config.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-config-more-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lsp config validation", () => {
  const bad = (lsp: unknown) => () => validateConfig({ lsp });

  it("rejects a non-object lsp section and non-object servers", () => {
    expect(bad("on")).toThrow("config.lsp must be an object");
    expect(bad({ servers: [] })).toThrow("config.lsp.servers must be an object");
    expect(bad({ servers: { ts: "tsserver" } })).toThrow("config.lsp.servers.ts must be an object");
  });

  it("rejects a non-boolean diagnosticsAfterEdit", () => {
    expect(bad({ diagnosticsAfterEdit: "yes" })).toThrow("config.lsp.diagnosticsAfterEdit must be a boolean");
  });

  it("requires command to be a non-empty array of non-empty strings", () => {
    expect(bad({ servers: { ts: { command: "tsserver --stdio" } } })).toThrow("config.lsp.servers.ts.command must be an array of non-empty strings");
    expect(bad({ servers: { ts: { command: ["tsserver", ""] } } })).toThrow("config.lsp.servers.ts.command must be an array of non-empty strings");
    expect(bad({ servers: { ts: { command: [] } } })).toThrow("config.lsp.servers.ts.command must not be empty");
  });

  it("validates the list fields and enabled", () => {
    expect(bad({ servers: { ts: { extensions: ".ts" } } })).toThrow("config.lsp.servers.ts.extensions must be an array of non-empty strings");
    expect(bad({ servers: { ts: { rootMarkers: [1] } } })).toThrow("config.lsp.servers.ts.rootMarkers must be an array of non-empty strings");
    expect(bad({ servers: { ts: { enabled: "no" } } })).toThrow("config.lsp.servers.ts.enabled must be a boolean");
  });

  it("requires env to be an object of string values", () => {
    expect(bad({ servers: { ts: { env: ["A=1"] } } })).toThrow("config.lsp.servers.ts.env must be an object");
    expect(bad({ servers: { ts: { env: { PORT: 8080 } } } })).toThrow("config.lsp.servers.ts.env.PORT must be a string");
  });

  it("requires initializationOptions and settings to be objects", () => {
    expect(bad({ servers: { ts: { initializationOptions: "x" } } })).toThrow("config.lsp.servers.ts.initializationOptions must be an object");
    expect(bad({ servers: { ts: { settings: 1 } } })).toThrow("config.lsp.servers.ts.settings must be an object");
  });

  it("accepts a complete custom server", () => {
    expect(bad({
      diagnosticsAfterEdit: false,
      servers: {
        zls: {
          command: ["zls"],
          extensions: [".zig"],
          rootMarkers: ["build.zig"],
          enabled: true,
          env: { ZIG_HOME: "/opt/zig" },
          initializationOptions: { a: 1 },
          settings: { zls: {} },
        },
      },
    })).not.toThrow();
  });
});

describe("lsp config layering", () => {
  it("defaults to diagnostics after edit with no server overrides", () => {
    expect(getDefaultConfig().lsp).toEqual({ diagnosticsAfterEdit: true, servers: {} });
  });

  it("lets a project layer set only enabled on a builtin server", () => {
    const merged = mergeConfigLayers(null, { lsp: { servers: { "typescript-language-server": { enabled: false } } } });
    expect(merged.lsp.servers).toEqual({ "typescript-language-server": { enabled: false } });
  });

  it("merges a server field by field across global and project layers", () => {
    const merged = mergeConfigLayers(
      { lsp: { diagnosticsAfterEdit: false, servers: { zls: { command: ["zls"], extensions: [".zig"], env: { A: "1" } } } } },
      { lsp: { servers: { zls: { enabled: false, env: { B: "2" } }, gopls: { enabled: true } } } },
    );
    expect(merged.lsp.diagnosticsAfterEdit).toBe(false);
    expect(merged.lsp.servers).toEqual({
      zls: { command: ["zls"], extensions: [".zig"], env: { A: "1", B: "2" }, enabled: false },
      gopls: { enabled: true },
    });
  });

  it("lets the project replace a global command array whole rather than splicing it", () => {
    const merged = mergeConfigLayers(
      { lsp: { servers: { zls: { command: ["zls", "--a", "--b"] } } } },
      { lsp: { servers: { zls: { command: ["zls2"] } } } },
    );
    expect(merged.lsp.servers.zls.command).toEqual(["zls2"]);
  });

  it("rejects a bad lsp entry in either layer", () => {
    expect(() => mergeConfigLayers({ lsp: { servers: { zls: { command: [] } } } }, null)).toThrow("config.lsp.servers.zls.command must not be empty");
    expect(() => mergeConfigLayers(null, { lsp: { servers: { zls: { env: { X: true } } } } })).toThrow("config.lsp.servers.zls.env.X must be a string");
  });
});

describe("readLspServerLayers", () => {
  it("returns each layer's servers unmerged", () => {
    const cwd = tempDir();
    const globalPath = join(tempDir(), "config.json");
    writeFileSync(globalPath, JSON.stringify({ lsp: { servers: { zls: { command: ["zls"] } } } }));
    mkdirSync(join(cwd, ".pp"));
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ lsp: { servers: { zls: { command: ["evil"] } } } }));
    expect(readLspServerLayers(cwd, globalPath)).toEqual({
      global: { zls: { command: ["zls"] } },
      project: { zls: { command: ["evil"] } },
    });
  });

  it("reports a missing, unparseable or non-object layer as absent", () => {
    const cwd = tempDir();
    const globalPath = join(tempDir(), "config.json");
    writeFileSync(globalPath, "{ broken");
    expect(readLspServerLayers(cwd, globalPath)).toEqual({ global: undefined, project: undefined });
    mkdirSync(join(cwd, ".pp"));
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ lsp: { servers: ["zls"] } }));
    expect(readLspServerLayers(cwd, globalPath).project).toBeUndefined();
  });
});

describe("other validation messages", () => {
  it("rejects malformed general, images, schema and model fields", () => {
    expect(() => validateConfig({ general: "x" })).toThrow("config.general must be an object");
    expect(() => validateConfig({ images: { maxEdge: 1 } })).toThrow("config.images.maxEdge must be a number between 28 and 8000");
    expect(() => validateConfig({ schema: 1.5 })).toThrow("config.schema must be an integer");
    expect(() => validateConfig({ models: { claude: { override: { provider: "p", model: "" } } } })).toThrow("config.models.claude.override.model must be a non-empty string");
    expect(() => validateConfig({ models: { claude: { pins: { opus: null } } } })).not.toThrow();
  });

  it("rejects a merged config missing required pieces", () => {
    const valid = () => structuredClone(getDefaultConfig()) as Record<string, any>;
    let config = valid();
    config.general.logLevel = "loud";
    expect(() => validateMergedConfig(config)).toThrow("config.general.logLevel must be one of");
    config = valid();
    config.agents.main.thinking = "";
    expect(() => validateMergedConfig(config)).toThrow("config.agents.main.thinking must be a non-empty string");
    config = valid();
    config.agents.subagents.pools.advisors = {};
    expect(() => validateMergedConfig(config)).toThrow("config.agents.subagents.pools.advisors must be an array");
    config = valid();
    config.performance.commands.afterEdit = "soon";
    expect(() => validateMergedConfig(config)).toThrow("config.performance.commands.afterEdit must be a valid duration");
    config = valid();
    config.performance.internals.mainTurnStale = "-1";
    expect(() => validateMergedConfig(config)).toThrow("config.performance.internals.mainTurnStale must be a valid duration");
  });

  it("refuses to normalize an invalid duration", () => {
    const config = getDefaultConfig();
    (config.performance.internals as any).workerStallWarn = "bogus";
    expect(() => normalizeConfigDurations(config)).toThrow("Failed to normalize config durations");
    const other = getDefaultConfig();
    (other.performance.commands as any).afterEdit = {};
    expect(() => normalizeConfigDurations(other)).toThrow("Failed to normalize config durations");
  });

  it("parses every duration unit and rejects non-durations", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("250")).toBe(250);
    expect(parseDuration({} as any)).toBeNull();
    expect(parseDuration(-1)).toBeNull();
  });
});

describe("migrateConfigFile with a legacy policy", () => {
  it("creates nothing when there is no config and no legacy policy to carry", () => {
    const path = join(tempDir(), "pp", "config.json");
    expect(migrateConfigFile(path, () => null)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("writes a config for a legacy policy even when no config file existed, without a backup", () => {
    const path = join(tempDir(), "pp", "config.json");
    expect(migrateConfigFile(path, () => ({ autoUpdate: false }))).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.providers["llm-api"].autoUpdate).toBe(false);
    expect(written.flant).toBeUndefined();
    expect(existsSync(`${path}.pre-routing.bak`)).toBe(false);
  });

  it("lets an explicit flant key in the file win over the legacy policy", () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, JSON.stringify({ flant: { autoUpdate: true } }));
    let seen: Record<string, unknown> | undefined;
    migrateConfigFile(path, (flant) => { seen = flant; return { cacheTTLDays: 3 }; });
    expect(seen).toEqual({ autoUpdate: true });
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.providers["llm-api"]).toEqual({ autoUpdate: true, cacheTTLDays: 3 });
    expect(JSON.parse(readFileSync(`${path}.pre-routing.bak`, "utf-8"))).toEqual({ flant: { autoUpdate: true } });
  });
});

describe("writing and removing values", () => {
  it("replaces the whole file for an empty key path", () => {
    const path = join(tempDir(), "config.json");
    writeConfigValue(path, [], { general: { tracing: true } });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ general: { tracing: true } });
    writeConfigValue(path, [], undefined);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
  });

  it("never writes through a prototype-polluting key", () => {
    const path = join(tempDir(), "config.json");
    writeConfigValue(path, ["__proto__", "polluted"], true);
    writeConfigValue(path, ["general", "constructor"], true);
    expect(({} as any).polluted).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
  });

  it("clears the file on an empty remove path, and ignores dangerous or absent paths", () => {
    const path = join(tempDir(), "config.json");
    writeConfigValue(path, ["general", "tracing"], true);
    removeConfigValue(path, ["__proto__", "x"]);
    removeConfigValue(path, ["general", "prototype"]);
    removeConfigValue(path, ["missing", "leaf"]);
    expect(JSON.parse(readFileSync(path, "utf-8")).general).toEqual({ tracing: true });
    removeConfigValue(path, []);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
  });

  it("creates the file when removing from a config that does not exist yet", () => {
    const path = join(tempDir(), "nested", "config.json");
    removeConfigValue(path, ["general", "tracing"]);
    expect(existsSync(path)).toBe(true);
  });

  it("prunes only parents left empty by a removal", () => {
    const path = join(tempDir(), "config.json");
    writeConfigValue(path, ["lsp", "servers", "zls", "enabled"], false);
    writeConfigValue(path, ["lsp", "diagnosticsAfterEdit"], false);
    removeConfigValue(path, ["lsp", "servers", "zls", "enabled"]);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.lsp).toEqual({ diagnosticsAfterEdit: false });
  });
});
