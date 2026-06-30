import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { PiPiConfig } from "./config.js";
import { updateRegistryFromAvailableModels } from "./model-registry.js";
import { compareModelVersion } from "./model-version.js";
import { getLogger } from "./log.js";

export interface OpenRouterModelData {
  name: string;
  context_length: number;
  max_completion_tokens: number;
  pricing: {
    prompt: number;
    completion: number;
    cacheRead: number;
    cacheWrite: number;
  };
  modality: string;
}

export interface FlantSettings {
  enabled: boolean;
  autoUpdate: boolean;
  cacheTTLDays: number;
  lastUpdated: string | null;
  cachedFlantModels: string[] | null;
  cachedOpenRouterData: Record<string, OpenRouterModelData> | null;
}

const GEMINI_MAP: Record<string, string> = {
  "gemini-3-flash": "google/gemini-3.0-flash",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
};

function resolveAgentDir(): string {
  const envKey = "PI_CODING_AGENT_DIR";
  const envDir = process.env[envKey];
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

const SETTINGS_DIR = join(resolveAgentDir(), "extensions", "pp", "cache");
const SETTINGS_PATH = join(SETTINGS_DIR, "flant-models.json");
const DEFAULT_SETTINGS: FlantSettings = {
  enabled: false,
  autoUpdate: true,
  cacheTTLDays: 7,
  lastUpdated: null,
  cachedFlantModels: null,
  cachedOpenRouterData: null,
};

let piRef: ExtensionAPI | null = null;
let generatedFlantConfig: Partial<PiPiConfig> | null = null;

export function setPI(pi: ExtensionAPI): void {
  piRef = pi;
}

export function clearFlantGeneratedConfig(): void {
  generatedFlantConfig = null;
}

export function unregisterFlantProviders(pi?: ExtensionAPI): void {
  const api = pi ?? piRef;
  if (!api) return;
  api.unregisterProvider("pp-flant-anthropic");
  api.unregisterProvider("pp-flant-openai");
}

function ensureSettingsDir(): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeSettings(raw: unknown): FlantSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const value = raw as Record<string, unknown>;
  const cacheTTLDays = Math.max(1, Math.round(toNumber(value.cacheTTLDays, DEFAULT_SETTINGS.cacheTTLDays)));
  return {
    enabled: !!value.enabled,
    autoUpdate: value.autoUpdate === undefined ? true : !!value.autoUpdate,
    cacheTTLDays,
    lastUpdated: typeof value.lastUpdated === "string" ? value.lastUpdated : null,
    cachedFlantModels: Array.isArray(value.cachedFlantModels)
      ? value.cachedFlantModels.filter((m): m is string => typeof m === "string")
      : null,
    cachedOpenRouterData: value.cachedOpenRouterData && typeof value.cachedOpenRouterData === "object"
      ? value.cachedOpenRouterData as Record<string, OpenRouterModelData>
      : null,
  };
}

export function loadFlantSettings(): FlantSettings {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveFlantSettings(settings: FlantSettings): void {
  ensureSettingsDir();
  if (!existsSync(SETTINGS_PATH)) writeFileSync(SETTINGS_PATH, "{}\n", "utf-8");
  const release = lockfile.lockSync(SETTINGS_PATH, { stale: 10000 });
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

function toTitleCase(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "gpt") return "GPT";
  if (lower === "o3") return "O3";
  if (lower === "qwen") return "Qwen";
  if (lower === "claude") return "Claude";
  if (lower === "api") return "API";
  if (lower === "ai") return "AI";
  if (!token.length) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function generateDisplayName(flantId: string): string {
  const parts = flantId.split("-").filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (/^\d+$/.test(part)) {
      const versionParts = [part];
      i += 1;
      while (i < parts.length && /^\d+$/.test(parts[i])) {
        versionParts.push(parts[i]);
        i += 1;
      }
      out.push(versionParts.join("."));
      continue;
    }
    out.push(toTitleCase(part));
    i += 1;
  }
  return out.join(" ");
}

function mapClaudeModelId(modelId: string): string {
  const rest = modelId.slice("claude-".length);
  const parts = rest.split("-").filter(Boolean);
  const firstNumber = parts.findIndex((p) => /^\d+$/.test(p));
  if (firstNumber === -1) return `anthropic/claude-${rest}`;
  const family = parts.slice(0, firstNumber).join("-");
  const version = parts.slice(firstNumber).join(".");
  return family.length > 0
    ? `anthropic/claude-${family}-${version}`
    : `anthropic/claude-${version}`;
}

function normalizeQwenRest(rest: string): string {
  let value = rest;
  if (value.startsWith("-")) value = value.slice(1);
  if (!value) return "default";
  return value;
}

function mapFlantToOpenRouterId(modelId: string): string | null {
  if (GEMINI_MAP[modelId]) return GEMINI_MAP[modelId];
  if (modelId.startsWith("claude-")) return mapClaudeModelId(modelId);
  if (modelId.startsWith("gpt-")) return `openai/${modelId}`;
  if (modelId.startsWith("deepseek-")) return `deepseek/deepseek-${modelId.slice("deepseek-".length)}`;
  if (modelId.startsWith("grok-")) return `x-ai/grok-${modelId.slice("grok-".length)}`;
  if (modelId.startsWith("minimax-")) return `minimax/minimax-${modelId.slice("minimax-".length)}`;
  if (modelId.startsWith("qwen")) return `qwen/qwen-${normalizeQwenRest(modelId.slice("qwen".length))}`;
  if (modelId.startsWith("o3-")) return `openai/o3-${modelId.slice("o3-".length)}`;
  if (modelId.startsWith("sonar-")) return `perplexity/sonar-${modelId.slice("sonar-".length)}`;
  return null;
}

export async function discoverFlantModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://llm-api.flant.ru/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`Flant API returned ${res.status}`);
  }
  const payload = await res.json() as { data?: Array<{ id?: unknown }> };
  const models = (payload.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id : ""))
    .filter((id) => id.length > 0 && !id.startsWith("or/"));
  return [...new Set(models)];
}

export async function fetchOpenRouterMetadata(modelIds: string[]): Promise<Record<string, OpenRouterModelData>> {
  const mapping = new Map<string, string>();
  for (const modelId of modelIds) {
    const mapped = mapFlantToOpenRouterId(modelId);
    if (mapped) mapping.set(modelId, mapped);
  }
  if (mapping.size === 0) return {};

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}`);
  }

  const payload = await res.json() as { data?: Array<Record<string, unknown>> };
  const modelMap = new Map<string, Record<string, unknown>>();
  for (const item of payload.data ?? []) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id) modelMap.set(id, item);
  }

  const out: Record<string, OpenRouterModelData> = {};
  for (const [flantModelId, openRouterId] of mapping.entries()) {
    const model = modelMap.get(openRouterId);
    if (!model) continue;
    const pricing = model.pricing && typeof model.pricing === "object"
      ? model.pricing as Record<string, unknown>
      : {};
    const architecture = model.architecture && typeof model.architecture === "object"
      ? model.architecture as Record<string, unknown>
      : {};
    const topProvider = model.top_provider && typeof model.top_provider === "object"
      ? model.top_provider as Record<string, unknown>
      : {};
    out[flantModelId] = {
      name: typeof model.name === "string" ? model.name : generateDisplayName(flantModelId),
      context_length: toNumber(model.context_length, 200000),
      max_completion_tokens: toNumber(topProvider.max_completion_tokens, 32000),
      pricing: {
        prompt: toNumber(pricing.prompt, 0),
        completion: toNumber(pricing.completion, 0),
        cacheRead: toNumber(pricing.input_cache_read, 0),
        cacheWrite: toNumber(pricing.input_cache_write, 0),
      },
      modality: typeof architecture.modality === "string" ? architecture.modality : "text",
    };
  }
  return out;
}

function modelSpec(modelId: string): string {
  const provider = modelId.startsWith("claude-") ? "pp-flant-anthropic" : "pp-flant-openai";
  return `${provider}/${modelId}`;
}

function buildProviderModelConfig(
  flantModelId: string,
  metadata: Record<string, OpenRouterModelData>,
): ProviderModelConfig {
  const modelMeta = metadata[flantModelId];
  const modality = (modelMeta?.modality ?? "text").toLowerCase();
  return {
    id: flantModelId,
    name: modelMeta?.name ?? generateDisplayName(flantModelId),
    reasoning: true,
    input: modality.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: toNumber(modelMeta?.pricing.prompt, 0) * 1_000_000,
      output: toNumber(modelMeta?.pricing.completion, 0) * 1_000_000,
      cacheRead: toNumber(modelMeta?.pricing.cacheRead, 0) * 1_000_000,
      cacheWrite: toNumber(modelMeta?.pricing.cacheWrite, 0) * 1_000_000,
    },
    contextWindow: toNumber(modelMeta?.context_length, 200000),
    maxTokens: toNumber(modelMeta?.max_completion_tokens, 32000),
  };
}

export function registerFlantProviders(
  pi: ExtensionAPI,
  models: string[],
  metadata: Record<string, OpenRouterModelData>,
): void {
  const log = getLogger();
  const uniqueModels = [...new Set(models)];
  const anthropicModels = uniqueModels.filter((m) => m.startsWith("claude-"));
  const openaiModels = uniqueModels.filter((m) => !m.startsWith("claude-"));
  log.debug({ s: "flant", total: uniqueModels.length, anthropic: anthropicModels.length, openai: openaiModels.length }, "registering flant providers");

  unregisterFlantProviders(pi);

  pi.registerProvider("pp-flant-anthropic", {
    api: "anthropic-messages",
    baseUrl: "https://llm-api.flant.ru",
    apiKey: "$FLANT_API_KEY",
    models: anthropicModels.map((m) => buildProviderModelConfig(m, metadata)),
  });

  pi.registerProvider("pp-flant-openai", {
    api: "openai-completions",
    baseUrl: "https://llm-api.flant.ru/v1",
    apiKey: "$FLANT_API_KEY",
    models: openaiModels.map((m) => buildProviderModelConfig(m, metadata)),
  });

  updateRegistryFromAvailableModels([
    ...anthropicModels.map((id) => `pp-flant-anthropic/${id}`),
    ...openaiModels.map((id) => `pp-flant-openai/${id}`),
  ]);
}

function pickLatest(models: string[]): string | null {
  if (models.length === 0) return null;
  return models
    .slice()
    .sort((a, b) => compareModelVersion(b, a))[0] ?? null;
}

function pickCheapestFastModel(models: string[]): string | null {
  const geminiFlashLite = pickLatest(models.filter((m) => /^gemini-.*flash-lite/.test(m)));
  if (geminiFlashLite) return geminiFlashLite;
  const geminiFlash = pickLatest(models.filter((m) => /^gemini-.*flash/.test(m) && !m.includes("flash-lite")));
  if (geminiFlash) return geminiFlash;
  const gptMini = pickLatest(models.filter((m) => /^gpt-5.*-mini$/.test(m)));
  if (gptMini) return gptMini;
  return pickLatest(models.filter((m) => /^claude-haiku-/.test(m)));
}

function makeVariant(modelId: string | null, fallbackModelId: string): { enabled: boolean; model: string; thinking: string } {
  if (!modelId) return { enabled: false, model: modelSpec(fallbackModelId), thinking: "high" };
  return { enabled: true, model: modelSpec(modelId), thinking: "high" };
}

function makeVariantWithThinking(
  modelId: string | null,
  fallbackModelId: string,
  thinking: string,
): { enabled: boolean; model: string; thinking: string } {
  if (!modelId) return { enabled: false, model: modelSpec(fallbackModelId), thinking };
  return { enabled: true, model: modelSpec(modelId), thinking };
}

function buildPresetGroup(
  presets: Record<string, { enabled?: boolean; agents: Record<string, { enabled: boolean; model: string; thinking: string }> }>,
  defaultPreset = "regular",
): { default: string; presets: typeof presets } {
  return { default: defaultPreset, presets };
}

export function generateFlantConfig(models: string[]): Partial<PiPiConfig> {
  const uniqueModels = [...new Set(models)];
  if (uniqueModels.length === 0) return {};

  const latestOpus = pickLatest(uniqueModels.filter((m) => /^claude-opus-/.test(m)));
  const latestClaude = pickLatest(uniqueModels.filter((m) => /^claude-/.test(m)));
  const latestGpt5 = pickLatest(uniqueModels.filter((m) => /^gpt-5/.test(m) && !m.endsWith("-mini") && !m.endsWith("-codex")));
  const latestGpt = latestGpt5 ?? pickLatest(uniqueModels.filter((m) => /^gpt-/.test(m) && !m.endsWith("-mini") && !m.endsWith("-codex")));
  const latestGeminiPro = pickLatest(uniqueModels.filter((m) => /^gemini-.*-pro$/.test(m)));
  const latestDeepseek = pickLatest(uniqueModels.filter((m) => /^deepseek-/.test(m)));
  const latestGrok = pickLatest(uniqueModels.filter((m) => /^grok-/.test(m)));
  const fastest = pickCheapestFastModel(uniqueModels);

  const fallback = latestOpus ?? latestClaude ?? latestGpt ?? latestGeminiPro ?? latestDeepseek ?? latestGrok ?? uniqueModels[0];
  const implementModel = latestOpus ?? latestClaude ?? fallback;
  const debugModel = latestGpt ?? latestGeminiPro ?? latestDeepseek ?? fallback;
  const brainstormModel = latestOpus ?? latestClaude ?? fallback;
  const taskModel = latestOpus ?? latestClaude ?? fallback;
  const fastModel = fastest ?? debugModel;

  return {
    agents: {
      orchestrators: {
        implement: { model: modelSpec(implementModel), thinking: "high" },
        plan: { model: modelSpec(implementModel), thinking: "high" },
        debug: { model: modelSpec(debugModel), thinking: "high" },
        brainstorm: { model: modelSpec(brainstormModel), thinking: "high" },
        review: { model: modelSpec(implementModel), thinking: "high" },
        quick: { model: modelSpec(implementModel), thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: modelSpec(fastModel), thinking: "low" },
          librarian: { model: modelSpec(fastModel), thinking: "medium" },
          task: { model: modelSpec(taskModel), thinking: "medium" },
        },
        presetGroups: {
          planners: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback),
                gpt: makeVariant(latestGpt, fallback),
                gemini: makeVariant(latestGeminiPro, fallback),
              },
            },
          }),
          planReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback),
                gpt: makeVariant(latestGpt, fallback),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh"),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh"),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
          }),
          codeReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback),
                gpt: makeVariant(latestGpt, fallback),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh"),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh"),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
          }),
          brainstormReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback),
                gpt: makeVariant(latestGpt, fallback),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh"),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh"),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh"),
              },
            },
          }),
        },
      },
    },
  };
}

function isCacheValid(settings: FlantSettings): boolean {
  if (!settings.lastUpdated || !settings.cachedFlantModels || !settings.cachedOpenRouterData) return false;
  const updatedAt = new Date(settings.lastUpdated).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  const ttlMs = Math.max(1, settings.cacheTTLDays) * 24 * 60 * 60 * 1000;
  return Date.now() - updatedAt < ttlMs;
}

export function getFlantGeneratedConfig(): Partial<PiPiConfig> | null {
  return generatedFlantConfig;
}

(globalThis as any)[Symbol.for("pi-pi:flant-config")] = getFlantGeneratedConfig;

export async function updateFlantInfra(
  pi: ExtensionAPI,
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  setPI(pi);
  const settings = loadFlantSettings();

  let models = isCacheValid(settings) ? settings.cachedFlantModels : null;
  let metadata = isCacheValid(settings) ? settings.cachedOpenRouterData : null;
  let refreshed = false;

  if (!models || !metadata) {
    const apiKey = process.env.FLANT_API_KEY;
    if (!apiKey) {
      if (settings.cachedFlantModels && settings.cachedOpenRouterData) {
        models = settings.cachedFlantModels;
        metadata = settings.cachedOpenRouterData;
      } else {
        return { ok: false, error: "FLANT_API_KEY is not set" };
      }
    } else {
      try {
        models = await discoverFlantModels(apiKey);
        try {
          metadata = await fetchOpenRouterMetadata(models);
        } catch {
          metadata = settings.cachedOpenRouterData ?? {};
        }
        settings.cachedFlantModels = models;
        settings.cachedOpenRouterData = metadata;
        settings.lastUpdated = new Date().toISOString();
        saveFlantSettings(settings);
        refreshed = true;
      } catch (err: any) {
        if (settings.cachedFlantModels && settings.cachedOpenRouterData) {
          models = settings.cachedFlantModels;
          metadata = settings.cachedOpenRouterData;
        } else {
          return { ok: false, error: err?.message ?? "Failed to update Flant infrastructure" };
        }
      }
    }
  }

  if (!models || !metadata) {
    return { ok: false, error: "No Flant model data available" };
  }

  try {
    registerFlantProviders(pi, models, metadata);
    generatedFlantConfig = generateFlantConfig(models);
    if (!refreshed && settings.cachedFlantModels && settings.cachedOpenRouterData && !settings.lastUpdated) {
      settings.lastUpdated = new Date().toISOString();
      saveFlantSettings(settings);
    }
    return { ok: true, models };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Failed to register Flant providers" };
  }
}

export function initFlantSync(pi: ExtensionAPI): void {
  setPI(pi);
  const settings = loadFlantSettings();
  const log = getLogger();
  if (!settings.enabled) {
    log.debug({ s: "flant" }, "flant disabled");
    generatedFlantConfig = null;
    return;
  }
  if (settings.cachedFlantModels && settings.cachedOpenRouterData) {
    registerFlantProviders(pi, settings.cachedFlantModels, settings.cachedOpenRouterData);
    generatedFlantConfig = generateFlantConfig(settings.cachedFlantModels);
  }
}

export async function initFlantOnStartup(pi: ExtensionAPI): Promise<void> {
  setPI(pi);
  const settings = loadFlantSettings();
  if (!settings.enabled) {
    generatedFlantConfig = null;
    return;
  }
  if (!settings.autoUpdate) return;
  await updateFlantInfra(pi);
}
