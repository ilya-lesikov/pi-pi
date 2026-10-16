import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isValidLogLevel, getLogger, type LogLevel } from "./log.js";
import { CONFIG_SCHEMA, migrateConfigLayer } from "./config-migration.js";

export type DurationValue = string | number;
export type SimpleSubagentRole = "explore" | "librarian" | "task";
// Dynamic on-demand subagent pools: advisor / reviewer / deep-debugger are
// configurable lists of models. Each enabled entry registers one model-named
// subagent.
export type PoolKey = "advisors" | "reviewers" | "deepDebuggers";
export const POOL_KEYS = ["advisors", "reviewers", "deepDebuggers"] as const;

export type ProviderName = "claude-sub" | "codex" | "copilot" | "llm-api";
export type ClaudeSubRoute = "direct" | "llm-api";
export type FamilyName = "claude" | "gpt";
export type SlotName = "haiku" | "sonnet" | "opus" | "fable" | "luna" | "terra" | "sol" | "astra";

export interface ProvidersConfig {
  /** Priority: the first enabled provider that serves a model wins. */
  order: ProviderName[];
  "claude-sub": { enabled: boolean; route: ClaudeSubRoute[] };
  codex: { enabled: boolean };
  copilot: { enabled: boolean };
  "llm-api": { enabled: boolean; autoUpdate: boolean; cacheTTLDays: number };
  fallback: { auto: boolean; retryAfterMinutes: number };
}

/**
 * Replaces a whole family with one provider's models. `model` fills every
 * slot; `slots` refines individual ones.
 */
export interface FamilyOverride {
  provider: string;
  model: string;
  slots?: Partial<Record<SlotName, string>>;
}

export interface FamilyModelsConfig {
  override: FamilyOverride | null;
  /** Lock a slot to one version instead of the latest a provider serves; null cancels a lower layer's. */
  pins: Partial<Record<SlotName, string | null>>;
}

export type ModelsConfig = Record<FamilyName, FamilyModelsConfig>;

export interface AgentConfig {
  model: string;
  thinking: string;
}

export interface PoolEntry {
  model: string;
  thinking: string;
  enabled?: boolean;
}

export interface PromptcapModelConfig {
  /** Prompt ceiling in tokens, applied when no context window is known
   *  (default 150000). It raises the ceiling and never lowers it: once the
   *  unfoldable prose plus headroomTokens exceeds it, that sum is the ceiling.
   *  To fold a long session sooner, cut headroomTokens or declare a smaller
   *  contextWindow. */
  maxPromptTokens?: number;
  /** The model's total context window. Omitted means "ask the host", which
   *  reports one for most models; declare it for a model whose provider
   *  does not. */
  contextWindow?: number;
  /** What one image counts as, in tokens (default 1600). Raise it for a model
   *  whose vendor prices images far above the frontier norm — typically a
   *  small model whose per-token price is a fraction of a large one's. */
  imageTokens?: number;
}

export interface PromptcapConfig extends PromptcapModelConfig {
  /** Fold old tool traffic out of the prompt. Off = send the whole conversation. */
  enabled: boolean;
  /** Room kept above the unfoldable prose before folding starts, in tokens
   *  (default 200000). Not per-model: it sizes the recent tool history the work
   *  needs, and the model bounds it through its window instead. */
  headroomTokens?: number;
  /** The share of the headroom kept as recent tool history after a fold,
   *  between 0 and 1 (default 0.3). The rest is the room the prompt grows back
   *  into before the next fold. */
  keepFraction?: number;
  /** Ask Anthropic to hold the prompt cache for an hour rather than five
   *  minutes (default true). Off = the provider default, which expires across
   *  any pause longer than a coffee and re-buys the prompt at write price. */
  longCacheRetention?: boolean;
  /** The image payload a prompt may carry before the oldest of it is folded
   *  away, in the bytes that go on the wire (default 3500000). A provider
   *  prices an image by its pixels, so the token budget reads a screenshot at
   *  a hundredth of the base64 that carries it and never folds one. */
  imageBytesCeiling?: number;
  /** What a fold takes that payload back down to (default 1750000), roughly
   *  the three most recent captures; 0 takes every image it may. Held below
   *  half the ceiling, so a fold lands every few captures rather than on
   *  every turn. */
  imageBytesLowWater?: number;
  /** Per-model overrides keyed by model id, bare or provider-prefixed. */
  perModel: Record<string, PromptcapModelConfig>;
}

export interface ImagesConfig {
  /** Shrink images as they enter history. Off = send what the tool produced,
   *  which the provider then downscales on arrival anyway. */
  enabled: boolean;
  /** Longest edge an image may keep, in pixels (default 1568). */
  maxEdge: number;
  /** Visual-token budget, one token per 28x28 patch (default 1568). Together
   *  with maxEdge these are Claude's own standard-tier limits, so an image
   *  sent at the resulting size arrives unresampled. */
  maxVisualTokens: number;
  /** Quality of the JPEG candidate, 1-100 (default 80). Lower trades legible
   *  small text for bytes; PNG still wins whenever it encodes smaller. */
  jpegQuality: number;
  /** Base64 size that forces a re-encode even when the dimensions already fit
   *  (default 786432). A screenshot kept as PNG is several times its JPEG. */
  maxBytes: number;
}

export interface AfterEditCommandConfig {
  run: string;
  globs?: string[];
  enabled?: boolean;
}

export interface LspServerConfig {
  command?: string[];
  extensions?: string[];
  rootMarkers?: string[];
  enabled?: boolean;
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface LspConfig {
  /** Append what running language servers report for a file to each edit and write result. */
  diagnosticsAfterEdit: boolean;
  /** Overrides of the built-in servers by name, and additional servers. */
  servers: Record<string, LspServerConfig>;
}

export interface PiPiConfig {
  general: {
    logLevel: LogLevel;
    tracing: boolean;
  };
  commands: {
    afterEdit: Record<string, AfterEditCommandConfig>;
  };
  lsp: LspConfig;
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
  promptcap: PromptcapConfig;
  images: ImagesConfig;
  providers: ProvidersConfig;
  models: ModelsConfig;
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
      /** Worker silence before it is flagged. 0 disables. */
      workerStallWarn: DurationValue;
      /** How long a worker run may take to produce its first event before it fails. 0 disables. */
      workerStartTimeout: DurationValue;
      /** Silence from the model on one request before a worker abandons and retries it. 0 disables. */
      workerModelStale: DurationValue;
      /** How long a worker's question waits for an answer. */
      workerQuestionTimeout: DurationValue;
      /** Timeout a worker's bash call gets when it sets none. 0 disables. */
      workerBashTimeout: DurationValue;
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
      workerStallWarn: number;
      workerStartTimeout: number;
      workerModelStale: number;
      workerQuestionTimeout: number;
      workerBashTimeout: number;
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
  lsp: {
    diagnosticsAfterEdit: true,
    servers: {},
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
  promptcap: {
    enabled: true,
    perModel: {},
  },
  images: {
    enabled: true,
    maxEdge: 1568,
    maxVisualTokens: 1568,
    jpegQuality: 80,
    maxBytes: 768 * 1024,
  },
  providers: {
    order: ["claude-sub", "codex", "copilot", "llm-api"],
    // Every provider is on by default and costs nothing without credentials:
    // one without them serves no models, so resolution passes over it.
    "claude-sub": { enabled: true, route: ["llm-api", "direct"] },
    codex: { enabled: true },
    copilot: { enabled: true },
    "llm-api": { enabled: true, autoUpdate: true, cacheTTLDays: 3 },
    fallback: { auto: true, retryAfterMinutes: 10 },
  },
  models: {
    claude: { override: null, pins: {} },
    gpt: { override: null, pins: {} },
  },
  agents: {
    main: { model: "claude/opus", thinking: "high" },
    maxConcurrentSubagents: 7,
    subagents: {
      simple: {
        explore: { model: "gpt/luna", thinking: "medium" },
        librarian: { model: "gpt/luna", thinking: "medium" },
        task: { model: "claude/opus", thinking: "medium" },
      },
      pools: {
        // Same pair in every pool: the top-end GPT for a genuinely foreign read,
        // the latest Fable for a same-vendor one. Roles differ in what they are
        // ASKED, not in which models answer.
        advisors: [
          { enabled: true, model: "gpt/astra:pro", thinking: "high" },
          { enabled: true, model: "claude/fable", thinking: "high" },
        ],
        reviewers: [
          { enabled: true, model: "gpt/astra:pro", thinking: "high" },
          { enabled: true, model: "claude/fable", thinking: "high" },
        ],
        deepDebuggers: [
          { enabled: true, model: "gpt/astra:pro", thinking: "high" },
          { enabled: true, model: "claude/fable", thinking: "high" },
        ],
      },
    },
  },
  performance: {
    commands: {
      afterEdit: "30s",
    },
    internals: {
      workerStallWarn: "3m",
      workerStartTimeout: "1m",
      workerModelStale: "10m",
      workerQuestionTimeout: "10m",
      workerBashTimeout: "10m",
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

function validatePromptcap(value: unknown): void {
  const c = requireObject(value, "config.promptcap");
  ensureBool(c.enabled, "config.promptcap.enabled");
  ensureBool(c.longCacheRetention, "config.promptcap.longCacheRetention");
  ensureNumberInRange(c.maxPromptTokens, "config.promptcap.maxPromptTokens", 1000, 100_000_000);
  ensureNumberInRange(c.contextWindow, "config.promptcap.contextWindow", 1000, 100_000_000);
  ensureNumberInRange(c.headroomTokens, "config.promptcap.headroomTokens", 1000, 100_000_000);
  ensureNumberInRange(c.imageTokens, "config.promptcap.imageTokens", 1, 10_000_000);
  ensureNumberInRange(c.imageBytesCeiling, "config.promptcap.imageBytesCeiling", 1024, 64 * 1024 * 1024);
  ensureNumberInRange(c.imageBytesLowWater, "config.promptcap.imageBytesLowWater", 0, 64 * 1024 * 1024);
  // Excludes both ends: at 0 a fold would aim at the floor and strip every
  // call it has, and at 1 it would aim at the ceiling it just crossed and fire
  // again on the next request.
  if (c.keepFraction !== undefined) {
    const f = c.keepFraction;
    if (typeof f !== "number" || !Number.isFinite(f) || f <= 0 || f >= 1) {
      throw new Error("config.promptcap.keepFraction must be a number between 0 and 1, exclusive");
    }
  }
  if (c.perModel !== undefined) {
    const perModel = requireObject(c.perModel, "config.promptcap.perModel");
    for (const [modelId, override] of Object.entries(perModel)) {
      const o = requireObject(override, `config.promptcap.perModel.${modelId}`);
      ensureNumberInRange(o.maxPromptTokens, `config.promptcap.perModel.${modelId}.maxPromptTokens`, 1000, 100_000_000);
      ensureNumberInRange(o.contextWindow, `config.promptcap.perModel.${modelId}.contextWindow`, 1000, 100_000_000);
      ensureNumberInRange(o.imageTokens, `config.promptcap.perModel.${modelId}.imageTokens`, 1, 10_000_000);
    }
  }
}

function ensureDuration(value: unknown, path: string): void {
  if (value === undefined) return;
  if (parseDuration(value as DurationValue) === null) {
    throw new Error(`${path} must be a valid duration (number or string like 30s, 5m, 1h)`);
  }
}

function validateImages(value: unknown): void {
  const i = requireObject(value, "config.images");
  ensureBool(i.enabled, "config.images.enabled");
  ensureNumberInRange(i.maxEdge, "config.images.maxEdge", 28, 8000);
  ensureNumberInRange(i.maxVisualTokens, "config.images.maxVisualTokens", 1, 100_000);
  ensureNumberInRange(i.jpegQuality, "config.images.jpegQuality", 1, 100);
  ensureNumberInRange(i.maxBytes, "config.images.maxBytes", 1024, 5 * 1024 * 1024);
}

const PROVIDER_NAMES: readonly ProviderName[] = ["claude-sub", "codex", "copilot", "llm-api"];
const CLAUDE_SUB_ROUTES: readonly ClaudeSubRoute[] = ["direct", "llm-api"];
const FAMILY_SLOTS: Record<FamilyName, readonly SlotName[]> = {
  claude: ["haiku", "sonnet", "opus", "fable"],
  gpt: ["luna", "terra", "sol", "astra"],
};

function ensureUniqueList<T extends string>(value: unknown, allowed: readonly T[], path: string, nonEmpty: boolean): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => !allowed.includes(v)) || new Set(value).size !== value.length || (nonEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${nonEmpty ? "a non-empty" : "an"} array of distinct values from: ${allowed.join(", ")}`);
  }
}

function validateProviders(value: unknown): void {
  const p = requireObject(value, "config.providers");
  ensureUniqueList(p.order, PROVIDER_NAMES, "config.providers.order", true);
  for (const name of PROVIDER_NAMES) {
    if (p[name] === undefined) continue;
    const entry = requireObject(p[name], `config.providers.${name}`);
    ensureBool(entry.enabled, `config.providers.${name}.enabled`);
  }
  if (p["claude-sub"] !== undefined) {
    ensureUniqueList((p["claude-sub"] as Record<string, unknown>).route, CLAUDE_SUB_ROUTES, "config.providers.claude-sub.route", true);
  }
  if (p["llm-api"] !== undefined) {
    const api = p["llm-api"] as Record<string, unknown>;
    ensureBool(api.autoUpdate, "config.providers.llm-api.autoUpdate");
    ensureNumberInRange(api.cacheTTLDays, "config.providers.llm-api.cacheTTLDays", 1, 365);
  }
  if (p.fallback !== undefined) {
    const f = requireObject(p.fallback, "config.providers.fallback");
    ensureBool(f.auto, "config.providers.fallback.auto");
    ensureNumberInRange(f.retryAfterMinutes, "config.providers.fallback.retryAfterMinutes", 1, 1440);
  }
}

function validateSlotMap(value: unknown, family: FamilyName, path: string, allowNull = false): void {
  if (value === undefined) return;
  const map = requireObject(value, path);
  for (const [slot, id] of Object.entries(map)) {
    if (!FAMILY_SLOTS[family].includes(slot as SlotName)) {
      throw new Error(`${path}.${slot} is not a ${family} slot (expected one of: ${FAMILY_SLOTS[family].join(", ")})`);
    }
    if (allowNull && id === null) continue;
    ensureString(id, `${path}.${slot}`);
  }
}

function validateModels(value: unknown): void {
  const m = requireObject(value, "config.models");
  for (const key of Object.keys(m)) {
    if (!(key in FAMILY_SLOTS)) throw new Error(`config.models.${key} is not a family (expected claude or gpt)`);
  }
  for (const family of Object.keys(FAMILY_SLOTS) as FamilyName[]) {
    if (m[family] === undefined) continue;
    const f = requireObject(m[family], `config.models.${family}`);
    if (f.override !== undefined && f.override !== null) {
      const o = requireObject(f.override, `config.models.${family}.override`);
      if (typeof o.provider !== "string" || !o.provider || o.provider.includes("/")) {
        throw new Error(`config.models.${family}.override.provider must be a provider name`);
      }
      if (typeof o.model !== "string" || !o.model) throw new Error(`config.models.${family}.override.model must be a non-empty string`);
      validateSlotMap(o.slots, family, `config.models.${family}.override.slots`);
    }
    // `null` in a layer cancels a pin from the layer below: "latest" here.
    validateSlotMap(f.pins, family, `config.models.${family}.pins`, true);
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

  if (config.promptcap !== undefined) validatePromptcap(config.promptcap);
  if (config.images !== undefined) validateImages(config.images);
  if (config.schema !== undefined && (typeof config.schema !== "number" || !Number.isInteger(config.schema))) {
    throw new Error("config.schema must be an integer");
  }
  if (config.providers !== undefined) validateProviders(config.providers);
  if (config.models !== undefined) validateModels(config.models);

  if (config.commands !== undefined) {
    const commands = requireObject(config.commands, "config.commands");
    if (commands.afterEdit !== undefined) {
      const afterEdit = requireObject(commands.afterEdit, "config.commands.afterEdit");
      for (const [id, entry] of Object.entries(afterEdit)) {
        const cmd = requireObject(entry, `config.commands.afterEdit.${id}`);
        // Partial, like every other layered section: a project layer may
        // override only `globs` or `enabled` for a command the global layer
        // defines. `run` is required on the MERGED result instead.
        if (cmd.run !== undefined && (typeof cmd.run !== "string" || cmd.run.length === 0)) {
          throw new Error(`config.commands.afterEdit.${id}.run must be a non-empty string`);
        }
        ensureBool(cmd.enabled, `config.commands.afterEdit.${id}.enabled`);
        if (cmd.globs !== undefined && (!Array.isArray(cmd.globs) || cmd.globs.some((g) => typeof g !== "string" || g.length === 0))) {
          throw new Error(`config.commands.afterEdit.${id}.globs must be an array of non-empty strings`);
        }
      }
    }
  }

  if (config.lsp !== undefined) validateLsp(config.lsp);

  if (config.agents !== undefined) {
    const agents = requireObject(config.agents, "config.agents");

    ensureMaxConcurrentSubagents(agents.maxConcurrentSubagents);

    if (agents.main !== undefined) {
      validateAgentPartial(agents.main, "config.agents.main");
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
      for (const key of INTERNAL_DURATION_KEYS) ensureDuration(internals[key], `config.performance.internals.${key}`);
    }
  }
}

function ensureStringList(value: unknown, path: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0))) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
}

// Partial per layer, like afterEdit: a project may set only `enabled` on a
// server the built-ins or the global layer define. Completeness is checked
// once the layers are resolved, where a server missing its command is reported.
function validateLsp(value: unknown): void {
  const lsp = requireObject(value, "config.lsp");
  ensureBool(lsp.diagnosticsAfterEdit, "config.lsp.diagnosticsAfterEdit");
  if (lsp.servers === undefined) return;
  const servers = requireObject(lsp.servers, "config.lsp.servers");
  for (const [name, entry] of Object.entries(servers)) {
    const path = `config.lsp.servers.${name}`;
    const server = requireObject(entry, path);
    ensureStringList(server.command, `${path}.command`);
    if (Array.isArray(server.command) && server.command.length === 0) throw new Error(`${path}.command must not be empty`);
    ensureStringList(server.extensions, `${path}.extensions`);
    ensureStringList(server.rootMarkers, `${path}.rootMarkers`);
    ensureBool(server.enabled, `${path}.enabled`);
    if (server.env !== undefined) {
      const env = requireObject(server.env, `${path}.env`);
      for (const [key, val] of Object.entries(env)) if (typeof val !== "string") throw new Error(`${path}.env.${key} must be a string`);
    }
    if (server.initializationOptions !== undefined) requireObject(server.initializationOptions, `${path}.initializationOptions`);
    if (server.settings !== undefined) requireObject(server.settings, `${path}.settings`);
  }
}

const INTERNAL_DURATION_KEYS = ["workerStallWarn", "workerStartTimeout", "workerModelStale", "workerQuestionTimeout", "workerBashTimeout", "mainTurnStale"] as const;

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
  for (const [id, cmd] of Object.entries(typed.commands?.afterEdit ?? {})) {
    if (typeof cmd?.run !== "string" || cmd.run.length === 0) {
      throw new Error(`config.commands.afterEdit.${id}.run must be a non-empty string`);
    }
  }
  for (const key of INTERNAL_DURATION_KEYS) {
    if (parseDuration(typed.performance.internals[key]) === null) {
      throw new Error(`config.performance.internals.${key} must be a valid duration`);
    }
  }
}

export function normalizeConfigDurations(config: PiPiConfig): NormalizedPiPiConfig {
  const next = structuredClone(config) as NormalizedPiPiConfig;

  const afterEdit = parseDuration(next.performance.commands.afterEdit);
  if (afterEdit === null) throw new Error("Failed to normalize config durations");
  next.performance.commands.afterEdit = afterEdit;
  for (const key of INTERNAL_DURATION_KEYS) {
    const value = parseDuration(next.performance.internals[key]);
    if (value === null) throw new Error("Failed to normalize config durations");
    next.performance.internals[key] = value;
  }
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

/**
 * A family override replaces the one below it whole: merging two would let a
 * project's provider inherit the global layer's per-slot model ids, which name
 * models on a different provider. `null` in a layer cancels the one below.
 */
function applyAtomicOverrides(merged: Record<string, any>, layers: Array<Record<string, any> | null>): void {
  for (const family of Object.keys(FAMILY_SLOTS) as FamilyName[]) {
    for (const layer of layers) {
      const value = layer?.models?.[family]?.override;
      if (value !== undefined) merged.models[family].override = structuredClone(value);
    }
  }
}

// An order list that leaves a provider out still ranks it, last, so a provider
// added in a later release is not silently unusable for configs written before.
function completeProviderOrder(merged: Record<string, any>): void {
  const order: ProviderName[] = merged.providers.order;
  merged.providers.order = [...order, ...PROVIDER_NAMES.filter((name) => !order.includes(name))];
}

// Workers no longer carry run, turn or silence limits: the parent watches them
// and decides. A layer written for an older version may still set them.
function dropRetiredWorkerLimits(config: Record<string, any>): void {
  const internals = config.performance?.internals;
  if (isObject(internals)) {
    for (const key of ["subagentStale", "workerTimeout", "workerStallKill"]) delete internals[key];
  }
  const agents = config.agents;
  if (!isObject(agents)) return;
  const entries: unknown[] = [agents.main];
  const subagents = isObject(agents.subagents) ? agents.subagents : {};
  if (isObject(subagents.simple)) entries.push(...Object.values(subagents.simple));
  if (isObject(subagents.pools)) {
    for (const pool of Object.values(subagents.pools)) if (Array.isArray(pool)) entries.push(...pool);
  }
  for (const entry of entries) if (isObject(entry)) delete entry.maxTurns;
}

function prepareLayer(raw: Record<string, any> | null, name: string): Record<string, any> | null {
  if (!raw) return null;
  const { config, changed } = migrateConfigLayer(raw);
  if (changed) getLogger().debug({ s: "config", layer: name }, "migrated a config layer from the provider-tier schema in memory");
  dropRetiredWorkerLimits(config);
  validateConfig(config);
  return config;
}

export function mergeConfigLayers(
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
): NormalizedPiPiConfig {
  const log = getLogger();
  let merged = getDefaultConfig() as Record<string, any>;
  const layers = [prepareLayer(globalConfig, "global"), prepareLayer(projectConfig, "project")];
  for (const layer of layers) {
    if (layer) merged = deepMerge(merged, layer);
  }
  applyAtomicOverrides(merged, layers);
  completeProviderOrder(merged);

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

export type RoutingSettings = Pick<PiPiConfig, "providers" | "models">;

// Side-effect-free read of the routing sections. Unlike loadConfig, this NEVER
// mkdirs: it reads the global config always and <cwd>/.pp/config.json only if
// it already exists. Used at extension init and in subagents, where the real
// project cwd is not yet known and a stray .pp in the launch dir must be avoided.
export function readScopedRoutingSettings(cwd?: string, globalConfigPath = GLOBAL_CONFIG_PATH): RoutingSettings {
  const defaults = getDefaultConfig();
  let merged: Record<string, any> = { providers: defaults.providers, models: defaults.models };
  const pick = (raw: Record<string, any> | null) => {
    const layer = prepareLayer(raw ? { providers: raw.providers, models: raw.models, flant: raw.flant } : null, "routing");
    return layer ? { providers: layer.providers, models: layer.models } : null;
  };
  const projectPath = cwd ? join(cwd, ".pp", "config.json") : null;
  const layers = [pick(loadJsonFile(globalConfigPath)), pick(projectPath && existsSync(projectPath) ? loadJsonFile(projectPath) : null)];
  for (const layer of layers) {
    if (layer) merged = deepMerge(merged, Object.fromEntries(Object.entries(layer).filter(([, v]) => v !== undefined)));
  }
  applyAtomicOverrides(merged, layers);
  completeProviderOrder(merged);
  return merged as RoutingSettings;
}

/**
 * Persist the provider-tier → providers/models migration of one config file.
 * The original is kept beside it as `.pre-routing.bak` (never overwritten, so a
 * second run cannot replace the user's real original with a migrated copy), and
 * the rewrite goes through a temp file under the config lock.
 */
export function migrateConfigFile(configPath: string, legacyPolicy?: (globalFlant: Record<string, unknown>) => Record<string, unknown> | null): boolean {
  const legacyOnly = !existsSync(configPath);
  if (legacyOnly) {
    const policy = legacyPolicy?.({});
    if (!policy || Object.keys(policy).length === 0) return false;
    ensureConfigDir(configPath);
    writeFileSync(configPath, "{}\n", "utf-8");
  }
  const release = lockfile.lockSync(configPath, { stale: 10000 });
  try {
    const raw = loadJsonFile(configPath) ?? {};
    const policy = legacyPolicy?.(isObject(raw.flant) ? raw.flant : {});
    if (policy && Object.keys(policy).length > 0) raw.flant = { ...(isObject(raw.flant) ? raw.flant : {}), ...policy };
    const { config, changed } = migrateConfigLayer(raw);
    if (!changed) return false;
    validateConfig(config);
    const backup = `${configPath}.pre-routing.bak`;
    if (!existsSync(backup) && !legacyOnly) copyFileSync(configPath, backup);
    const temp = `${configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", "utf-8");
      renameSync(temp, configPath);
    } catch (err) {
      try { unlinkSync(temp); } catch { /* never created */ }
      throw err;
    }
    getLogger().info({ s: "config", configPath, backup }, "migrated config to the providers/models schema");
    return true;
  } finally {
    release();
  }
}

// A write carries the file onto the current schema with it, so an old project
// config is rewritten the first time the user edits it rather than on load, and
// the stamp keeps every pin written from now on from being read as a legacy one.
function readForWrite(configPath: string): Record<string, any> {
  const raw = readRawConfig(configPath);
  const { config, changed } = migrateConfigLayer(raw);
  if (changed) {
    const backup = `${configPath}.pre-routing.bak`;
    if (!existsSync(backup)) copyFileSync(configPath, backup);
  }
  dropRetiredWorkerLimits(config);
  config.schema = CONFIG_SCHEMA;
  return config;
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

    const raw = readForWrite(configPath);
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

    const raw = readForWrite(configPath);
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

/**
 * `lsp.servers` per layer, unmerged: whether a project may choose the command
 * a server runs depends on whether pi trusts the project, which the merged
 * config no longer shows.
 */
export function readLspServerLayers(cwd: string, globalConfigPath = GLOBAL_CONFIG_PATH): { global?: Record<string, LspServerConfig>; project?: Record<string, LspServerConfig> } {
  const servers = (path: string) => {
    try {
      const value = loadJsonFile(path)?.lsp?.servers;
      return isObject(value) ? (value as Record<string, LspServerConfig>) : undefined;
    } catch {
      return undefined;
    }
  };
  return { global: servers(globalConfigPath), project: servers(join(cwd, ".pp", "config.json")) };
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
