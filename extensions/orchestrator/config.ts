import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface ModelConfig {
  model: string;
  thinking: string;
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
  lockStale: number;
  lockUpdate: number;
}

export interface PiPiConfig {
  mainModel: {
    implement: ModelConfig;
    debug: ModelConfig;
    brainstorm: ModelConfig;
  };
  planners: Record<string, VariantConfig>;
  planReviewers: Record<string, VariantConfig>;
  codeReviewers: Record<string, VariantConfig>;
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
  maxAutoReviewRounds: number;
}

const DEFAULT_CONFIG: PiPiConfig = {
  mainModel: {
    implement: { model: "anthropic/claude-opus-4-6", thinking: "high" },
    debug: { model: "openai/gpt-5.4", thinking: "high" },
    brainstorm: { model: "anthropic/claude-opus-4-6", thinking: "high" },
  },
  planners: {
    opus: { enabled: true, model: "anthropic/claude-opus-4-6", thinking: "high" },
    gpt: { enabled: true, model: "openai/gpt-5.4", thinking: "high" },
    gemini: { enabled: true, model: "google/gemini-3.1-pro", thinking: "high" },
    grok: { enabled: true, model: "xai/grok-4", thinking: "high" },
  },
  planReviewers: {
    opus: { enabled: true, model: "anthropic/claude-opus-4-6", thinking: "high" },
    gpt: { enabled: true, model: "openai/gpt-5.4", thinking: "high" },
  },
  codeReviewers: {
    opus: { enabled: true, model: "anthropic/claude-opus-4-6", thinking: "high" },
    gpt: { enabled: true, model: "openai/gpt-5.4", thinking: "high" },
    gemini: { enabled: false, model: "google/gemini-3.1-pro", thinking: "high" },
    grok: { enabled: false, model: "xai/grok-4", thinking: "high" },
  },
  agents: {
    explore: { model: "google/gemini-3.1-flash", thinking: "low" },
    librarian: { model: "google/gemini-3.1-flash", thinking: "medium" },
    task: { model: "anthropic/claude-opus-4-6", thinking: "medium" },
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
    lockStale: 600000,
    lockUpdate: 30000,
  },
  autoCommit: true,
  maxAutoReviewRounds: 2,
};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
    for (const key of ["implement", "debug", "brainstorm"]) {
      const mc = config.mainModel[key];
      if (mc && typeof mc.model === "string" && mc.model.length === 0) {
        throw new Error(`config.mainModel.${key}.model must be non-empty`);
      }
    }
  }

  for (const group of ["planners", "planReviewers", "codeReviewers"]) {
    const variants = config[group];
    if (!variants || typeof variants !== "object") continue;
    for (const [name, v] of Object.entries(variants)) {
      const variant = v as Record<string, any>;
      if (variant.enabled && (!variant.model || typeof variant.model !== "string" || variant.model.length === 0)) {
        throw new Error(`config.${group}.${name} is enabled but has no model`);
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

  if (config.maxAutoReviewRounds !== undefined && (typeof config.maxAutoReviewRounds !== "number" || config.maxAutoReviewRounds < 0)) {
    throw new Error("config.maxAutoReviewRounds must be a non-negative number");
  }

  if (config.timeouts) {
    for (const [key, val] of Object.entries(config.timeouts)) {
      if (typeof val !== "number" || val < 0) {
        throw new Error(`config.timeouts.${key} must be a non-negative number`);
      }
    }
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

export function loadConfig(cwd: string): PiPiConfig {
  const ppDir = join(cwd, ".pp");
  const configPath = join(ppDir, "config.json");

  if (!existsSync(ppDir)) {
    mkdirSync(ppDir, { recursive: true });
  }

  let userConfig: Record<string, any> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    try {
      userConfig = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`Failed to parse ${configPath}: ${err.message}`);
    }
  } else {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
  }

  validateConfig(userConfig);

  return deepMerge(DEFAULT_CONFIG, userConfig) as unknown as PiPiConfig;
}
