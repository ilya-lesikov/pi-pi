import { compareModelVersion } from "./model-version.js";

export type Vendor = "anthropic" | "openai" | "google" | "deepseek" | "xai" | "qwen" | "unknown";
export type Family = "opus" | "sonnet" | "haiku" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "deepseek" | "grok" | "qwen" | "unknown";
export type Tier = "stupid" | "regular" | "smart" | "xsmart" | "unknown";

export interface ModelInfo {
  vendor: Vendor;
  family: Family;
  tier: Tier;
  displayName: string;
}

type ProviderPrefix = "anthropic" | "openai" | "google" | "deepseek" | "x-ai" | "qwen" | "pp-flant-anthropic" | "pp-flant-openai";
type KnownVendor = "anthropic" | "openai" | "google" | "deepseek" | "xai" | "qwen";
type KnownFamily = "opus" | "sonnet" | "haiku" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "deepseek" | "grok" | "qwen";
type KnownTier = "stupid" | "regular" | "smart" | "xsmart";

export interface ModelFamilyDefinition {
  vendor: KnownVendor;
  family: KnownFamily;
  tier: KnownTier;
  displayName: string;
  patterns: RegExp[];
  aliasTemplate: string;
  providers: ProviderPrefix[];
  nativeLatestProviders?: ProviderPrefix[];
}

export interface ModelFamilyInfo {
  vendor: KnownVendor;
  family: KnownFamily;
  tier: KnownTier;
  displayName: string;
  aliasTemplate: string;
  aliases: string[];
}

export const MODEL_FAMILIES: ModelFamilyDefinition[] = [
  {
    vendor: "anthropic",
    family: "opus",
    tier: "smart",
    displayName: "Claude Opus",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-opus-[a-z0-9.-]+$/],
    aliasTemplate: "claude-opus-latest",
    providers: ["anthropic", "pp-flant-anthropic"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "anthropic",
    family: "sonnet",
    tier: "regular",
    displayName: "Claude Sonnet",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-sonnet-[a-z0-9.-]+$/],
    aliasTemplate: "claude-sonnet-latest",
    providers: ["anthropic", "pp-flant-anthropic"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "anthropic",
    family: "haiku",
    tier: "stupid",
    displayName: "Claude Haiku",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-haiku-[a-z0-9.-]+$/],
    aliasTemplate: "claude-haiku-latest",
    providers: ["anthropic", "pp-flant-anthropic"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "openai",
    family: "gpt",
    tier: "regular",
    displayName: "GPT",
    patterns: [/^(openai|pp-flant-openai)\/gpt-(?!mini-)(?!.*-mini(?:$|[-.]))[a-z0-9.-]+$/],
    aliasTemplate: "gpt-latest",
    providers: ["openai", "pp-flant-openai"],
  },
  {
    vendor: "openai",
    family: "gpt-mini",
    tier: "stupid",
    displayName: "GPT Mini",
    patterns: [
      /^(openai|pp-flant-openai)\/gpt-mini-[a-z0-9.-]+$/,
      /^(openai|pp-flant-openai)\/gpt-[a-z0-9.]+-mini(?:-[a-z0-9.-]+)?$/,
    ],
    aliasTemplate: "gpt-mini-latest",
    providers: ["openai", "pp-flant-openai"],
  },
  {
    vendor: "google",
    family: "gemini-pro",
    tier: "regular",
    displayName: "Gemini Pro",
    patterns: [
      /^(google|pp-flant-openai)\/gemini-pro-[a-z0-9.-]+$/,
      /^(google|pp-flant-openai)\/gemini-[a-z0-9.-]+-pro(?:-[a-z0-9.-]+)?$/,
    ],
    aliasTemplate: "gemini-pro-latest",
    providers: ["google", "pp-flant-openai"],
  },
  {
    vendor: "google",
    family: "gemini-flash",
    tier: "stupid",
    displayName: "Gemini Flash",
    patterns: [
      /^(google|pp-flant-openai)\/gemini-flash-[a-z0-9.-]+$/,
      /^(google|pp-flant-openai)\/gemini-[a-z0-9.-]+-flash(?:-[a-z0-9.-]+)?$/,
    ],
    aliasTemplate: "gemini-flash-latest",
    providers: ["google", "pp-flant-openai"],
  },
  {
    vendor: "deepseek",
    family: "deepseek",
    tier: "regular",
    displayName: "DeepSeek",
    patterns: [/^(deepseek|pp-flant-openai)\/deepseek-/],
    aliasTemplate: "deepseek-latest",
    providers: ["deepseek", "pp-flant-openai"],
  },
  {
    vendor: "xai",
    family: "grok",
    tier: "regular",
    displayName: "Grok",
    patterns: [/^(x-ai|pp-flant-openai)\/grok-/],
    aliasTemplate: "grok-latest",
    providers: ["x-ai", "pp-flant-openai"],
  },
  {
    vendor: "qwen",
    family: "qwen",
    tier: "regular",
    displayName: "Qwen",
    patterns: [/^(qwen|pp-flant-openai)\/qwen-/],
    aliasTemplate: "qwen-latest",
    providers: ["qwen", "pp-flant-openai"],
  },
];

function buildNativeLatestAliases(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const family of MODEL_FAMILIES) {
    const nativeSet = new Set(family.nativeLatestProviders ?? []);
    for (const provider of family.providers) {
      if (!nativeSet.has(provider)) continue;
      const alias = toAlias(provider, family.aliasTemplate);
      map[alias] = alias;
    }
  }
  return map;
}

let aliasMap: Record<string, string> = buildNativeLatestAliases();

function pickLatest(models: string[]): string | null {
  if (models.length === 0) return null;
  return models
    .slice()
    .sort((a, b) => compareModelVersion(b, a))[0] ?? null;
}

function toAlias(provider: ProviderPrefix, aliasTemplate: string): string {
  return `${provider}/${aliasTemplate}`;
}

function normalizeAvailableModelIds(modelId: string): string[] {
  const value = modelId.trim();
  if (!value) return [];
  if (value.includes("/")) return [value];
  if (value.startsWith("claude-")) return [`pp-flant-anthropic/${value}`];
  if (
    value.startsWith("gpt-") ||
    value.startsWith("gemini-") ||
    value.startsWith("deepseek-") ||
    value.startsWith("grok-") ||
    value.startsWith("qwen")
  ) {
    return [`pp-flant-openai/${value}`];
  }
  return [];
}

function collectNormalizedModels(availableModels: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const modelId of availableModels) {
    for (const normalized of normalizeAvailableModelIds(modelId)) {
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function findFamily(modelId: string): ModelFamilyDefinition | null {
  for (const family of MODEL_FAMILIES) {
    for (const pattern of family.patterns) {
      if (pattern.test(modelId)) return family;
    }
  }
  return null;
}

import { getLogger } from "./log.js";

export function resolveModel(aliasOrId: string): string {
  const resolved = aliasMap[aliasOrId] ?? aliasOrId;
  if (resolved !== aliasOrId) {
    getLogger().debug({ s: "model", alias: aliasOrId, resolved }, "resolved model alias");
  }
  return resolved;
}

export function getModelInfo(modelId: string): ModelInfo {
  const resolved = resolveModel(modelId);
  const family = findFamily(resolved) ?? findFamily(modelId);
  if (!family) {
    return {
      vendor: "unknown",
      family: "unknown",
      tier: "unknown",
      displayName: modelId,
    };
  }
  return {
    vendor: family.vendor,
    family: family.family,
    tier: family.tier,
    displayName: family.displayName,
  };
}

export function updateRegistryFromAvailableModels(availableModels: string[]): void {
  const log = getLogger();
  const normalizedModels = collectNormalizedModels(availableModels).filter((modelId) => !modelId.endsWith("-latest"));
  const nextAliasMap: Record<string, string> = buildNativeLatestAliases();

  let updatedCount = 0;
  for (const family of MODEL_FAMILIES) {
    const nativeSet = new Set(family.nativeLatestProviders ?? []);
    for (const provider of family.providers) {
      if (nativeSet.has(provider)) continue;
      const alias = toAlias(provider, family.aliasTemplate);
      const candidates = normalizedModels.filter((modelId) => {
        if (!modelId.startsWith(`${provider}/`)) return false;
        return family.patterns.some((pattern) => pattern.test(modelId));
      });
      const latest = pickLatest(candidates);
      if (latest) {
        nextAliasMap[alias] = latest;
        updatedCount++;
      }
    }
  }

  aliasMap = nextAliasMap;
  log.debug({ s: "model", availableCount: availableModels.length, normalizedCount: normalizedModels.length, updatedAliases: updatedCount }, "registry updated from available models");
}

export function getAllAliases(): Record<string, string> {
  return { ...aliasMap };
}

export function getModelFamilies(): ModelFamilyInfo[] {
  return MODEL_FAMILIES.map((family) => ({
    vendor: family.vendor,
    family: family.family,
    tier: family.tier,
    displayName: family.displayName,
    aliasTemplate: family.aliasTemplate,
    aliases: family.providers.map((provider) => toAlias(provider, family.aliasTemplate)),
  }));
}
