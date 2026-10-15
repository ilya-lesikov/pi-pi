import type { PiPiConfig, PoolKey } from "../config.js";
import { concreteProviderLabel, describeRef, parseRef, poolToken, resolveRef, slotOfPoolToken, splitSpec, type ModelDescription } from "../routing.js";
import type { RosterEntry } from "./tool-routing.js";

interface AgentFrontmatter {
  description: string;
  tools: string;
  model: string;
  thinking: string;
}

export interface AgentConfigSnapshot {
  /** The concrete model the definition was registered with. */
  model: string;
  /** The configured reference it resolved from, e.g. "claude/opus". */
  ref?: string;
  /** Configured reasoning effort / thinking level, e.g. "high", "xhigh". */
  thinking: string;
}

// agent name (e.g. "planner_opus") -> its configured model + reasoning effort.
// Populated at registration so lifecycle tracing can attribute durations to the
// exact model/effort a subagent ran with (the runtime lifecycle event carries a
// resolved modelId but never the configured effort). Keyed by the same name that
// surfaces as `type` on subagent lifecycle events.
const agentConfigByName = new Map<string, AgentConfigSnapshot>();

export function getAgentConfigSnapshot(name: string): AgentConfigSnapshot | undefined {
  return agentConfigByName.get(name);
}

// A pool member's subagent name: role, slot, thinking. Names are identifiers
// (Agent(subagent_type=…), only [A-Za-z0-9._-]) and they live in a system
// prompt for a whole turn, so they carry the slot rather than the provider or
// version under it, which a rate limit can move mid-turn.
export function encodePoolVariant(model: string, thinking: string): string {
  return `${poolToken(model)}_${thinking.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/**
 * What a role's configured reference runs on now, for its definition and its
 * prompt. An unresolvable reference keeps its own text as the model, which the
 * spawn gate refuses with the routing explanation rather than letting the
 * subagent host silently run it on the parent's model.
 */
export function agentModel(ref: string): { model: string; description: ModelDescription } {
  return { model: resolveRef(ref).spec ?? ref, description: describeRef(ref) };
}

const POOL_BASE_TYPE: Record<PoolKey, "advisor" | "reviewer" | "deep-debugger"> = {
  advisors: "advisor",
  reviewers: "reviewer",
  deepDebuggers: "deep-debugger",
};

// The ENABLED members of one pool, deduped by name (matching the registration
// skip), with what the caller needs to apply the cross-vendor rule.
export function buildPoolRoster(config: PiPiConfig, poolKey: PoolKey): RosterEntry[] {
  const base = POOL_BASE_TYPE[poolKey];
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of config.agents.subagents.pools[poolKey]) {
    if (entry.enabled === false) continue;
    const name = `${base}_${encodePoolVariant(entry.model, entry.thinking)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const resolution = resolveRef(entry.model);
    const description = describeRef(entry.model);
    out.push({
      name,
      ref: entry.model,
      model: resolution.spec,
      via: resolution.spec ? concreteProviderLabel(splitSpec(resolution.spec)!.provider) : null,
      description,
      proFallback: resolution.proFallback,
      thinking: entry.thinking,
    });
  }
  return out;
}

// All registered subagent type-names the Agent tool must accept: the fixed
// simple roles plus every enabled dynamic pool member.
export function registeredAgentNames(config: PiPiConfig): string[] {
  const names = ["explore", "librarian", "task"];
  for (const poolKey of Object.keys(POOL_BASE_TYPE) as PoolKey[]) {
    for (const r of buildPoolRoster(config, poolKey)) names.push(r.name);
  }
  return names;
}

// Map a dynamic pool name (advisor_*/reviewer_*/deep-debugger_*) back to its base
// role, for context-file lookup and spawn-context injection. Fixed roles map to
// themselves.
export function baseRoleForName(name: string): string {
  if (name.startsWith("advisor_")) return "advisor";
  if (name.startsWith("reviewer_")) return "reviewer";
  if (name.startsWith("deep-debugger_")) return "deep-debugger";
  return name;
}

const POOL_KEY_FOR_BASE: Record<string, PoolKey> = {
  advisor: "advisors",
  reviewer: "reviewers",
  "deep-debugger": "deepDebuggers",
};

/**
 * Resolve a pool name that is no longer registered onto the live member of the
 * same pool and family, or null when the pool has no such member.
 *
 * The names the model spawns by come from a system prompt rendered at the start
 * of its turn; a config reload or a provider-tier move during that turn can
 * rewrite the roster underneath it. Blocking the call would cost the turn a
 * round trip to learn a name it cannot otherwise know, so an obsolete spelling
 * of a member that still exists is honored instead.
 */
export function remapPoolName(config: PiPiConfig, requested: string): string | null {
  const base = baseRoleForName(requested);
  const poolKey = POOL_KEY_FOR_BASE[base];
  if (!poolKey || requested === base) return null;
  const variant = requested.slice(base.length + 1);
  const split = variant.lastIndexOf("_");
  if (split <= 0) return null;
  const slot = slotOfPoolToken(variant.slice(0, split));
  if (!slot) return null;
  const thinking = variant.slice(split + 1);
  const sameSlot = (ref: string, ignorePro: boolean) => {
    const parsed = parseRef(ref);
    const wanted = parseRef(slot);
    if (parsed?.kind !== "slot" || wanted?.kind !== "slot") return false;
    return parsed.family === wanted.family && parsed.slot === wanted.slot && (ignorePro || parsed.pro === wanted.pro);
  };
  const roster = buildPoolRoster(config, poolKey);
  const exact = roster.filter((r) => sameSlot(r.ref, false));
  const candidates = exact.length > 0 ? exact : roster.filter((r) => sameSlot(r.ref, true));
  // Prefer the effort the caller asked for, then the nearest one ABOVE it: a
  // judgment call silently answered at a weaker effort is worse than one that
  // costs more than intended.
  const wanted = THINKING_ORDER.indexOf(thinking);
  const ranked = [...candidates].sort((a, b) => rankThinking(a.thinking, wanted) - rankThinking(b.thinking, wanted));
  return ranked[0]?.name ?? null;
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

function rankThinking(thinking: string, wanted: number): number {
  const index = THINKING_ORDER.indexOf(thinking);
  if (wanted < 0 || index < 0) return index === wanted ? 0 : 100;
  const distance = index - wanted;
  return distance >= 0 ? distance : 10 - distance;
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  model: string;
  ref?: string;
  thinking: string;
  systemPrompt: string;
}

const definitions = new Map<string, AgentDefinition>();

export function getAgentDefinition(name: string): AgentDefinition | undefined {
  return definitions.get(name);
}

export function listAgentDefinitions(): AgentDefinition[] {
  return [...definitions.values()];
}

export function registerAgentDefinitions(
  agents: Array<{ type: string; variant: string | null; frontmatter: AgentFrontmatter & { ref?: string }; prompt: string }>,
): void {
  definitions.clear();
  agentConfigByName.clear();
  for (const agent of agents) {
    const suffix = agent.variant ? `_${agent.variant}` : "";
    const name = `${agent.type}${suffix}`;
    const tools = agent.frontmatter.tools === "none" ? [] : agent.frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean);
    agentConfigByName.set(name, { model: agent.frontmatter.model, ref: agent.frontmatter.ref, thinking: agent.frontmatter.thinking });
    definitions.set(name, {
      name,
      description: agent.frontmatter.description,
      tools,
      model: agent.frontmatter.model,
      ref: agent.frontmatter.ref,
      thinking: agent.frontmatter.thinking,
      systemPrompt: agent.prompt,
    });
  }
}
