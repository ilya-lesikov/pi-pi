import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isValidLogLevel, getLogger, type LogLevel } from "./log.js";

export type DurationValue = string | number;
export type OrchestratorRole = "implement" | "plan" | "debug" | "brainstorm" | "review";
export type SimpleSubagentRole = "explore" | "librarian" | "task";
export type PresetGroupKey = "planners" | "codeReviewers" | "planReviewers" | "brainstormReviewers";

export interface AgentConfig {
  model: string;
  thinking: string;
}

export interface PresetAgentConfig extends AgentConfig {
  enabled?: boolean;
}

export interface PresetConfig {
  enabled?: boolean;
  agents: Record<string, PresetAgentConfig>;
}

export interface PresetGroupConfig {
  default: string;
  presets: Record<string, PresetConfig>;
}

export interface AfterEditCommandConfig {
  run: string;
  globs?: string[];
  enabled?: boolean;
}

export interface AfterImplementCommandConfig {
  run: string;
  enabled?: boolean;
}

export interface PiPiConfig {
  general: {
    autoCommit: boolean;
    loadExtraRepoConfigs: boolean;
    logLevel: LogLevel;
  };
  agents: {
    orchestrators: Record<OrchestratorRole, AgentConfig>;
    subagents: {
      simple: Record<SimpleSubagentRole, AgentConfig>;
      presetGroups: Record<PresetGroupKey, PresetGroupConfig>;
    };
  };
  commands: {
    afterEdit: Record<string, AfterEditCommandConfig>;
    afterImplement: Record<string, AfterImplementCommandConfig>;
  };
  performance: {
    commands: {
      afterEdit: DurationValue;
      afterImplement: DurationValue;
    };
    internals: {
      subagentStale: DurationValue;
      taskLockStale: DurationValue;
      taskLockRefresh: DurationValue;
    };
  };
}

export interface NormalizedPiPiConfig extends PiPiConfig {
  performance: {
    commands: {
      afterEdit: number;
      afterImplement: number;
    };
    internals: {
      subagentStale: number;
      taskLockStale: number;
      taskLockRefresh: number;
    };
  };
}

export type PresetGroup = PresetGroupKey;
export type VariantConfig = PresetAgentConfig;
export type TimeoutConfig = NormalizedPiPiConfig["performance"]["internals"];

export const PRESET_GROUPS = ["planners", "codeReviewers", "planReviewers", "brainstormReviewers"] as const;

const ORCHESTRATOR_ROLES: OrchestratorRole[] = ["implement", "plan", "debug", "brainstorm", "review"];
const SIMPLE_SUBAGENT_ROLES: SimpleSubagentRole[] = ["explore", "librarian", "task"];

const DEFAULT_CONFIG: PiPiConfig = {
  general: {
    autoCommit: true,
    loadExtraRepoConfigs: true,
    logLevel: "info",
  },
  agents: {
    orchestrators: {
      implement: { model: "anthropic/claude-opus-latest", thinking: "high" },
      plan: { model: "anthropic/claude-opus-latest", thinking: "high" },
      debug: { model: "openai/gpt-latest", thinking: "high" },
      brainstorm: { model: "anthropic/claude-opus-latest", thinking: "high" },
      review: { model: "anthropic/claude-opus-latest", thinking: "high" },
    },
    subagents: {
      simple: {
        explore: { model: "google/gemini-flash-latest", thinking: "low" },
        librarian: { model: "google/gemini-flash-latest", thinking: "medium" },
        task: { model: "anthropic/claude-opus-latest", thinking: "medium" },
      },
      presetGroups: {
        planners: {
          default: "regular",
          presets: {
            regular: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "high" },
              },
            },
          },
        },
        codeReviewers: {
          default: "regular",
          presets: {
            regular: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
            deep: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
          },
        },
        planReviewers: {
          default: "regular",
          presets: {
            regular: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
            deep: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
          },
        },
        brainstormReviewers: {
          default: "regular",
          presets: {
            regular: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "high" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "high" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
            deep: {
              agents: {
                opus: { enabled: true, model: "anthropic/claude-opus-latest", thinking: "xhigh" },
                gpt: { enabled: true, model: "openai/gpt-latest", thinking: "xhigh" },
                gemini: { enabled: true, model: "google/gemini-pro-latest", thinking: "xhigh" },
              },
            },
          },
        },
      },
    },
  },
  commands: {
    afterEdit: {},
    afterImplement: {},
  },
  performance: {
    commands: {
      afterEdit: "30s",
      afterImplement: "5m",
    },
    internals: {
      subagentStale: "5m",
      taskLockStale: "1m",
      taskLockRefresh: "30s",
    },
  },
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_NAME_RE = /^[A-Za-z0-9-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function ensureBool(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
}

function ensureString(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function ensureDuration(value: unknown, path: string): void {
  if (value === undefined) return;
  if (parseDuration(value as DurationValue) === null) {
    throw new Error(`${path} must be a valid duration (number or string like 30s, 5m, 1h)`);
  }
}

export function parseDuration(input: DurationValue): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    return input;
  }
  if (typeof input !== "string") return null;
  const match = /^\s*(\d+)\s*(ms|s|m|h)?\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60000;
  if (unit === "h") return value * 3600000;
  return null;
}

export function getDefaultConfig(): PiPiConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
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

function validateAgentPartial(value: unknown, path: string): void {
  const agent = requireObject(value, path);
  ensureString(agent.model, `${path}.model`);
  ensureString(agent.thinking, `${path}.thinking`);
}

function validatePresetAgentPartial(value: unknown, path: string): void {
  const agent = requireObject(value, path);
  ensureBool(agent.enabled, `${path}.enabled`);
  ensureString(agent.model, `${path}.model`);
  ensureString(agent.thinking, `${path}.thinking`);
}

function validateCommandAfterEditPartial(value: unknown, path: string): void {
  const command = requireObject(value, path);
  ensureBool(command.enabled, `${path}.enabled`);
  ensureString(command.run, `${path}.run`);
  if (command.globs !== undefined) {
    if (!Array.isArray(command.globs) || command.globs.some((g) => typeof g !== "string" || g.length === 0)) {
      throw new Error(`${path}.globs must be an array of non-empty strings`);
    }
  }
}

function validateCommandAfterImplementPartial(value: unknown, path: string): void {
  const command = requireObject(value, path);
  ensureBool(command.enabled, `${path}.enabled`);
  ensureString(command.run, `${path}.run`);
}

function validatePresetPartial(value: unknown, path: string): void {
  const preset = requireObject(value, path);
  ensureBool(preset.enabled, `${path}.enabled`);
  if (preset.agents !== undefined) {
    const agents = requireObject(preset.agents, `${path}.agents`);
    for (const [agentName, agentCfg] of Object.entries(agents)) {
      if (!VALID_NAME_RE.test(agentName)) throw new Error(`${path}.agents.${agentName} has invalid name`);
      validatePresetAgentPartial(agentCfg, `${path}.agents.${agentName}`);
    }
  }
}

function validatePresetGroupPartial(value: unknown, path: string): void {
  const group = requireObject(value, path);
  if (group.default !== undefined) {
    ensureString(group.default, `${path}.default`);
    if (typeof group.default === "string" && !VALID_NAME_RE.test(group.default)) {
      throw new Error(`${path}.default has invalid name`);
    }
  }
  if (group.presets !== undefined) {
    const presets = requireObject(group.presets, `${path}.presets`);
    for (const [presetName, presetCfg] of Object.entries(presets)) {
      if (!VALID_NAME_RE.test(presetName)) throw new Error(`${path}.presets.${presetName} has invalid name`);
      validatePresetPartial(presetCfg, `${path}.presets.${presetName}`);
    }
  }
}

export function validateConfig(config: Record<string, any>): void {
  if (config.general !== undefined) {
    const general = requireObject(config.general, "config.general");
    ensureBool(general.autoCommit, "config.general.autoCommit");
    ensureBool(general.loadExtraRepoConfigs, "config.general.loadExtraRepoConfigs");
    if (general.logLevel !== undefined && !isValidLogLevel(general.logLevel)) {
      throw new Error("config.general.logLevel must be one of: debug, info, warn, error");
    }
  }

  if (config.agents !== undefined) {
    const agents = requireObject(config.agents, "config.agents");

    if (agents.orchestrators !== undefined) {
      const orchestrators = requireObject(agents.orchestrators, "config.agents.orchestrators");
      for (const role of ORCHESTRATOR_ROLES) {
        if (orchestrators[role] !== undefined) {
          validateAgentPartial(orchestrators[role], `config.agents.orchestrators.${role}`);
        }
      }
    }

    if (agents.subagents !== undefined) {
      const subagents = requireObject(agents.subagents, "config.agents.subagents");

      if (subagents.simple !== undefined) {
        const simple = requireObject(subagents.simple, "config.agents.subagents.simple");
        for (const role of SIMPLE_SUBAGENT_ROLES) {
          if (simple[role] !== undefined) {
            validateAgentPartial(simple[role], `config.agents.subagents.simple.${role}`);
          }
        }
      }

      if (subagents.presetGroups !== undefined) {
        const presetGroups = requireObject(subagents.presetGroups, "config.agents.subagents.presetGroups");
        for (const groupName of PRESET_GROUPS) {
          if (presetGroups[groupName] !== undefined) {
            validatePresetGroupPartial(presetGroups[groupName], `config.agents.subagents.presetGroups.${groupName}`);
          }
        }
      }
    }
  }

  if (config.commands !== undefined) {
    const commands = requireObject(config.commands, "config.commands");

    if (commands.afterEdit !== undefined) {
      const afterEdit = requireObject(commands.afterEdit, "config.commands.afterEdit");
      for (const [commandId, commandCfg] of Object.entries(afterEdit)) {
        validateCommandAfterEditPartial(commandCfg, `config.commands.afterEdit.${commandId}`);
      }
    }

    if (commands.afterImplement !== undefined) {
      const afterImplement = requireObject(commands.afterImplement, "config.commands.afterImplement");
      for (const [commandId, commandCfg] of Object.entries(afterImplement)) {
        validateCommandAfterImplementPartial(commandCfg, `config.commands.afterImplement.${commandId}`);
      }
    }
  }

  if (config.performance !== undefined) {
    const performance = requireObject(config.performance, "config.performance");
    if (performance.commands !== undefined) {
      const cmdPerf = requireObject(performance.commands, "config.performance.commands");
      ensureDuration(cmdPerf.afterEdit, "config.performance.commands.afterEdit");
      ensureDuration(cmdPerf.afterImplement, "config.performance.commands.afterImplement");
    }
    if (performance.internals !== undefined) {
      const internals = requireObject(performance.internals, "config.performance.internals");
      ensureDuration(internals.subagentStale, "config.performance.internals.subagentStale");
      ensureDuration(internals.taskLockStale, "config.performance.internals.taskLockStale");
      ensureDuration(internals.taskLockRefresh, "config.performance.internals.taskLockRefresh");
    }
  }
}

function ensureMergedAgent(agent: AgentConfig, path: string): void {
  if (typeof agent.model !== "string" || agent.model.length === 0) {
    throw new Error(`${path}.model must be a non-empty string`);
  }
  if (typeof agent.thinking !== "string" || agent.thinking.length === 0) {
    throw new Error(`${path}.thinking must be a non-empty string`);
  }
}

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

export function validateMergedConfig(config: Record<string, any>): void {
  const typed = config as PiPiConfig;

  if (!typed.general || !isValidLogLevel(typed.general.logLevel)) {
    throw new Error("config.general.logLevel must be one of: debug, info, warn, error");
  }

  for (const role of ORCHESTRATOR_ROLES) {
    ensureMergedAgent(typed.agents.orchestrators[role], `config.agents.orchestrators.${role}`);
  }

  for (const role of SIMPLE_SUBAGENT_ROLES) {
    ensureMergedAgent(typed.agents.subagents.simple[role], `config.agents.subagents.simple.${role}`);
  }

  for (const groupName of PRESET_GROUPS) {
    const group = typed.agents.subagents.presetGroups[groupName];
    if (!group || typeof group !== "object") {
      throw new Error(`config.agents.subagents.presetGroups.${groupName} must be an object`);
    }

    if (typeof group.default !== "string" || group.default.length === 0) {
      throw new Error(`config.agents.subagents.presetGroups.${groupName}.default must be a non-empty string`);
    }

    const defaultPreset = group.presets[group.default];
    if (!defaultPreset) {
      throw new Error(`config.agents.subagents.presetGroups.${groupName}.default "${group.default}" does not exist`);
    }
    if (!isEnabled(defaultPreset)) {
      throw new Error(`config.agents.subagents.presetGroups.${groupName}.default "${group.default}" is disabled`);
    }

    for (const [presetName, preset] of Object.entries(group.presets)) {
      if (!VALID_NAME_RE.test(presetName)) {
        throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName} has invalid name`);
      }
      if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
        throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName} must be an object`);
      }

      const agents = preset.agents;
      if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
        throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName}.agents must be an object`);
      }

      let enabledAgents = 0;
      for (const [agentName, agentCfg] of Object.entries(agents)) {
        if (!VALID_NAME_RE.test(agentName)) {
          throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName}.agents.${agentName} has invalid name`);
        }
        if (!agentCfg || typeof agentCfg !== "object" || Array.isArray(agentCfg)) {
          throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName}.agents.${agentName} must be an object`);
        }
        if (isEnabled(agentCfg)) enabledAgents += 1;
        ensureMergedAgent(agentCfg as AgentConfig, `config.agents.subagents.presetGroups.${groupName}.presets.${presetName}.agents.${agentName}`);
      }

      if (isEnabled(preset) && enabledAgents === 0) {
        throw new Error(`config.agents.subagents.presetGroups.${groupName}.presets.${presetName} has no enabled agents`);
      }
    }
  }

  for (const [id, cmd] of Object.entries(typed.commands.afterEdit)) {
    if (!cmd || typeof cmd !== "object") throw new Error(`config.commands.afterEdit.${id} must be an object`);
    if (isEnabled(cmd) && (typeof cmd.run !== "string" || cmd.run.length === 0)) {
      throw new Error(`config.commands.afterEdit.${id}.run must be a non-empty string`);
    }
    if (cmd.globs !== undefined && (!Array.isArray(cmd.globs) || cmd.globs.some((g) => typeof g !== "string" || g.length === 0))) {
      throw new Error(`config.commands.afterEdit.${id}.globs must be an array of non-empty strings`);
    }
  }

  for (const [id, cmd] of Object.entries(typed.commands.afterImplement)) {
    if (!cmd || typeof cmd !== "object") throw new Error(`config.commands.afterImplement.${id} must be an object`);
    if (isEnabled(cmd) && (typeof cmd.run !== "string" || cmd.run.length === 0)) {
      throw new Error(`config.commands.afterImplement.${id}.run must be a non-empty string`);
    }
  }

  if (parseDuration(typed.performance.commands.afterEdit) === null) {
    throw new Error("config.performance.commands.afterEdit must be a valid duration");
  }
  if (parseDuration(typed.performance.commands.afterImplement) === null) {
    throw new Error("config.performance.commands.afterImplement must be a valid duration");
  }
  if (parseDuration(typed.performance.internals.subagentStale) === null) {
    throw new Error("config.performance.internals.subagentStale must be a valid duration");
  }
  if (parseDuration(typed.performance.internals.taskLockStale) === null) {
    throw new Error("config.performance.internals.taskLockStale must be a valid duration");
  }
  if (parseDuration(typed.performance.internals.taskLockRefresh) === null) {
    throw new Error("config.performance.internals.taskLockRefresh must be a valid duration");
  }
}

export function normalizeConfigDurations(config: PiPiConfig): NormalizedPiPiConfig {
  const next = structuredClone(config) as NormalizedPiPiConfig;

  const afterEdit = parseDuration(next.performance.commands.afterEdit);
  const afterImplement = parseDuration(next.performance.commands.afterImplement);
  const subagentStale = parseDuration(next.performance.internals.subagentStale);
  const taskLockStale = parseDuration(next.performance.internals.taskLockStale);
  const taskLockRefresh = parseDuration(next.performance.internals.taskLockRefresh);

  if (
    afterEdit === null ||
    afterImplement === null ||
    subagentStale === null ||
    taskLockStale === null ||
    taskLockRefresh === null
  ) {
    throw new Error("Failed to normalize config durations");
  }

  next.performance.commands.afterEdit = afterEdit;
  next.performance.commands.afterImplement = afterImplement;
  next.performance.internals.subagentStale = subagentStale;
  next.performance.internals.taskLockStale = taskLockStale;
  next.performance.internals.taskLockRefresh = taskLockRefresh;
  return next;
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

export function mergeConfigLayers(
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
): NormalizedPiPiConfig {
  const log = getLogger();
  let merged = getDefaultConfig() as Record<string, any>;

  const getFlantConfig = (globalThis as any)[Symbol.for("pi-pi:flant-config")] as (() => Partial<PiPiConfig> | null) | undefined;
  const flantConfig = getFlantConfig?.();
  if (flantConfig) {
    validateConfig(flantConfig as Record<string, any>);
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

  validateMergedConfig(merged);
  const normalized = normalizeConfigDurations(merged as PiPiConfig);
  log.debug(
    {
      s: "config",
      logLevel: normalized.general.logLevel,
      autoCommit: normalized.general.autoCommit,
      loadExtraRepoConfigs: normalized.general.loadExtraRepoConfigs,
    },
    "config merge complete",
  );
  return normalized;
}

export function resolvePreset(
  config: PiPiConfig,
  group: PresetGroup,
  presetName?: string,
): Record<string, PresetAgentConfig> {
  const log = getLogger();
  const groupConfig = config.agents.subagents.presetGroups[group];
  const requestedName = presetName ?? groupConfig.default;

  const isPresetEnabled = (p: PresetConfig | undefined): boolean => !!p && p.enabled !== false;
  const normalizeAgents = (preset: PresetConfig): Record<string, PresetAgentConfig> => {
    const out: Record<string, PresetAgentConfig> = {};
    for (const [name, agent] of Object.entries(preset.agents)) {
      out[name] = { ...agent, enabled: agent.enabled !== false };
    }
    return out;
  };

  const direct = groupConfig.presets[requestedName];
  if (isPresetEnabled(direct)) {
    log.debug({ s: "preset", group, name: requestedName, variants: Object.keys(direct!.agents) }, "preset resolved");
    return normalizeAgents(direct!);
  }

  const fallbackName = Object.keys(groupConfig.presets).find((name) => isPresetEnabled(groupConfig.presets[name]));
  if (fallbackName) {
    const fallback = groupConfig.presets[fallbackName]!;
    log.debug({ s: "preset", group, requested: requestedName, resolved: fallbackName, fallback: true }, "preset fallback");
    return normalizeAgents(fallback);
  }

  log.debug({ s: "preset", group, requested: requestedName, resolved: null, fallback: true }, "preset fallback empty");
  return {};
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
    const parents: Array<{ container: Record<string, any>; key: string }> = [];
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (DANGEROUS_KEYS.has(key)) return;
      const current = cursor[key];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return;
      }
      parents.push({ container: cursor, key });
      cursor = current;
    }

    const leaf = keyPath[keyPath.length - 1];
    if (DANGEROUS_KEYS.has(leaf)) return;
    delete cursor[leaf];
    for (let i = parents.length - 1; i >= 0; i -= 1) {
      const parent = parents[i]!;
      const current = parent.container[parent.key];
      if (!isObject(current) || Object.keys(current).length > 0) break;
      delete parent.container[parent.key];
    }
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

export function loadConfig(cwd: string, globalConfigPath = GLOBAL_CONFIG_PATH): NormalizedPiPiConfig {
  const ppDir = join(cwd, ".pp");
  const projectConfigPath = join(ppDir, "config.json");

  if (!existsSync(ppDir)) {
    mkdirSync(ppDir, { recursive: true });
  }

  const globalConfig = loadJsonFile(globalConfigPath);
  const projectConfig = loadJsonFile(projectConfigPath);
  return mergeConfigLayers(globalConfig, projectConfig);
}
