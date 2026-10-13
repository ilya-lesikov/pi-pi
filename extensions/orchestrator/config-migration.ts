import { formatSlotRef, slotOfModelId, splitSpec } from "./routing.js";

// Providers whose specs the old tier resolver moved freely between tiers, so a
// role naming one meant "this model line", never "this provider".
const TIER_ROUTED_PROVIDERS = new Set(["pp-flant-anthropic-sub", "pp-flant-anthropic", "pp-flant-openai", "flant-anthropic", "flant-openai"]);

const LATEST_ALIAS = /^[a-z0-9-]+\/(claude-(haiku|sonnet|opus|fable)|gpt-(luna|terra|sol|astra))-latest$/;

/**
 * The slot reference an old provider-bound model spec stood for. A spec the old
 * resolver never moved (a Copilot or ChatGPT version, a native one, anything
 * outside the two families) is kept as the pin it always was.
 */
export function migrateModelRef(ref: string): string {
  const alias = LATEST_ALIAS.exec(ref);
  if (alias) {
    const family = alias[2] ? "claude" : "gpt";
    return formatSlotRef(family, (alias[2] ?? alias[3]) as any);
  }
  const parts = splitSpec(ref);
  if (!parts || !TIER_ROUTED_PROVIDERS.has(parts.provider)) return ref;
  const slot = slotOfModelId(parts.id);
  return slot ? formatSlotRef(slot.family, slot.slot, slot.pro) : ref;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function setIfAbsent(target: Record<string, any>, path: string[], value: unknown): void {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (!isObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  const leaf = path[path.length - 1]!;
  if (cursor[leaf] === undefined) cursor[leaf] = value;
}

function migrateAgentRefs(agents: Record<string, any>): boolean {
  let changed = false;
  const visit = (entry: unknown) => {
    if (!isObject(entry) || typeof entry.model !== "string") return;
    const next = migrateModelRef(entry.model);
    if (next !== entry.model) {
      entry.model = next;
      changed = true;
    }
  };
  visit(agents.main);
  if (isObject(agents.subagents?.simple)) Object.values(agents.subagents.simple).forEach(visit);
  if (isObject(agents.subagents?.pools)) {
    for (const pool of Object.values(agents.subagents.pools)) if (Array.isArray(pool)) pool.forEach(visit);
  }
  return changed;
}

/**
 * Rewrite one config layer from the provider-tier schema (`flant.*`,
 * provider-bound model specs) onto providers/models and slot references.
 * Pure: returns a migrated copy and whether anything changed, so callers decide
 * whether the result is persisted.
 */
export function migrateConfigLayer(raw: Record<string, any>): { config: Record<string, any>; changed: boolean } {
  const config = structuredClone(raw);
  let changed = false;
  if (isObject(config.flant)) {
    const f = config.flant;
    if (typeof f.subscription === "boolean") setIfAbsent(config, ["providers", "claude-sub", "enabled"], f.subscription);
    if (typeof f.codexEnabled === "boolean") setIfAbsent(config, ["providers", "codex", "enabled"], f.codexEnabled);
    if (typeof f.copilotEnabled === "boolean") setIfAbsent(config, ["providers", "copilot", "enabled"], f.copilotEnabled);
    if (f.enabled === false) {
      // The old switch turned the gateway off entirely, the subscription's
      // route through it included.
      setIfAbsent(config, ["providers", "llm-api", "enabled"], false);
      setIfAbsent(config, ["providers", "claude-sub", "route"], ["direct"]);
    }
    if (typeof f.autoUpdate === "boolean") setIfAbsent(config, ["providers", "llm-api", "autoUpdate"], f.autoUpdate);
    if (typeof f.cacheTTLDays === "number") setIfAbsent(config, ["providers", "llm-api", "cacheTTLDays"], f.cacheTTLDays);
    if (typeof f.autoRateLimitFallback === "boolean") setIfAbsent(config, ["providers", "fallback", "auto"], f.autoRateLimitFallback);
    if (typeof f.switchBackIntervalMinutes === "number") setIfAbsent(config, ["providers", "fallback", "retryAfterMinutes"], f.switchBackIntervalMinutes);
    delete config.flant;
    changed = true;
  }
  if (isObject(config.agents) && migrateAgentRefs(config.agents)) changed = true;
  return { config, changed };
}
