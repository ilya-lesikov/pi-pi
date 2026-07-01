import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { refreshAnthropicToken } from "@earendil-works/pi-ai/oauth";
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
  /**
   * When true, additionally register the `pp-flant-anthropic-sub` provider,
   * which routes Claude requests through the gateway using the user's personal
   * Claude OAuth token (billed against their personal Claude subscription).
   */
  subscription: boolean;
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
  subscription: false,
};

/** Provider name for the personal-subscription Claude routing. */
export const SUB_PROVIDER = "pp-flant-anthropic-sub";

/** Prefix the gateway expects for personal-subscription Claude models. */
export const SUB_MODEL_PREFIX = "sub/";

/**
 * Read the Claude OAuth access token persisted by pi's built-in `anthropic`
 * OAuth provider. Returns null when absent or expired. The gateway uses this
 * token (forwarded as `Authorization: Bearer ...`) to bill the user's personal
 * Claude subscription; pi-ai automatically adds the Claude Code identity
 * headers because the token has the `sk-ant-oat` prefix.
 */
export function readClaudeOAuthToken(): string | null {
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as {
      anthropic?: { access?: unknown; expires?: unknown };
    };
    const anthropic = raw.anthropic;
    if (!anthropic || typeof anthropic.access !== "string" || !anthropic.access) return null;
    if (typeof anthropic.expires === "number" && anthropic.expires <= Date.now()) return null;
    return anthropic.access;
  } catch {
    return null;
  }
}

interface AnthropicOAuthCreds {
  type?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

/**
 * Ensure the persisted Claude OAuth access token is fresh, refreshing it via
 * the stored refresh token when it has expired (or is within its safety
 * margin). The refreshed credentials are written back to `auth.json` under the
 * `anthropic` provider id in pi's own `{ type: "oauth", ... }` format, so both
 * this extension and pi's built-in `anthropic` provider observe the new token.
 *
 * Unlike readClaudeOAuthToken, this is async (a refresh performs a network
 * call) and returns the valid access token, or null when no usable
 * credentials exist / a refresh fails. Async entry points call this before the
 * synchronous readClaudeOAuthToken so downstream reads see a fresh token.
 */
export async function refreshClaudeOAuthToken(): Promise<string | null> {
  const log = getLogger();
  const authPath = join(resolveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return null;

  let anthropic: AnthropicOAuthCreds | undefined;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as { anthropic?: AnthropicOAuthCreds };
    anthropic = raw.anthropic;
  } catch {
    return null;
  }
  if (!anthropic || typeof anthropic.access !== "string" || !anthropic.access) return null;

  const expires = typeof anthropic.expires === "number" ? anthropic.expires : 0;
  if (expires > Date.now()) return anthropic.access;

  // Expired (or no expiry recorded): try to refresh.
  if (typeof anthropic.refresh !== "string" || !anthropic.refresh) {
    log.debug({ s: "flant" }, "claude oauth token expired and no refresh token available");
    return null;
  }

  let refreshed: { refresh: string; access: string; expires: number };
  try {
    refreshed = await refreshAnthropicToken(anthropic.refresh);
  } catch (err: any) {
    log.debug({ s: "flant", err: err?.message }, "claude oauth token refresh failed");
    return null;
  }

  // Persist refreshed credentials back under the `anthropic` provider id, using
  // pi's { type: "oauth", ... } shape and the same file lock pi uses.
  try {
    const authDir = resolveAgentDir();
    if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
    if (!existsSync(authPath)) writeFileSync(authPath, "{}\n", "utf-8");
    const release = lockfile.lockSync(authPath, { stale: 10000 });
    try {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
      } catch {
        current = {};
      }
      const existing = (current.anthropic && typeof current.anthropic === "object")
        ? current.anthropic as Record<string, unknown>
        : {};
      // Another instance may have refreshed while we were waiting for the lock.
      const existingExpires = typeof existing.expires === "number" ? existing.expires : 0;
      if (existingExpires > Date.now() && typeof existing.access === "string" && existing.access) {
        return existing.access;
      }
      current.anthropic = {
        ...existing,
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      };
      writeFileSync(authPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
    } finally {
      release();
    }
  } catch (err: any) {
    // If persistence fails we still return the freshly minted token so the
    // current run can proceed; the next run will refresh again.
    log.debug({ s: "flant", err: err?.message }, "failed to persist refreshed claude oauth token");
  }

  log.debug({ s: "flant" }, "refreshed claude oauth token");
  return refreshed.access;
}

/** Resolve the gateway API key (LLM_API_KEY preferred, FLANT_API_KEY fallback). */
export function readGatewayApiKey(): string | null {
  return process.env.LLM_API_KEY ?? process.env.FLANT_API_KEY ?? null;
}

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
  api.unregisterProvider(SUB_PROVIDER);
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
    subscription: !!value.subscription,
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

/**
 * Returns true when the personal-subscription Claude path is fully usable:
 * the setting is enabled AND both credentials (Claude OAuth token + gateway
 * key) are present. Mirrors the gate in registerFlantProviders so we never
 * generate `sub/` role assignments that cannot resolve to a real provider.
 */
export function isSubscriptionActive(settings?: FlantSettings): boolean {
  const s = settings ?? loadFlantSettings();
  return s.subscription && !!readClaudeOAuthToken() && !!readGatewayApiKey();
}

function modelSpec(modelId: string, subscriptionActive = false): string {
  if (modelId.startsWith("claude-")) {
    return subscriptionActive
      ? `${SUB_PROVIDER}/${SUB_MODEL_PREFIX}${modelId}`
      : `pp-flant-anthropic/${modelId}`;
  }
  return `pp-flant-openai/${modelId}`;
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

export interface RegisterFlantOptions {
  /** Whether to also register the personal-subscription provider. Defaults to loadFlantSettings().subscription. */
  subscription?: boolean;
}

export function registerFlantProviders(
  pi: ExtensionAPI,
  models: string[],
  metadata: Record<string, OpenRouterModelData>,
  options: RegisterFlantOptions = {},
): void {
  const log = getLogger();
  const uniqueModels = [...new Set(models)];
  const anthropicModels = uniqueModels.filter((m) => m.startsWith("claude-"));
  const openaiModels = uniqueModels.filter((m) => !m.startsWith("claude-"));

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

  const availableSpecs = [
    ...anthropicModels.map((id) => `pp-flant-anthropic/${id}`),
    ...openaiModels.map((id) => `pp-flant-openai/${id}`),
  ];

  const subscription = options.subscription ?? loadFlantSettings().subscription;
  let subModels: string[] = [];
  if (subscription) {
    const oauthToken = readClaudeOAuthToken();
    const gatewayKey = readGatewayApiKey();
    if (oauthToken && gatewayKey) {
      subModels = anthropicModels.map((m) => `${SUB_MODEL_PREFIX}${m}`);
      pi.registerProvider(SUB_PROVIDER, {
        name: "Flant (personal Claude subscription)",
        api: "anthropic-messages",
        baseUrl: "https://llm-api.flant.ru",
        // The OAuth token (sk-ant-oat...) triggers pi-ai's Claude Code identity
        // headers and is forwarded as `Authorization: Bearer ...`.
        apiKey: oauthToken,
        // Gateway key travels in a side header so it does not clobber the OAuth auth.
        headers: { "x-litellm-api-key": `Bearer ${gatewayKey}` },
        // Model id carries the `sub/` prefix the gateway expects, while pricing/
        // metadata is looked up by the bare claude-* id.
        models: anthropicModels.map((m) => {
          const cfg = buildProviderModelConfig(m, metadata);
          return { ...cfg, id: `${SUB_MODEL_PREFIX}${m}` };
        }),
      });
      availableSpecs.push(...subModels.map((id) => `${SUB_PROVIDER}/${id}`));
    } else {
      log.debug({ s: "flant", hasOAuth: !!oauthToken, hasGatewayKey: !!gatewayKey }, "subscription enabled but credentials missing; skipping sub provider");
    }
  }

  log.debug({ s: "flant", total: uniqueModels.length, anthropic: anthropicModels.length, openai: openaiModels.length, sub: subModels.length }, "registering flant providers");

  updateRegistryFromAvailableModels(availableSpecs);
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

function makeVariant(modelId: string | null, fallbackModelId: string, sub = false): { enabled: boolean; model: string; thinking: string } {
  if (!modelId) return { enabled: false, model: modelSpec(fallbackModelId, sub), thinking: "high" };
  return { enabled: true, model: modelSpec(modelId, sub), thinking: "high" };
}

function makeVariantWithThinking(
  modelId: string | null,
  fallbackModelId: string,
  thinking: string,
  sub = false,
): { enabled: boolean; model: string; thinking: string } {
  if (!modelId) return { enabled: false, model: modelSpec(fallbackModelId, sub), thinking };
  return { enabled: true, model: modelSpec(modelId, sub), thinking };
}

function buildPresetGroup(
  presets: Record<string, { enabled?: boolean; agents: Record<string, { enabled: boolean; model: string; thinking: string }> }>,
  defaultPreset = "regular",
): { default: string; presets: typeof presets } {
  return { default: defaultPreset, presets };
}

export function generateFlantConfig(models: string[], subscriptionActive = false): Partial<PiPiConfig> {
  const uniqueModels = [...new Set(models)];
  if (uniqueModels.length === 0) return {};
  const sub = subscriptionActive;

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
        implement: { model: modelSpec(implementModel, sub), thinking: "high" },
        plan: { model: modelSpec(implementModel, sub), thinking: "high" },
        debug: { model: modelSpec(debugModel, sub), thinking: "high" },
        brainstorm: { model: modelSpec(brainstormModel, sub), thinking: "high" },
        review: { model: modelSpec(implementModel, sub), thinking: "high" },
        quick: { model: modelSpec(implementModel, sub), thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: modelSpec(fastModel, sub), thinking: "low" },
          librarian: { model: modelSpec(fastModel, sub), thinking: "medium" },
          task: { model: modelSpec(taskModel, sub), thinking: "medium" },
        },
        presetGroups: {
          planners: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback, sub),
                gpt: makeVariant(latestGpt, fallback, sub),
                gemini: makeVariant(latestGeminiPro, fallback, sub),
              },
            },
          }),
          planReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback, sub),
                gpt: makeVariant(latestGpt, fallback, sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh", sub),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh", sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
              },
            },
          }),
          codeReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback, sub),
                gpt: makeVariant(latestGpt, fallback, sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh", sub),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh", sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
              },
            },
          }),
          brainstormReviewers: buildPresetGroup({
            regular: {
              agents: {
                opus: makeVariant(latestOpus, fallback, sub),
                gpt: makeVariant(latestGpt, fallback, sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
              },
            },
            deep: {
              agents: {
                opus: makeVariantWithThinking(latestOpus, fallback, "xhigh", sub),
                gpt: makeVariantWithThinking(latestGpt, fallback, "xhigh", sub),
                gemini: makeVariantWithThinking(latestGeminiPro, fallback, "xhigh", sub),
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

  // Refresh the personal-subscription Claude OAuth token before (re)registering
  // providers so the sub provider is built with a valid, non-expired token.
  if (settings.subscription) {
    await refreshClaudeOAuthToken();
  }

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
    generatedFlantConfig = generateFlantConfig(models, isSubscriptionActive(settings));
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
    generatedFlantConfig = generateFlantConfig(settings.cachedFlantModels, isSubscriptionActive(settings));
  }
}

export async function initFlantOnStartup(pi: ExtensionAPI): Promise<void> {
  setPI(pi);
  const settings = loadFlantSettings();
  if (!settings.enabled) {
    generatedFlantConfig = null;
    return;
  }
  if (!settings.autoUpdate) {
    // updateFlantInfra (which refreshes the token) is skipped when auto-update
    // is off, but any registered sub provider still needs a fresh token.
    if (settings.subscription) await refreshClaudeOAuthToken();
    return;
  }
  await updateFlantInfra(pi);
}
