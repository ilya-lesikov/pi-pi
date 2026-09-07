import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isValidLogLevel, getLogger, type LogLevel } from "./log.js";

export type DurationValue = string | number;
export type SimpleSubagentRole = "explore" | "librarian" | "task";
// Dynamic on-demand subagent pools: advisor / reviewer / deep-debugger are
// configurable lists of models. Each enabled entry registers one model-named
// subagent.
export type PoolKey = "advisors" | "reviewers" | "deepDebuggers";
export const POOL_KEYS = ["advisors", "reviewers", "deepDebuggers"] as const;

export interface AgentConfig {
  model: string;
  thinking: string;
}

export interface PoolEntry {
  model: string;
  thinking: string;
  enabled?: boolean;
}

export interface CompactionConfig {
  /** Enable proactive compaction. Off = never auto-compact. */
  enabled: boolean;
  /** Trigger fraction of the model's context window (default 0.30 = 30%). */
  fraction: number;
  /** Floor in tokens: never trigger below this even if the fraction is smaller
   *  (default 250000 → 1M window ~300K, 500K window uses the 250K floor). */
  floorTokens: number;
  /** Adaptive headroom as a fraction of the context window (default 0.12).
   *  The adaptive next-threshold keeps at least max(headroomFloorTokens,
   *  headroomFraction*window) of working room above the post-compaction size,
   *  so triggers don't creep down as the baseline grows. */
  headroomFraction: number;
  /** Adaptive headroom floor in tokens (default 40000). */
  headroomFloorTokens: number;
  /** Per-model overrides keyed by model id (bare or provider-prefixed). Each may
   *  set any subset of { fraction, floorTokens, headroomFraction, headroomFloorTokens }. */
  perModel: Record<string, { fraction?: number; floorTokens?: number; headroomFraction?: number; headroomFloorTokens?: number }>;
}

export interface AfterEditCommandConfig {
  run: string;
  globs?: string[];
  enabled?: boolean;
}

export interface PiPiConfig {
  general: {
    logLevel: LogLevel;
    tracing: boolean;
  };
  commands: {
    afterEdit: Record<string, AfterEditCommandConfig>;
  };
  // Global/ancestor/project AGENTS.md + CLAUDE.md injection. Six independent
  // toggles = 3 scopes × 2 file types.
  contextInjection: {
    globalAgents: boolean;
    globalClaude: boolean;
    ancestorAgents: boolean;
    ancestorClaude: boolean;
    projectAgents: boolean;
    projectClaude: boolean;
  };
  // Skill discovery per source layer. Precedence when names collide is
  // project > global > bundled.
  skills: {
    loadBundled: boolean;
    loadGlobal: boolean;
    loadProject: boolean;
  };
  compaction: CompactionConfig;
  // Durable Flant settings. These used to live in the regenerable
  // model-metadata cache file (cache/flant-models.json); they are user policy
  // and belong in scoped config. Only cachedFlantModels/cachedOpenRouterData/
  // lastUpdated remain in the cache file.
  flant: {
    enabled: boolean;
    subscription: boolean;
    switchBackIntervalMinutes: number;
    autoRateLimitFallback: boolean;
    copilotEnabled: boolean;
    autoUpdate: boolean;
    cacheTTLDays: number;
  };
  agents: {
    main: AgentConfig;
    maxConcurrentSubagents: number;
    subagents: {
      simple: Record<SimpleSubagentRole, AgentConfig>;
      pools: Record<PoolKey, PoolEntry[]>;
    };
  };
  performance: {
    commands: {
      afterEdit: DurationValue;
    };
    internals: {
      subagentStale: DurationValue;
      mainTurnStale: DurationValue;
    };
  };
}

export interface NormalizedPiPiConfig extends PiPiConfig {
  performance: {
    commands: {
      afterEdit: number;
    };
    internals: {
      subagentStale: number;
      mainTurnStale: number;
    };
  };
}

export type TimeoutConfig = NormalizedPiPiConfig["performance"]["internals"];

const SIMPLE_SUBAGENT_ROLES: SimpleSubagentRole[] = ["explore", "librarian", "task"];

const DEFAULT_CONFIG: PiPiConfig = {
  general: {
    logLevel: "info",
    tracing: false,
  },
  commands: {
    afterEdit: {},
  },
  contextInjection: {
    // All scopes/types ON by default, matching the framework's default breadth
    // (global + every ancestor + cwd). Identical content is deduped by the
    // collector so copies of AGENTS.md/CLAUDE.md are not injected twice.
    globalAgents: true,
    globalClaude: true,
    ancestorAgents: true,
    ancestorClaude: true,
    projectAgents: true,
    projectClaude: true,
  },
  skills: {
    loadBundled: true,
    loadGlobal: true,
    loadProject: true,
  },
  compaction: {
    enabled: true,
    fraction: 0.30,
    floorTokens: 250000,
    headroomFraction: 0.12,
    headroomFloorTokens: 40000,
    perModel: {},
  },
  flant: {
    enabled: false,
    subscription: false,
    switchBackIntervalMinutes: 10,
    autoRateLimitFallback: true,
    copilotEnabled: false,
    autoUpdate: true,
    cacheTTLDays: 3,
  },
  agents: {
    main: { model: "anthropic/claude-opus-latest", thinking: "high" },
    maxConcurrentSubagents: 7,
    subagents: {
      simple: {
        explore: { model: "openai/gpt-luna-latest", thinking: "medium" },
        librarian: { model: "openai/gpt-luna-latest", thinking: "medium" },
        task: { model: "anthropic/claude-opus-latest", thinking: "medium" },
      },
      pools: {
        advisors: [
          { enabled: true, model: "anthropic/claude-fable-latest", thinking: "high" },
          { enabled: true, model: "openai/gpt-latest", thinking: "high" },
        ],
        reviewers: [
          { enabled: true, model: "openai/gpt-latest", thinking: "high" },
          { enabled: true, model: "anthropic/claude-fable-latest", thinking: "medium" },
        ],
        deepDebuggers: [
          { enabled: true, model: "openai/gpt-latest", thinking: "high" },
          { enabled: true, model: "anthropic/claude-fable-latest", thinking: "high" },
        ],
      },
    },
  },
  performance: {
    commands: {
      afterEdit: "30s",
    },
    internals: {
      subagentStale: "5m",
      mainTurnStale: "10m",
    },
  },
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function ensureNumberInRange(value: unknown, path: string, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} must be a number between ${min} and ${max}`);
  }
}

function validateCompaction(value: unknown): void {
  const c = requireObject(value, "config.compaction");
  ensureBool(c.enabled, "config.compaction.enabled");
  ensureNumberInRange(c.fraction, "config.compaction.fraction", 0.01, 1);
  ensureNumberInRange(c.floorTokens, "config.compaction.floorTokens", 1000, 100_000_000);
  ensureNumberInRange(c.headroomFraction, "config.compaction.headroomFraction", 0.01, 1);
  ensureNumberInRange(c.headroomFloorTokens, "config.compaction.headroomFloorTokens", 1000, 100_000_000);
  if (c.perModel !== undefined) {
    const perModel = requireObject(c.perModel, "config.compaction.perModel");
    for (const [modelId, override] of Object.entries(perModel)) {
      const o = requireObject(override, `config.compaction.perModel.${modelId}`);
      ensureNumberInRange(o.fraction, `config.compaction.perModel.${modelId}.fraction`, 0.01, 1);
      ensureNumberInRange(o.floorTokens, `config.compaction.perModel.${modelId}.floorTokens`, 1000, 100_000_000);
      ensureNumberInRange(o.headroomFraction, `config.compaction.perModel.${modelId}.headroomFraction`, 0.01, 1);
      ensureNumberInRange(o.headroomFloorTokens, `config.compaction.perModel.${modelId}.headroomFloorTokens`, 1000, 100_000_000);
    }
  }
}

function ensureDuration(value: unknown, path: string): void {
  if (value === undefined) return;
  if (parseDuration(value as DurationValue) === null) {
    throw new Error(`${path} must be a valid duration (number or string like 30s, 5m, 1h)`);
  }
}

function validateFlant(value: unknown): void {
  const f = requireObject(value, "config.flant");
  ensureBool(f.enabled, "config.flant.enabled");
  ensureBool(f.subscription, "config.flant.subscription");
  ensureBool(f.autoRateLimitFallback, "config.flant.autoRateLimitFallback");
  ensureBool(f.copilotEnabled, "config.flant.copilotEnabled");
  ensureBool(f.autoUpdate, "config.flant.autoUpdate");
  ensureNumberInRange(f.switchBackIntervalMinutes, "config.flant.switchBackIntervalMinutes", 1, 1440);
  ensureNumberInRange(f.cacheTTLDays, "config.flant.cacheTTLDays", 1, 365);
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

function validatePoolEntryPartial(value: unknown, path: string): void {
  const entry = requireObject(value, path);
  ensureBool(entry.enabled, `${path}.enabled`);
  ensureString(entry.model, `${path}.model`);
  ensureString(entry.thinking, `${path}.thinking`);
}

export function validateConfig(config: Record<string, any>): void {
  if (config.general !== undefined) {
    const general = requireObject(config.general, "config.general");
    ensureBool(general.tracing, "config.general.tracing");
    if (general.logLevel !== undefined && !isValidLogLevel(general.logLevel)) {
      throw new Error("config.general.logLevel must be one of: debug, info, warn, error");
    }
  }

  if (config.contextInjection !== undefined) {
    const ci = requireObject(config.contextInjection, "config.contextInjection");
    for (const k of ["globalAgents", "globalClaude", "ancestorAgents", "ancestorClaude", "projectAgents", "projectClaude"]) {
      ensureBool(ci[k], `config.contextInjection.${k}`);
    }
  }

  if (config.skills !== undefined) {
    const sk = requireObject(config.skills, "config.skills");
    ensureBool(sk.loadBundled, "config.skills.loadBundled");
    ensureBool(sk.loadGlobal, "config.skills.loadGlobal");
    ensureBool(sk.loadProject, "config.skills.loadProject");
  }

  if (config.compaction !== undefined) validateCompaction(config.compaction);
  if (config.flant !== undefined) validateFlant(config.flant);

  if (config.commands !== undefined) {
    const commands = requireObject(config.commands, "config.commands");
    if (commands.afterEdit !== undefined) {
      const afterEdit = requireObject(commands.afterEdit, "config.commands.afterEdit");
      for (const [id, entry] of Object.entries(afterEdit)) {
        const cmd = requireObject(entry, `config.commands.afterEdit.${id}`);
        if (typeof cmd.run !== "string" || cmd.run.length === 0) {
          throw new Error(`config.commands.afterEdit.${id}.run must be a non-empty string`);
        }
        ensureBool(cmd.enabled, `config.commands.afterEdit.${id}.enabled`);
        if (cmd.globs !== undefined && (!Array.isArray(cmd.globs) || cmd.globs.some((g) => typeof g !== "string" || g.length === 0))) {
          throw new Error(`config.commands.afterEdit.${id}.globs must be an array of non-empty strings`);
        }
      }
    }
  }

  if (config.agents !== undefined) {
    const agents = requireObject(config.agents, "config.agents");

    ensureMaxConcurrentSubagents(agents.maxConcurrentSubagents);

    if (agents.main !== undefined) validateAgentPartial(agents.main, "config.agents.main");

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

      if (subagents.pools !== undefined) {
        const pools = requireObject(subagents.pools, "config.agents.subagents.pools");
        for (const poolKey of POOL_KEYS) {
          if (pools[poolKey] !== undefined) {
            if (!Array.isArray(pools[poolKey])) {
              throw new Error(`config.agents.subagents.pools.${poolKey} must be an array`);
            }
            pools[poolKey].forEach((entry: unknown, i: number) => {
              validatePoolEntryPartial(entry, `config.agents.subagents.pools.${poolKey}[${i}]`);
            });
          }
        }
      }
    }
  }

  if (config.performance !== undefined) {
    const performance = requireObject(config.performance, "config.performance");
    if (performance.commands !== undefined) {
      const commands = requireObject(performance.commands, "config.performance.commands");
      ensureDuration(commands.afterEdit, "config.performance.commands.afterEdit");
    }
    if (performance.internals !== undefined) {
      const internals = requireObject(performance.internals, "config.performance.internals");
      ensureDuration(internals.subagentStale, "config.performance.internals.subagentStale");
      ensureDuration(internals.mainTurnStale, "config.performance.internals.mainTurnStale");
    }
  }
}

export const MAX_CONCURRENT_SUBAGENTS_CEILING = 1024;

function ensureMaxConcurrentSubagents(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CONCURRENT_SUBAGENTS_CEILING
  ) {
    throw new Error(
      `config.agents.maxConcurrentSubagents must be an integer between 1 and ${MAX_CONCURRENT_SUBAGENTS_CEILING}`,
    );
  }
}

function ensureMergedAgent(agent: AgentConfig, path: string): void {
  if (typeof agent?.model !== "string" || agent.model.length === 0) {
    throw new Error(`${path}.model must be a non-empty string`);
  }
  if (typeof agent.thinking !== "string" || agent.thinking.length === 0) {
    throw new Error(`${path}.thinking must be a non-empty string`);
  }
}

export function validateMergedConfig(config: Record<string, any>): void {
  const typed = config as PiPiConfig;

  if (!typed.general || !isValidLogLevel(typed.general.logLevel)) {
    throw new Error("config.general.logLevel must be one of: debug, info, warn, error");
  }

  ensureMaxConcurrentSubagents(typed.agents?.maxConcurrentSubagents);

  ensureMergedAgent(typed.agents.main, "config.agents.main");

  for (const role of SIMPLE_SUBAGENT_ROLES) {
    ensureMergedAgent(typed.agents.subagents.simple[role], `config.agents.subagents.simple.${role}`);
  }

  for (const poolKey of POOL_KEYS) {
    const pool = typed.agents.subagents.pools?.[poolKey];
    if (!Array.isArray(pool)) {
      throw new Error(`config.agents.subagents.pools.${poolKey} must be an array`);
    }
    pool.forEach((entry, i) => ensureMergedAgent(entry, `config.agents.subagents.pools.${poolKey}[${i}]`));
  }

  if (parseDuration(typed.performance.commands.afterEdit) === null) {
    throw new Error("config.performance.commands.afterEdit must be a valid duration");
  }
  if (parseDuration(typed.performance.internals.subagentStale) === null) {
    throw new Error("config.performance.internals.subagentStale must be a valid duration");
  }
  if (parseDuration(typed.performance.internals.mainTurnStale) === null) {
    throw new Error("config.performance.internals.mainTurnStale must be a valid duration");
  }
}

export function normalizeConfigDurations(config: PiPiConfig): NormalizedPiPiConfig {
  const next = structuredClone(config) as NormalizedPiPiConfig;

  const afterEdit = parseDuration(next.performance.commands.afterEdit);
  const subagentStale = parseDuration(next.performance.internals.subagentStale);
  const mainTurnStale = parseDuration(next.performance.internals.mainTurnStale);

  if (afterEdit === null || subagentStale === null || mainTurnStale === null) {
    throw new Error("Failed to normalize config durations");
  }

  next.performance.commands.afterEdit = afterEdit;
  next.performance.internals.subagentStale = subagentStale;
  next.performance.internals.mainTurnStale = mainTurnStale;
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
      model: normalized.agents.main.model,
    },
    "config merge complete",
  );
  return normalized;
}

export type FlantConfigSection = PiPiConfig["flant"];

// Side-effect-free read of the scoped `flant` section. Unlike loadConfig, this
// NEVER mkdirs: it reads the absolute global config JSON always and
// <cwd>/.pp/config.json only if it already exists, then folds the `flant`
// sections over the defaults (defaults -> global -> project). Used at extension
// init and in subagents, where the real project cwd is not yet known and
// creating a stray .pp in the launch dir must be avoided.
export function readScopedFlantSettings(cwd?: string, globalConfigPath = GLOBAL_CONFIG_PATH): FlantConfigSection {
  const result = { ...(getDefaultConfig().flant) };
  const apply = (raw: Record<string, any> | null) => {
    const f = raw?.flant;
    if (f && typeof f === "object") {
      validateFlant(f);
      Object.assign(result, f);
    }
  };
  apply(loadJsonFile(globalConfigPath));
  if (cwd) {
    const projectConfigPath = join(cwd, ".pp", "config.json");
    if (existsSync(projectConfigPath)) apply(loadJsonFile(projectConfigPath));
  }
  return result;
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
