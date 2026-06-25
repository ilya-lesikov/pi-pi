import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isValidLogLevel, getLogger, type LogLevel } from "./log.js";

export interface ModelConfig {
  model: string;
  thinking: string;
  maxTurns?: number;
}

export interface VariantConfig extends ModelConfig {
  enabled: boolean;
}

export interface AfterEditCommand {
  run: string;
  glob: string[];
}

export interface AfterImplementCommand {
  run: string;
}

export interface TimeoutConfig {
  afterEdit: number;
  afterImplement: number;
  agentSpawn: number;
  agentReadyPing: number;
  agentStale: number;
  lockStale: number;
  lockUpdate: number;
}

export interface PiPiConfig {
  mainModel: {
    implement: ModelConfig;
    debug: ModelConfig;
    brainstorm: ModelConfig;
    review: ModelConfig;
  };
  presets: {
    planners: Record<string, Record<string, VariantConfig>>;
    codeReviewers: Record<string, Record<string, VariantConfig>>;
    planReviewers: Record<string, Record<string, VariantConfig>>;
    brainstormReviewers: Record<string, Record<string, VariantConfig>>;
  };
  defaultPresets: {
    planners: string;
    codeReviewers: string;
    planReviewers: string;
    brainstormReviewers: string;
  };
  agents: {
    explore: ModelConfig;
    librarian: ModelConfig;
    task: ModelConfig;
  };
  commands: {
    afterEdit: AfterEditCommand[];
    afterImplement: AfterImplementCommand[];
  };
  timeouts: TimeoutConfig;
  autoCommit: boolean;
  ignoreExtraRepoConfigs: boolean;
  logLevel: LogLevel;
}

export const PRESET_GROUPS = ["planners", "codeReviewers", "planReviewers", "brainstormReviewers"] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

const DEFAULT_CONFIG: PiPiConfig = {
  mainModel: {
    implement: { model: "anthropic/claude-opus-latest", thinking: "high" },
    debug: { model: "openai/gpt-latest", thinking: "high" },
    brainstorm: { model: "anthropic/claude-opus-latest", thinking: "high" },
    review: { model: "anthropic/claude-opus-latest", thinking: "high" },
  },
  presets: {
    planners: {
      regular: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "high" },
      },
    },
    codeReviewers: {
      regular: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
      deep: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
    },
    planReviewers: {
      regular: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
      deep: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
    },
    brainstormReviewers: {
      regular: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
      deep: {
        opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
        gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
        gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
      },
    },
  },
  defaultPresets: {
    planners: "regular",
    codeReviewers: "regular",
    planReviewers: "regular",
    brainstormReviewers: "regular",
  },
  agents: {
    explore: { model: "google/gemini-flash-latest", thinking: "low" },
    librarian: { model: "google/gemini-flash-latest", thinking: "medium" },
    task: { model: "anthropic/claude-opus-latest", thinking: "medium" },
  },
  commands: {
    afterEdit: [],
    afterImplement: [],
  },
  timeouts: {
    afterEdit: 30000,
    afterImplement: 300000,
    agentSpawn: 30000,
    agentReadyPing: 5000,
    agentStale: 300000,
    lockStale: 60000,
    lockUpdate: 30000,
  },
  autoCommit: true,
  ignoreExtraRepoConfigs: false,
  logLevel: "info",
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_NAME_RE = /^[A-Za-z0-9-]+$/;

export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (Array.isArray(source[key])) {
      result[key] = structuredClone(source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function validateConfig(config: Record<string, any>): void {
  if (config.mainModel) {
    for (const key of ["implement", "debug", "brainstorm", "review"]) {
      const mc = config.mainModel[key];
      if (mc && typeof mc.model === "string" && mc.model.length === 0) {
        throw new Error(`config.mainModel.${key}.model must be non-empty`);
      }
    }
  }

  if (config.presets !== undefined) {
    if (!config.presets || typeof config.presets !== "object" || Array.isArray(config.presets)) {
      throw new Error("config.presets must be an object");
    }

    for (const group of PRESET_GROUPS) {
      if (!(group in config.presets)) continue;
      const presets = config.presets[group];
      if (!presets || typeof presets !== "object" || Array.isArray(presets)) {
        throw new Error(`config.presets.${group} must be an object`);
      }

      const presetEntries = Object.entries(presets);
      if (presetEntries.length === 0) {
        throw new Error(`config.presets.${group} must contain at least one preset`);
      }

      for (const [presetName, variants] of presetEntries) {
        if (!VALID_NAME_RE.test(presetName)) {
          throw new Error(`config.presets.${group}.${presetName} has invalid name`);
        }
        if (!variants || typeof variants !== "object" || Array.isArray(variants)) {
          throw new Error(`config.presets.${group}.${presetName} must be an object`);
        }

        const variantEntries = Object.entries(variants);
        if (variantEntries.length === 0) {
          throw new Error(`config.presets.${group}.${presetName} must contain at least one variant`);
        }

        for (const [variantName, v] of variantEntries) {
          if (!VALID_NAME_RE.test(variantName)) {
            throw new Error(`config.presets.${group}.${presetName}.${variantName} has invalid name`);
          }
          const variant = v as Record<string, any>;
          if (variant.enabled && (!variant.model || typeof variant.model !== "string" || variant.model.length === 0)) {
            throw new Error(`config.presets.${group}.${presetName}.${variantName} is enabled but has no model`);
          }
        }
      }
    }
  }

  if (config.defaultPresets !== undefined) {
    if (!config.defaultPresets || typeof config.defaultPresets !== "object" || Array.isArray(config.defaultPresets)) {
      throw new Error("config.defaultPresets must be an object");
    }

    for (const group of PRESET_GROUPS) {
      if (!(group in config.defaultPresets)) continue;
      const presetName = config.defaultPresets[group];
      if (typeof presetName !== "string" || presetName.length === 0) {
        throw new Error(`config.defaultPresets.${group} must be a non-empty string`);
      }
      if (!VALID_NAME_RE.test(presetName)) {
        throw new Error(`config.defaultPresets.${group} has invalid name`);
      }
    }
  }

  if (config.commands?.afterEdit) {
    if (!Array.isArray(config.commands.afterEdit)) {
      throw new Error("config.commands.afterEdit must be an array");
    }
    for (const [i, cmd] of config.commands.afterEdit.entries()) {
      if (!cmd.run || typeof cmd.run !== "string") {
        throw new Error(`config.commands.afterEdit[${i}] must have a 'run' field`);
      }
    }
  }

  if (config.commands?.afterImplement) {
    if (!Array.isArray(config.commands.afterImplement)) {
      throw new Error("config.commands.afterImplement must be an array");
    }
    for (const [i, cmd] of config.commands.afterImplement.entries()) {
      if (!cmd.run || typeof cmd.run !== "string") {
        throw new Error(`config.commands.afterImplement[${i}] must have a 'run' field`);
      }
    }
  }

  if (config.timeouts) {
    for (const [key, val] of Object.entries(config.timeouts)) {
      if (typeof val !== "number" || val < 0) {
        throw new Error(`config.timeouts.${key} must be a non-negative number`);
      }
    }
  }

  if (config.logLevel !== undefined && !isValidLogLevel(config.logLevel)) {
    throw new Error(`config.logLevel must be one of: debug, info, warn, error`);
  }

  if (config.agents) {
    for (const [name, agent] of Object.entries(config.agents)) {
      const a = agent as Record<string, any>;
      if (a.model !== undefined && (typeof a.model !== "string" || a.model.length === 0)) {
        throw new Error(`config.agents.${name}.model must be a non-empty string`);
      }
    }
  }
}

function loadJsonFile(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

export const GLOBAL_CONFIG_PATH = join(getAgentDir(), "extensions", "pp", "config.json");

export function validateMergedDefaultPresets(config: Record<string, any>): void {
  for (const group of PRESET_GROUPS) {
    const presetName = config.defaultPresets?.[group];
    if (!presetName) continue;
    const presetsInGroup = config.presets?.[group] as Record<string, unknown> | undefined;
    if (presetsInGroup && !Object.prototype.hasOwnProperty.call(presetsInGroup, presetName)) {
      throw new Error(`config.defaultPresets.${group} "${presetName}" does not exist in merged presets`);
    }
  }
}

export function mergeConfigLayers(
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
): PiPiConfig {
  const log = getLogger();
  let merged = { ...DEFAULT_CONFIG } as Record<string, any>;

  const getFlantConfig = (globalThis as any)[Symbol.for("pi-pi:flant-config")] as (() => Partial<PiPiConfig> | null) | undefined;
  const flantConfig = getFlantConfig?.();
  if (flantConfig) {
    merged = deepMerge(merged, flantConfig as Record<string, any>);
    log.debug({ s: "config", layer: "flant" }, "merged flant config layer");
  }

  if (globalConfig) {
    validateConfig(globalConfig);
    merged = deepMerge(merged, globalConfig);
    log.debug({ s: "config", layer: "global" }, "merged global config layer");
  }

  if (projectConfig) {
    validateConfig(projectConfig);
    merged = deepMerge(merged, projectConfig);
    log.debug({ s: "config", layer: "project" }, "merged project config layer");
  }

  validateConfig(merged);
  validateMergedDefaultPresets(merged);
  log.debug({ s: "config", logLevel: merged.logLevel, autoCommit: merged.autoCommit }, "config merge complete");
  return merged as unknown as PiPiConfig;
}

export function resolvePreset(
  config: PiPiConfig,
  group: PresetGroup,
  presetName?: string,
): Record<string, VariantConfig> {
  const log = getLogger();
  const name = presetName ?? config.defaultPresets[group];
  const preset = config.presets[group]?.[name];
  if (!preset) {
    const presets = config.presets[group] ?? {};
    const firstKey = Object.keys(presets)[0];
    log.debug({ s: "preset", group, requested: name, resolved: firstKey ?? null, fallback: true }, "preset fallback");
    return firstKey ? presets[firstKey] : {};
  }
  log.debug({ s: "preset", group, name, variants: Object.keys(preset) }, "preset resolved");
  return preset;
}

export function readRawConfig(path: string): Record<string, any> {
  return loadJsonFile(path) ?? {};
}

function ensureConfigDir(configPath: string): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeConfigValue(configPath: string, keyPath: string[], value: any): void {
  getLogger().debug({ s: "config", configPath, keyPath, value }, "writeConfigValue");
  ensureConfigDir(configPath);
  if (!existsSync(configPath)) writeFileSync(configPath, "{}\n", "utf-8");
  const release = lockfile.lockSync(configPath, { stale: 10000 });
  try {
    if (keyPath.length === 0) {
      writeFileSync(configPath, JSON.stringify(value ?? {}, null, 2) + "\n", "utf-8");
      return;
    }

    const raw = readRawConfig(configPath);
    let cursor: Record<string, any> = raw;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (DANGEROUS_KEYS.has(key)) return;
      const current = cursor[key];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }

    const leaf = keyPath[keyPath.length - 1];
    if (DANGEROUS_KEYS.has(leaf)) return;
    cursor[leaf] = value;
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

export function removeConfigValue(configPath: string, keyPath: string[]): void {
  ensureConfigDir(configPath);
  if (!existsSync(configPath)) writeFileSync(configPath, "{}\n", "utf-8");
  const release = lockfile.lockSync(configPath, { stale: 10000 });
  try {
    if (keyPath.length === 0) {
      writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n", "utf-8");
      return;
    }

    const raw = readRawConfig(configPath);
    let cursor: Record<string, any> = raw;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (DANGEROUS_KEYS.has(key)) return;
      const current = cursor[key];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return;
      }
      cursor = current;
    }

    const leaf = keyPath[keyPath.length - 1];
    if (DANGEROUS_KEYS.has(leaf)) return;
    delete cursor[leaf];
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

export function loadConfig(cwd: string, globalConfigPath = GLOBAL_CONFIG_PATH): PiPiConfig {
  const ppDir = join(cwd, ".pp");
  const projectConfigPath = join(ppDir, "config.json");

  if (!existsSync(ppDir)) {
    mkdirSync(ppDir, { recursive: true });
  }

  const globalConfig = loadJsonFile(globalConfigPath);
  const projectConfig = loadJsonFile(projectConfigPath);
  return mergeConfigLayers(globalConfig, projectConfig);
}
