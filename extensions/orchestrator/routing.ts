import type { ClaudeSubRoute, FamilyName, ModelsConfig, ProviderName, ProvidersConfig, SlotName } from "./config.js";
import { compareModelVersion } from "./model-version.js";
import { getLogger } from "./log.js";

export type { ClaudeSubRoute, FamilyName, ProviderName, SlotName };
export type Tier = "stupid" | "regular" | "smart" | "xsmart";

export const FAMILIES: readonly FamilyName[] = ["claude", "gpt"];
export const PROVIDER_NAMES: readonly ProviderName[] = ["claude-sub", "codex", "copilot", "llm-api"];
export const CLAUDE_SUB_ROUTES: readonly ClaudeSubRoute[] = ["direct", "llm-api"];
export const DEFAULT_PROVIDER_ORDER: readonly ProviderName[] = ["claude-sub", "codex", "copilot", "llm-api"];
// The gateway route first: it is the path every existing setup already runs on,
// and a machine without the gateway key simply has no models there, so
// resolution reaches the direct route on its own.
export const DEFAULT_CLAUDE_SUB_ROUTE: readonly ClaudeSubRoute[] = ["llm-api", "direct"];

export const DIRECT_SUB_PROVIDER = "pp-claude-sub";
export const GATEWAY_SUB_PROVIDER = "pp-flant-anthropic-sub";
export const GATEWAY_SUB_MODEL_PREFIX = "sub/";
export const LLM_API_PROVIDER = "pp-flant-openai";
export const CODEX_PROVIDER = "openai-codex";
export const COPILOT_PROVIDER = "github-copilot";

export interface SlotDefinition {
  family: FamilyName;
  slot: SlotName;
  tier: Tier;
  label: string;
  pattern: RegExp;
}

function claudeSlot(slot: SlotName, tier: Tier, name: string): SlotDefinition {
  return { family: "claude", slot, tier, label: `Claude ${name}`, pattern: new RegExp(`^claude-${slot}-[0-9][a-z0-9.-]*$`) };
}

function gptSlot(slot: SlotName, tier: Tier, name: string): SlotDefinition {
  return { family: "gpt", slot, tier, label: `GPT ${name}`, pattern: new RegExp(`^gpt-[0-9.]+-${slot}(?:-pro)?$`) };
}

export const SLOTS: readonly SlotDefinition[] = [
  claudeSlot("haiku", "stupid", "Haiku"),
  claudeSlot("sonnet", "regular", "Sonnet"),
  claudeSlot("opus", "smart", "Opus"),
  claudeSlot("fable", "xsmart", "Fable"),
  gptSlot("luna", "stupid", "Luna"),
  gptSlot("terra", "regular", "Terra"),
  gptSlot("sol", "smart", "Sol"),
  gptSlot("astra", "xsmart", "Astra"),
];

export const FAMILY_LABEL: Record<FamilyName, string> = { claude: "Claude", gpt: "GPT" };

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  "claude-sub": "Claude subscription",
  codex: "ChatGPT subscription",
  copilot: "GitHub Copilot",
  "llm-api": "LLM API",
};

const CONCRETE_PROVIDER_LABEL: Record<string, string> = {
  [DIRECT_SUB_PROVIDER]: "Claude subscription (direct)",
  [GATEWAY_SUB_PROVIDER]: "Claude subscription (via LLM API)",
  [LLM_API_PROVIDER]: "LLM API",
  [CODEX_PROVIDER]: "ChatGPT subscription",
  [COPILOT_PROVIDER]: "GitHub Copilot",
};

// Providers that resell other vendors' models: the provider says nothing about
// who made the model behind it.
const AGGREGATORS = new Set([LLM_API_PROVIDER, COPILOT_PROVIDER, "openrouter", "vercel-ai-gateway"]);

export function slotsOf(family: FamilyName): SlotDefinition[] {
  return SLOTS.filter((s) => s.family === family);
}

export function slotDefinition(family: FamilyName, slot: SlotName): SlotDefinition | undefined {
  return SLOTS.find((s) => s.family === family && s.slot === slot);
}

export function concreteProviderLabel(provider: string): string {
  return CONCRETE_PROVIDER_LABEL[provider] ?? provider;
}

export function logicalProviderOf(concrete: string): ProviderName | null {
  switch (concrete) {
    case DIRECT_SUB_PROVIDER:
    case GATEWAY_SUB_PROVIDER:
      return "claude-sub";
    case CODEX_PROVIDER:
      return "codex";
    case COPILOT_PROVIDER:
      return "copilot";
    case LLM_API_PROVIDER:
      return "llm-api";
    default:
      return null;
  }
}

export function routeOfConcrete(concrete: string): ClaudeSubRoute | null {
  if (concrete === DIRECT_SUB_PROVIDER) return "direct";
  if (concrete === GATEWAY_SUB_PROVIDER) return "llm-api";
  return null;
}

/** A subscription's quota is the whole account's; the other providers limit per model. */
export function isAccountScoped(provider: ProviderName): boolean {
  return provider === "claude-sub" || provider === "codex";
}

export function splitSpec(spec: string): { provider: string; id: string } | null {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) return null;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function bareModelId(id: string): string {
  return id.startsWith(GATEWAY_SUB_MODEL_PREFIX) ? id.slice(GATEWAY_SUB_MODEL_PREFIX.length) : id;
}

// Catalogs spell one version differently (`claude-fable-5.1` on Copilot,
// `claude-fable-5-1` everywhere else).
function normalizeVersion(id: string): string {
  return bareModelId(id).toLowerCase().replace(/\./g, "-");
}

function stripPro(id: string): string {
  return id.replace(/-pro$/, "");
}

// ── References ───────────────────────────────────────────────────────────────

export type ModelRef =
  | { kind: "slot"; family: FamilyName; slot: SlotName; pro: boolean }
  | { kind: "pin"; spec: string };

const SLOT_REF = /^(claude|gpt)\/(haiku|sonnet|opus|fable|luna|terra|sol|astra)(:pro)?$/;

export function parseRef(ref: string): ModelRef | null {
  const match = SLOT_REF.exec(ref.trim());
  if (match) {
    const family = match[1] as FamilyName;
    const slot = match[2] as SlotName;
    if (!slotDefinition(family, slot)) return null;
    if (match[3] && family !== "gpt") return null;
    return { kind: "slot", family, slot, pro: !!match[3] };
  }
  return splitSpec(ref.trim()) ? { kind: "pin", spec: ref.trim() } : null;
}

export function formatSlotRef(family: FamilyName, slot: SlotName, pro = false): string {
  return `${family}/${slot}${pro ? ":pro" : ""}`;
}

export function isSlotRef(ref: string): boolean {
  return parseRef(ref)?.kind === "slot";
}

interface RoleModels {
  main: { model: string };
  subagents: { simple: Record<string, { model: string }>; pools: Record<string, Array<{ model: string }>> };
}

/** Role models pinned to an exact provider/model, which routing never moves. */
export function pinnedRoleSpecs(config: { agents?: RoleModels } | null | undefined): string[] {
  const agents = config?.agents;
  if (!agents) return [];
  const refs = [
    agents.main.model,
    ...Object.values(agents.subagents.simple).map((agent) => agent.model),
    ...Object.values(agents.subagents.pools).flatMap((pool) => pool.map((entry) => entry.model)),
  ];
  return refs.filter((ref) => !isSlotRef(ref));
}

export function refLabel(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed) return ref;
  if (parsed.kind === "pin") return ref;
  const def = slotDefinition(parsed.family, parsed.slot)!;
  return parsed.pro ? `${def.label} Pro` : def.label;
}

// ── State ────────────────────────────────────────────────────────────────────

interface RoutingState {
  providers: ProvidersConfig;
  models: ModelsConfig;
}

let state: RoutingState = {
  providers: {
    order: [...DEFAULT_PROVIDER_ORDER],
    "claude-sub": { enabled: true, route: [...DEFAULT_CLAUDE_SUB_ROUTE] },
    codex: { enabled: true },
    copilot: { enabled: true },
    "llm-api": { enabled: true, autoUpdate: true, cacheTTLDays: 3 },
    fallback: { auto: true, retryAfterMinutes: 10 },
  },
  models: {
    claude: { override: null, pins: {} },
    gpt: { override: null, pins: {} },
  },
};

const catalog = new Set<string>();
const catalogByProvider = new Map<string, string[]>();
const lastGood = new Map<string, string>();

export function configureRouting(config: { providers: ProvidersConfig; models: ModelsConfig }): void {
  state = { providers: structuredClone(config.providers), models: structuredClone(config.models) };
}

export function routingConfig(): RoutingState {
  return state;
}

/** Replace the catalog with every `provider/id` the host currently has credentials for. */
export function setCatalog(specs: string[]): void {
  catalog.clear();
  catalogByProvider.clear();
  for (const raw of specs) {
    const spec = raw.trim();
    const parts = splitSpec(spec);
    if (!parts || parts.id.endsWith("-latest") || catalog.has(spec)) continue;
    catalog.add(spec);
    const ids = catalogByProvider.get(parts.provider) ?? [];
    ids.push(parts.id);
    catalogByProvider.set(parts.provider, ids);
  }
  getLogger().debug({ s: "routing", models: catalog.size, providers: catalogByProvider.size }, "catalog updated");
}

export function listCatalog(): string[] {
  return [...catalog];
}

export function catalogHas(spec: string): boolean {
  return catalog.has(spec);
}

export function catalogProviders(): string[] {
  return [...catalogByProvider.keys()].sort();
}

export function catalogModelsOf(provider: string): string[] {
  return [...(catalogByProvider.get(provider) ?? [])];
}

// ── Pauses ───────────────────────────────────────────────────────────────────
// Keys: `claude-sub` / `codex` (the whole account), `claude-sub@<route>` (one
// transport to the account), `<provider>:<family>/<slot>` (one model line on a
// per-model-limited provider), `<provider>:<spec>` (a model outside the slots).

export interface Pause {
  key: string;
  /** Epoch ms; null means until something (a probe) lifts it. */
  until: number | null;
  reason: string;
}

const pauses = new Map<string, Pause>();
const pauseStreak = new Map<string, { count: number; lastEnd: number }>();
const STREAK_RESET_MS = 60 * 60_000;
const MAX_PAUSE_MS = 4 * 60 * 60_000;

export function isPaused(key: string): boolean {
  const entry = pauses.get(key);
  if (!entry) return false;
  if (entry.until !== null && entry.until <= Date.now()) {
    pauses.delete(key);
    return false;
  }
  return true;
}

export function getPause(key: string): Pause | null {
  return isPaused(key) ? pauses.get(key)! : null;
}

/**
 * How long the next pause of `key` lasts: what the provider asked for when it
 * said, otherwise the configured interval doubled for each pause in an unbroken
 * streak, so a limit that keeps refusing is not re-probed at the same pace.
 */
export function nextPauseMs(key: string, baseMinutes: number, hintMs?: number | null): number {
  if (hintMs && hintMs > 0) return Math.min(hintMs, MAX_PAUSE_MS);
  const streak = pauseStreak.get(key);
  const count = streak && Date.now() - streak.lastEnd < STREAK_RESET_MS ? streak.count : 0;
  return Math.min(Math.max(1, baseMinutes) * 60_000 * 2 ** count, MAX_PAUSE_MS);
}

export function pause(key: string, durationMs: number | null, reason: string): Pause {
  const until = durationMs === null ? null : Date.now() + durationMs;
  const entry: Pause = { key, until, reason };
  pauses.set(key, entry);
  const streak = pauseStreak.get(key);
  const count = streak && Date.now() - streak.lastEnd < STREAK_RESET_MS ? streak.count + 1 : 1;
  pauseStreak.set(key, { count, lastEnd: until ?? Date.now() });
  getLogger().info({ s: "routing", key, until, reason }, "paused");
  return entry;
}

export function unpause(key: string): void {
  if (pauses.delete(key)) getLogger().info({ s: "routing", key }, "unpaused");
  const streak = pauseStreak.get(key);
  if (streak) streak.lastEnd = Date.now();
}

export function listPauses(): Pause[] {
  return [...pauses.keys()].filter(isPaused).sort().map((key) => pauses.get(key)!);
}

export function clearPauses(): string[] {
  const keys = listPauses().map((p) => p.key);
  pauses.clear();
  pauseStreak.clear();
  return keys;
}

export function slotPauseKey(provider: ProviderName, family: FamilyName, slot: SlotName): string {
  return `${provider}:${family}/${slot}`;
}

export function routePauseKey(route: ClaudeSubRoute): string {
  return `claude-sub@${route}`;
}

/** The pause a rate limit on `spec` lands on, or null for a model no provider routes. */
export function pauseKeyForSpec(spec: string): string | null {
  const parts = splitSpec(spec);
  if (!parts) return null;
  const provider = logicalProviderOf(parts.provider);
  if (!provider) return null;
  if (isAccountScoped(provider)) return provider;
  const slot = slotOfModelId(parts.id);
  return slot ? slotPauseKey(provider, slot.family, slot.slot) : `${provider}:${spec}`;
}

export function describePauseKey(key: string): string {
  if ((PROVIDER_NAMES as readonly string[]).includes(key)) return PROVIDER_LABEL[key as ProviderName];
  const route = /^claude-sub@(direct|llm-api)$/.exec(key);
  if (route) return route[1] === "direct" ? "Claude subscription (direct)" : "Claude subscription (via LLM API)";
  const colon = key.indexOf(":");
  if (colon > 0) {
    const provider = key.slice(0, colon) as ProviderName;
    return `${PROVIDER_LABEL[provider] ?? provider} · ${refLabel(key.slice(colon + 1))}`;
  }
  return key;
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface Resolution {
  ref: string;
  spec: string | null;
  via: "override" | "pin" | "last-good" | ProviderName | null;
  /** A `:pro` slot landed on its base model because the provider has no pro variant. */
  proFallback: boolean;
  /** One line per provider considered, for Explain routing and error messages. */
  steps: string[];
}

function formatTime(epoch: number | null): string {
  if (epoch === null) return "it recovers";
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function concreteProvidersOf(provider: ProviderName, steps: string[]): string[] {
  switch (provider) {
    case "claude-sub": {
      const out: string[] = [];
      for (const route of state.providers["claude-sub"].route) {
        const paused = getPause(routePauseKey(route));
        if (paused) {
          steps.push(`  · ${route} route paused until ${formatTime(paused.until)}`);
          continue;
        }
        out.push(route === "direct" ? DIRECT_SUB_PROVIDER : GATEWAY_SUB_PROVIDER);
      }
      return out;
    }
    case "codex":
      return [CODEX_PROVIDER];
    case "copilot":
      return [COPILOT_PROVIDER];
    case "llm-api":
      return [LLM_API_PROVIDER];
  }
}

function pickLatest(ids: string[]): string | null {
  return ids.slice().sort((a, b) => compareModelVersion(bareModelId(b), bareModelId(a)))[0] ?? null;
}

function pickSlotModel(candidates: string[], pro: boolean): { id: string; proFallback: boolean } | null {
  const pros = candidates.filter((id) => id.endsWith("-pro"));
  const bases = candidates.filter((id) => !id.endsWith("-pro"));
  if (pro) {
    const chosen = pickLatest(pros);
    if (chosen) return { id: chosen, proFallback: false };
    const base = pickLatest(bases);
    return base ? { id: base, proFallback: true } : null;
  }
  const chosen = pickLatest(bases);
  return chosen ? { id: chosen, proFallback: false } : null;
}

export function overrideModelFor(family: FamilyName, slot: SlotName): string | null {
  const override = state.models[family]?.override;
  if (!override) return null;
  return `${override.provider}/${override.slots?.[slot] ?? override.model}`;
}

function resolveSlot(family: FamilyName, slot: SlotName, pro: boolean, steps: string[]): Omit<Resolution, "ref" | "steps"> | null {
  const overrideSpec = overrideModelFor(family, slot);
  if (overrideSpec) {
    if (catalog.has(overrideSpec)) {
      steps.push(`✓ override → ${overrideSpec}`);
      return { spec: overrideSpec, via: "override", proFallback: false };
    }
    const provider = splitSpec(overrideSpec)?.provider ?? "";
    steps.push(catalogByProvider.has(provider)
      ? `✗ override ${overrideSpec}: ${provider} does not serve this model`
      : `✗ override ${overrideSpec}: no credentials for ${provider}`);
    return null;
  }
  const def = slotDefinition(family, slot)!;
  const pin = state.models[family]?.pins?.[slot];
  const wanted = pin ? normalizeVersion(stripPro(pin)) : null;
  for (const provider of state.providers.order) {
    const label = PROVIDER_LABEL[provider];
    if (!state.providers[provider]?.enabled) {
      steps.push(`✗ ${label}: disabled`);
      continue;
    }
    const paused = getPause(provider) ?? getPause(slotPauseKey(provider, family, slot));
    if (paused) {
      steps.push(`✗ ${label}: paused until ${formatTime(paused.until)}`);
      continue;
    }
    let credentialed = false;
    for (const concrete of concreteProvidersOf(provider, steps)) {
      const ids = catalogByProvider.get(concrete);
      if (!ids) continue;
      credentialed = true;
      const candidates = ids.filter((id) => def.pattern.test(bareModelId(id))
        && (!wanted || normalizeVersion(stripPro(id)) === wanted));
      const chosen = pickSlotModel(candidates, pro);
      if (!chosen) continue;
      const spec = `${concrete}/${chosen.id}`;
      steps.push(`✓ ${label} → ${spec}${chosen.proFallback ? " (no pro variant here; base model used)" : ""}`);
      return { spec, via: provider, proFallback: chosen.proFallback };
    }
    steps.push(credentialed
      ? `✗ ${label}: no ${pin ? `${pin} ` : ""}model for ${def.label}`
      : `✗ ${label}: no credentials`);
  }
  return null;
}

/**
 * Whether a model a slot last resolved to is still one the slot's current
 * policy would choose, were its provider not momentarily missing: the same
 * override, the same pinned version, an enabled and unpaused provider.
 */
function lastGoodUsable(spec: string, family: FamilyName, slot: SlotName, pro: boolean): boolean {
  if (!catalog.has(spec)) return false;
  const overrideSpec = overrideModelFor(family, slot);
  if (overrideSpec) return spec === overrideSpec;
  const parts = splitSpec(spec)!;
  const owner = slotOfModelId(parts.id);
  if (!owner || owner.family !== family || owner.slot !== slot || (owner.pro && !pro)) return false;
  const pin = state.models[family]?.pins?.[slot];
  if (pin && normalizeVersion(stripPro(pin)) !== normalizeVersion(stripPro(parts.id))) return false;
  const key = pauseKeyForSpec(spec);
  if (key && isPaused(key)) return false;
  const provider = logicalProviderOf(parts.provider);
  if (!provider || !state.providers[provider]?.enabled) return false;
  if (provider === "claude-sub") {
    const route = routeOfConcrete(parts.provider);
    if (!route || !state.providers["claude-sub"].route.includes(route) || isPaused(routePauseKey(route))) return false;
  }
  return true;
}

export function resolveRef(ref: string): Resolution {
  const steps: string[] = [];
  const parsed = parseRef(ref);
  if (!parsed) return { ref, spec: null, via: null, proFallback: false, steps: [`✗ "${ref}" is neither a slot (e.g. claude/opus) nor provider/model`] };
  if (parsed.kind === "pin") {
    if (catalog.has(parsed.spec)) return { ref, spec: parsed.spec, via: "pin", proFallback: false, steps: [`✓ pinned → ${parsed.spec}`] };
    const provider = splitSpec(parsed.spec)!.provider;
    steps.push(catalogByProvider.has(provider) ? `✗ pinned ${parsed.spec}: ${provider} does not serve it` : `✗ pinned ${parsed.spec}: no credentials for ${provider}`);
    return { ref, spec: null, via: null, proFallback: false, steps };
  }
  const found = resolveSlot(parsed.family, parsed.slot, parsed.pro, steps);
  if (found) {
    lastGood.set(ref, found.spec!);
    return { ref, ...found, steps };
  }
  const previous = lastGood.get(ref);
  if (previous && lastGoodUsable(previous, parsed.family, parsed.slot, parsed.pro)) {
    steps.push(`↺ keeping the last working model ${previous}`);
    return { ref, spec: previous, via: "last-good", proFallback: false, steps };
  }
  return { ref, spec: null, via: null, proFallback: false, steps };
}

export function resolveSpec(ref: string): string | null {
  return resolveRef(ref).spec;
}

export function forgetLastGood(): void {
  lastGood.clear();
}

// ── Describing a concrete model ──────────────────────────────────────────────

export function slotOfModelId(id: string): { family: FamilyName; slot: SlotName; pro: boolean } | null {
  const bare = bareModelId(id);
  const def = SLOTS.find((s) => s.pattern.test(bare));
  return def ? { family: def.family, slot: def.slot, pro: def.family === "gpt" && bare.endsWith("-pro") } : null;
}

/**
 * Who made the model. Claude and GPT are recognized by id; anything else is
 * credited to a namespace in its id (`z-ai/glm-5.3`) or to a provider that
 * serves only its own models, and is "unknown" when it came from a reseller.
 */
export function vendorOf(spec: string): string {
  const parts = splitSpec(spec);
  if (!parts) return "unknown";
  const bare = bareModelId(parts.id).toLowerCase();
  if (bare.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o\d)/.test(bare)) return "openai";
  const namespace = bare.indexOf("/");
  if (namespace > 0) return bare.slice(0, namespace);
  return AGGREGATORS.has(parts.provider) ? "unknown" : parts.provider;
}

export interface ModelDescription {
  /** "Claude Opus", "GPT Astra Pro", or the bare id for a model outside the slots. */
  label: string;
  family: FamilyName | null;
  slot: SlotName | null;
  tier: Tier | "unknown";
  vendor: string;
  spec: string | null;
  /** The family is served by an override, so `spec` is not a Claude/GPT model. */
  overridden: boolean;
}

function describeSlot(family: FamilyName, slot: SlotName, pro: boolean, spec: string | null): ModelDescription {
  const def = slotDefinition(family, slot)!;
  const overridden = !!state.models[family]?.override;
  return {
    label: pro && !overridden ? `${def.label} Pro` : def.label,
    family,
    slot,
    tier: def.tier,
    vendor: spec ? vendorOf(spec) : family === "claude" ? "anthropic" : "openai",
    spec,
    overridden,
  };
}

/** Describe what a configured reference runs on now. */
export function describeRef(ref: string): ModelDescription {
  const parsed = parseRef(ref);
  const spec = resolveSpec(ref);
  if (parsed?.kind === "slot") return describeSlot(parsed.family, parsed.slot, parsed.pro, spec);
  return describeSpec(spec ?? ref);
}

/** Describe a concrete model the session is running, whoever picked it. */
export function describeSpec(spec: string): ModelDescription {
  for (const family of FAMILIES) {
    const override = state.models[family]?.override;
    if (!override) continue;
    // One model usually fills several slots; without knowing which role picked
    // it, the strongest slot it fills is the honest description.
    for (const def of slotsOf(family).slice().reverse()) {
      if (overrideModelFor(family, def.slot) === spec) return describeSlot(family, def.slot, false, spec);
    }
  }
  const parts = splitSpec(spec);
  const slot = parts ? slotOfModelId(parts.id) : null;
  if (slot && !state.models[slot.family]?.override) return describeSlot(slot.family, slot.slot, slot.pro, spec);
  return {
    label: parts ? bareModelId(parts.id) : spec,
    family: null,
    slot: null,
    tier: slot ? slotDefinition(slot.family, slot.slot)!.tier : "unknown",
    vendor: vendorOf(spec),
    spec,
    overridden: false,
  };
}

/** "Claude Opus · override zai/glm-5.3" — the name a person reads. */
export function displayName(description: ModelDescription): string {
  if (description.overridden && description.spec) return `${description.label} · override ${description.spec}`;
  return description.label;
}

/** The slot reference a concrete model would re-resolve through, if it belongs to one. */
export function slotRefOfSpec(spec: string): string | null {
  const description = describeSpec(spec);
  if (!description.family || !description.slot) return null;
  const pro = !description.overridden && slotOfModelId(splitSpec(spec)?.id ?? "")?.pro === true;
  return formatSlotRef(description.family, description.slot, pro);
}

/**
 * Where a request the model refused for its content can be sent instead. The
 * refusal comes from a vendor-wide classifier, so the escape has to leave the
 * vendor; GPT Sol Pro is the strongest non-Claude model main-line work uses.
 */
export function refusalFallbackSpec(currentSpec: string): string | null {
  const spec = resolveSpec(formatSlotRef("gpt", "sol", true));
  if (!spec || spec === currentSpec) return null;
  const vendor = vendorOf(spec);
  if (vendor === "unknown" || vendor === vendorOf(currentSpec)) return null;
  return spec;
}

/** Stable subagent-name token: the slot, never the provider or version that moves under it. */
export function poolToken(ref: string): string {
  const parsed = parseRef(ref);
  if (parsed?.kind === "slot") return `${parsed.family}-${parsed.slot}${parsed.pro ? "-pro" : ""}`;
  const id = parsed?.kind === "pin" ? bareModelId(splitSpec(parsed.spec)!.id) : ref;
  return id.replace(/\./g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

/** The slot an older build's pool-name token referred to (`claude-fable-5-1`, `gpt-6-astra-pro`). */
export function slotOfPoolToken(token: string): string | null {
  const exact = /^(claude|gpt)-(haiku|sonnet|opus|fable|luna|terra|sol|astra)(-pro)?$/.exec(token);
  if (exact) return formatSlotRef(exact[1] as FamilyName, exact[2] as SlotName, !!exact[3] && exact[1] === "gpt");
  let candidate = token;
  for (const prefix of [DIRECT_SUB_PROVIDER, GATEWAY_SUB_PROVIDER, LLM_API_PROVIDER, CODEX_PROVIDER, COPILOT_PROVIDER, "pp-flant-anthropic", "anthropic", "openai"]) {
    if (candidate.startsWith(`${prefix}-`)) candidate = candidate.slice(prefix.length + 1);
  }
  if (candidate.startsWith("sub-")) candidate = candidate.slice(4);
  const slot = slotOfModelId(candidate);
  return slot ? formatSlotRef(slot.family, slot.slot, slot.pro) : null;
}
