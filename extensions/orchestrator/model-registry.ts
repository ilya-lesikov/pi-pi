import { compareModelVersion } from "./model-version.js";

export type Vendor = "anthropic" | "openai" | "google" | "deepseek" | "xai" | "qwen" | "unknown";
export type Family = "opus" | "fable" | "sonnet" | "haiku" | "gpt-sol" | "gpt-terra" | "gpt-luna" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "deepseek" | "grok" | "qwen" | "unknown";
export type Tier = "stupid" | "regular" | "smart" | "xsmart" | "unknown";

export interface ModelInfo {
  vendor: Vendor;
  family: Family;
  tier: Tier;
  displayName: string;
}

type ProviderPrefix = "anthropic" | "openai" | "google" | "deepseek" | "x-ai" | "qwen" | "pp-flant-anthropic" | "pp-flant-anthropic-sub" | "pp-flant-openai";
type KnownVendor = "anthropic" | "openai" | "google" | "deepseek" | "xai" | "qwen";
type KnownFamily = "opus" | "fable" | "sonnet" | "haiku" | "gpt-sol" | "gpt-terra" | "gpt-luna" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "deepseek" | "grok" | "qwen";
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
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-opus-[a-z0-9.-]+$/, /^pp-flant-anthropic-sub\/sub\/claude-opus-[a-z0-9.-]+$/],
    aliasTemplate: "claude-opus-latest",
    providers: ["anthropic", "pp-flant-anthropic", "pp-flant-anthropic-sub"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "anthropic",
    family: "fable",
    tier: "xsmart",
    displayName: "Claude Fable",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-fable-[a-z0-9.-]+$/, /^pp-flant-anthropic-sub\/sub\/claude-fable-[a-z0-9.-]+$/],
    aliasTemplate: "claude-fable-latest",
    providers: ["anthropic", "pp-flant-anthropic", "pp-flant-anthropic-sub"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "anthropic",
    family: "sonnet",
    tier: "regular",
    displayName: "Claude Sonnet",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-sonnet-[a-z0-9.-]+$/, /^pp-flant-anthropic-sub\/sub\/claude-sonnet-[a-z0-9.-]+$/],
    aliasTemplate: "claude-sonnet-latest",
    providers: ["anthropic", "pp-flant-anthropic", "pp-flant-anthropic-sub"],
    nativeLatestProviders: ["anthropic"],
  },
  {
    vendor: "anthropic",
    family: "haiku",
    tier: "stupid",
    displayName: "Claude Haiku",
    patterns: [/^(anthropic|pp-flant-anthropic)\/claude-haiku-[a-z0-9.-]+$/, /^pp-flant-anthropic-sub\/sub\/claude-haiku-[a-z0-9.-]+$/],
    aliasTemplate: "claude-haiku-latest",
    providers: ["anthropic", "pp-flant-anthropic", "pp-flant-anthropic-sub"],
    nativeLatestProviders: ["anthropic"],
  },
  // gpt-5.6 tier families. These MUST precede the legacy `gpt` family below,
  // since findFamily returns the first matching entry and the legacy pattern
  // would otherwise swallow `gpt-5.6-sol` etc. Each tier folds its `-pro`
  // higher-effort variant into the SAME family (a costlier reasoning MODE, not
  // a distinct tier); the base/-pro disambiguation that matters for role
  // selection lives in flant-infra's gptSol/gptSolPro pickers, not here.
  {
    vendor: "openai",
    family: "gpt-sol",
    tier: "smart",
    displayName: "GPT Sol",
    patterns: [/^(openai|pp-flant-openai)\/gpt-[0-9.]+-sol(?:-pro)?$/],
    aliasTemplate: "gpt-sol-latest",
    providers: ["openai", "pp-flant-openai"],
  },
  {
    vendor: "openai",
    family: "gpt-terra",
    tier: "regular",
    displayName: "GPT Terra",
    patterns: [/^(openai|pp-flant-openai)\/gpt-[0-9.]+-terra(?:-pro)?$/],
    aliasTemplate: "gpt-terra-latest",
    providers: ["openai", "pp-flant-openai"],
  },
  {
    vendor: "openai",
    family: "gpt-luna",
    tier: "stupid",
    displayName: "GPT Luna",
    patterns: [/^(openai|pp-flant-openai)\/gpt-[0-9.]+-luna(?:-pro)?$/],
    aliasTemplate: "gpt-luna-latest",
    providers: ["openai", "pp-flant-openai"],
  },
  {
    vendor: "openai",
    family: "gpt",
    tier: "regular",
    displayName: "GPT",
    // Excludes -mini (handled below) AND the sol/terra/luna tier suffixes
    // (handled above) so pre-5.6 gpt ids still resolve to this legacy family.
    patterns: [/^(openai|pp-flant-openai)\/gpt-(?!mini-)(?!.*-mini(?:$|[-.]))(?!.*-(?:sol|terra|luna)(?:-pro)?$)[a-z0-9.-]+$/],
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
import { SUB_MODEL_PREFIX, SUB_PROVIDER } from "./flant-infra.js";

// ─────────────────────────────────────────────────────────────────────────────
// Provider-tier resolution (item 3). Ordered, highest-precedence-first:
//   copilot  → the built-in github-copilot provider (flat-rate, COPILOT_GITHUB_TOKEN)
//   flant-sub → pp-flant-anthropic-sub (personal Claude subscription; CLAUDE-ONLY)
//   flant-api → pp-flant-anthropic / pp-flant-openai (paid per token)
// Each role's model spec is stored already pointing at its PREFERRED tier; the
// resolver rewrites DOWN to the highest still-usable tier when the preferred one
// is disabled (settings) or demoted (a live rate-limit). This is the single
// choke point every resolution site funnels through (main switchModel, subagent
// tool_call input.model, planner/reviewer specs, registerAgents), replacing the
// old single sub→api boolean.
export type ProviderTierName = "copilot" | "flant-sub" | "flant-api";

// Fixed precedence order.
export const PROVIDER_TIER_ORDER: readonly ProviderTierName[] = ["copilot", "flant-sub", "flant-api"] as const;

const COPILOT_PROVIDER = "github-copilot";

// Which tiers are ENABLED (user settings). flant-api is effectively always on
// (the paid floor); copilot/flant-sub are opt-in. Defaults keep pre-tier
// behavior: only flant-api + flant-sub (when the sub provider is registered).
let tierEnabled: Record<ProviderTierName, boolean> = {
  "copilot": false,
  "flant-sub": true,
  "flant-api": true,
};

// Per-family live demotions (a rate limit on that family's current tier). A
// demoted (tier,family) pair is skipped during resolution until restored by the
// switch-back probe. Keyed by `${tier}:${family}`.
const demotedTierFamily = new Set<string>();

export function setTierEnabled(flags: Partial<Record<ProviderTierName, boolean>>): void {
  tierEnabled = { ...tierEnabled, ...flags };
}

export function getTierEnabled(): Record<ProviderTierName, boolean> {
  return { ...tierEnabled };
}

export function demoteTierForFamily(tier: ProviderTierName, family: Family): void {
  demotedTierFamily.add(`${tier}:${family}`);
}

export function restoreTierForFamily(tier: ProviderTierName, family: Family): void {
  demotedTierFamily.delete(`${tier}:${family}`);
}

export function clearAllTierDemotions(): void {
  demotedTierFamily.clear();
}

function isTierUsable(tier: ProviderTierName, family: Family): boolean {
  if (!tierEnabled[tier]) return false;
  if (demotedTierFamily.has(`${tier}:${family}`)) return false;
  // flant-sub is Claude-only: it never serves gpt/gemini/etc families.
  if (tier === "flant-sub" && !isClaudeFamily(family)) return false;
  return true;
}

function isClaudeFamily(family: Family): boolean {
  return family === "opus" || family === "fable" || family === "sonnet" || family === "haiku";
}

// Identify which tier a resolved spec currently points at.
function tierOfSpec(spec: string): ProviderTierName | null {
  if (spec.startsWith(`${COPILOT_PROVIDER}/`)) return "copilot";
  if (spec.startsWith(`${SUB_PROVIDER}/`) || spec.startsWith(SUB_MODEL_PREFIX)) return "flant-sub";
  if (spec.startsWith("pp-flant-anthropic/") || spec.startsWith("pp-flant-openai/")) return "flant-api";
  return null;
}

// Extract the bare model id (no provider/sub prefix) from a resolved spec.
function bareModelId(spec: string): string {
  let s = spec;
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  if (s.startsWith(SUB_MODEL_PREFIX)) s = s.slice(SUB_MODEL_PREFIX.length);
  return s;
}

// Rewrite a spec onto a target tier for a given family.
function specForTier(tier: ProviderTierName, family: Family, bareId: string): string {
  const claude = isClaudeFamily(family);
  switch (tier) {
    case "copilot":
      return `${COPILOT_PROVIDER}/${bareId}`;
    case "flant-sub":
      return `${SUB_PROVIDER}/${SUB_MODEL_PREFIX}${bareId}`;
    case "flant-api":
      return claude ? `pp-flant-anthropic/${bareId}` : `pp-flant-openai/${bareId}`;
  }
}

// Given a resolved spec, return it on the highest still-usable tier AT OR BELOW
// its current preferred tier (demote-only). Role specs are generated already
// pointing at their preferred tier (copilot precedence is a GENERATION concern),
// so the resolver's job is purely to drop DOWN when the current tier is disabled
// (settings) or demoted (a live rate-limit) — never to promote a spec upward,
// which would e.g. reroute a paid flant-api spec onto the subscription. Only
// tier-routed specs (copilot / flant-sub / flant-api) are considered; native
// anthropic/openai specs and unresolved aliases pass through unchanged.
function applyTierResolution(spec: string): string {
  const currentTier = tierOfSpec(spec);
  if (!currentTier) return spec;
  const bareId = bareModelId(spec);
  // Resolve the family from a canonical provider-prefixed form so a bare
  // `sub/<claude-*>` id (no provider prefix) still classifies. Claude bare ids
  // map onto the anthropic provider; other bare ids onto the openai provider.
  const canonical = findFamily(spec)
    ? spec
    : bareId.startsWith("claude-")
      ? `pp-flant-anthropic/${bareId}`
      : `pp-flant-openai/${bareId}`;
  const family = findFamily(canonical)?.family ?? "unknown";
  if (family === "unknown") return spec;
  // If the current tier is still usable, keep the spec as-is (no promotion).
  if (isTierUsable(currentTier, family)) return specForTier(currentTier, family, bareId);
  // Otherwise walk DOWN to the first usable lower-precedence tier.
  const startIdx = PROVIDER_TIER_ORDER.indexOf(currentTier);
  for (let i = startIdx + 1; i < PROVIDER_TIER_ORDER.length; i++) {
    const tier = PROVIDER_TIER_ORDER[i];
    if (isTierUsable(tier, family)) return specForTier(tier, family, bareId);
  }
  return spec;
}

// ── Backward-compatible sub-fallback shims ──────────────────────────────────
// The rate-limit-fallback module still calls setSubscriptionFallbackActive to
// force sub→api. Model it as: disable the flant-sub tier globally (active) /
// re-enable it (inactive). This preserves the exact old observable behavior
// while routing through the unified tier resolver.
let subscriptionFallbackActive = false;

export function setSubscriptionFallbackActive(active: boolean): void {
  subscriptionFallbackActive = active;
  tierEnabled["flant-sub"] = !active;
}

export function isSubscriptionFallbackActive(): boolean {
  return subscriptionFallbackActive;
}

// Rewrite a subscription-routed spec to its regular per-token equivalent.
// Handles both `pp-flant-anthropic-sub/sub/<m>` and a bare `sub/<m>` id.
// Non-subscription specs pass through unchanged.
export function toNonSubSpec(spec: string): string {
  if (spec.startsWith(`${SUB_PROVIDER}/${SUB_MODEL_PREFIX}`)) {
    return `pp-flant-anthropic/${spec.slice(`${SUB_PROVIDER}/${SUB_MODEL_PREFIX}`.length)}`;
  }
  if (spec.startsWith(`${SUB_PROVIDER}/`)) {
    return `pp-flant-anthropic/${spec.slice(`${SUB_PROVIDER}/`.length)}`;
  }
  if (spec.startsWith(SUB_MODEL_PREFIX)) {
    return `pp-flant-anthropic/${spec.slice(SUB_MODEL_PREFIX.length)}`;
  }
  return spec;
}

export function resolveModel(aliasOrId: string): string {
  let resolved = aliasMap[aliasOrId] ?? aliasOrId;
  if (resolved !== aliasOrId) {
    getLogger().debug({ s: "model", alias: aliasOrId, resolved }, "resolved model alias");
  }
  const tiered = applyTierResolution(resolved);
  if (tiered !== resolved) {
    getLogger().debug({ s: "model", from: resolved, to: tiered }, "provider-tier resolution");
    resolved = tiered;
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

export function findLatestFamilyMatch(
  modelSpec: string,
  availableSpecs: string[],
): string | null {
  const family = findFamily(modelSpec);
  if (!family) return null;

  const slashIdx = modelSpec.indexOf("/");
  if (slashIdx === -1) return null;
  const requestedProvider = modelSpec.substring(0, slashIdx).trim().toLowerCase();

  const candidates = availableSpecs.filter((spec) => {
    const specLower = spec.toLowerCase();
    if (!specLower.startsWith(`${requestedProvider}/`)) return false;
    return family.patterns.some((p) => p.test(specLower));
  });

  return pickLatest(candidates);
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
