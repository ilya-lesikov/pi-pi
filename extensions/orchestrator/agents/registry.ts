import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiPiConfig, PoolKey } from "../config.js";
import { concreteProviderLabel, describeRef, parseRef, poolToken, resolveRef, slotOfPoolToken, splitSpec, type ModelDescription } from "../routing.js";
import type { RosterEntry } from "./tool-routing.js";

interface AgentFrontmatter {
  description: string;
  tools: string;
  model: string;
  thinking: string;
  max_turns?: number;
  prompt_mode?: string;
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

export function registerAgentDefinitions(
  pi: ExtensionAPI,
  agents: Array<{ type: string; variant: string | null; frontmatter: AgentFrontmatter & { ref?: string }; prompt: string }>,
): void {
  const agentMap = new Map<string, any>();

  for (const agent of agents) {
    const suffix = agent.variant ? `_${agent.variant}` : "";
    const name = `${agent.type}${suffix}`;
    const toolNames = agent.frontmatter.tools === "none" ? [] : agent.frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean);

    agentConfigByName.set(name, { model: agent.frontmatter.model, ref: agent.frontmatter.ref, thinking: agent.frontmatter.thinking });

    agentMap.set(name, {
      name,
      description: agent.frontmatter.description,
      builtinToolNames: toolNames,
      extensions: true,
      skills: false,
      model: agent.frontmatter.model,
      thinking: agent.frontmatter.thinking,
      maxTurns: agent.frontmatter.max_turns,
      systemPrompt: agent.prompt,
      promptMode: agent.frontmatter.prompt_mode ?? "replace",
      inheritContext: false,
      runInBackground: true,
      isolated: false,
      enabled: true,
      source: "project",
    });
  }

  pi.events.emit("subagents:register-agents", { agents: agentMap });
}

export function unregisterAgentDefinitions(pi: ExtensionAPI): void {
  pi.events.emit("subagents:unregister-agents", { all: true });
}

export function setExtensionOnlyMode(pi: ExtensionAPI): void {
  pi.events.emit("subagents:set-extension-only", { enabled: true });
}

export function spawnViaRpc(
  pi: ExtensionAPI,
  agentType: string,
  prompt: string,
  options: {
    description: string;
    maxTurns?: number;
    spawnTimeout?: number;
    validateCompletion?: () => string | undefined;
    maxValidationRetries?: number;
  },
): Promise<{ id: string }> {
  const timeout = options.spawnTimeout ?? 30000;
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const replyEvent = `subagents:rpc:spawn:reply:${requestId}`;

    const unsub = pi.events.on(replyEvent, (reply: any) => {
      unsub();
      if (reply.success) {
        const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
        mgr?.refreshWidget?.();
        resolve({ id: reply.data?.id ?? requestId });
      } else {
        reject(new Error(reply.error || "spawn failed"));
      }
    });

    pi.events.emit("subagents:rpc:spawn", {
      requestId,
      type: agentType,
      prompt,
      options: {
        description: options.description,
        run_in_background: true,
        maxTurns: options.maxTurns,
        validateCompletion: options.validateCompletion,
        maxValidationRetries: options.maxValidationRetries,
      },
    });

    setTimeout(() => {
      unsub();
      reject(new Error(`spawn timeout for ${agentType}`));
    }, timeout);
  });
}

const TERMINAL_STATUSES = ["completed", "steered", "aborted", "stopped", "error"];
const FAILED_STATUSES = ["aborted", "stopped", "error"];

// Grace window for a manager record that cannot be found. A transiently missing
// record (the global manager is swapped or cleared during a session switch,
// compaction, or extension re-activation) must NOT reject — the agent is still
// alive in the owning manager and its terminal event remains authoritative.
// Only a record that stays missing CONTINUOUSLY for this window (with no
// terminal event) is treated as gone. This bounds both the never-spawned ghost
// and the seen-then-vanished case (e.g. session_shutdown deletes the manager
// handle and abortAll() marks records stopped without emitting an event).
const MISSING_RECORD_GRACE_MS = 60_000;
// Poll cadence for reconciling against the manager record. Must be well under
// MISSING_RECORD_GRACE_MS so several polls occur before a ghost is declared.
const RECORD_POLL_MS = 15_000;

export function waitForCompletion(
  pi: ExtensionAPI,
  agentId: string,
): Promise<{ result: string; status: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Timestamp of the first poll in the current uninterrupted run of
    // missing-record observations. Reset to null whenever a record is present,
    // so only a CONTINUOUS gap of MISSING_RECORD_GRACE_MS rejects.
    let missingSince: number | null = null;
    let checkTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (checkTimer) clearInterval(checkTimer);
      unsubCompleted();
      unsubFailed();
    };
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    // The completion/failure events are the authoritative signal — the manager
    // emits them on shared pi.events even after its record is cleared, so they
    // fire regardless of manager-instance churn.
    const unsubCompleted = pi.events.on("subagents:completed", (data: any) => {
      if (data.id === agentId) {
        done(() => resolve({ result: data.result ?? "", status: data.status ?? "completed" }));
      }
    });

    const unsubFailed = pi.events.on("subagents:failed", (data: any) => {
      if (data.id === agentId) {
        done(() => reject(new Error(data.error || `agent ${agentId} failed`)));
      }
    });

    // Backstop reconciliation against the manager record. This closes the race
    // where the agent reached a terminal state in the gap between spawn and the
    // event subscription above (the completion/failure event fired before we
    // were listening) — settle from the record instead of hanging.
    //
    // A transiently MISSING record is NOT an immediate failure: the global
    // manager can be swapped or cleared (session switch, compaction, extension
    // re-activation) while the agent is still alive in the owning manager.
    // Rejecting on the first missing observation was the "not found in manager"
    // bug — it killed the wait before the still-pending event could arrive.
    // Only a record that stays missing continuously for the grace window (with
    // no terminal event) is declared gone — bounding the case where the manager
    // is torn down without emitting a terminal event (session_shutdown +
    // abortAll).
    const checkRecord = () => {
      const mgr = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const record = mgr?.getRecord?.(agentId);
      if (!record) {
        const now = Date.now();
        if (missingSince === null) missingSince = now;
        else if (now - missingSince >= MISSING_RECORD_GRACE_MS) {
          done(() => reject(new Error(`agent ${agentId} not found in manager`)));
        }
        return;
      }
      missingSince = null;
      if (TERMINAL_STATUSES.includes(record.status)) {
        if (FAILED_STATUSES.includes(record.status)) {
          done(() => reject(new Error(record.error || `agent ${agentId} failed`)));
        } else {
          done(() => resolve({ result: record.result ?? "", status: record.status }));
        }
      }
    };

    checkRecord();
    if (!settled) checkTimer = setInterval(checkRecord, RECORD_POLL_MS);
  });
}

export function isSubagentsReady(pi: ExtensionAPI, pingTimeout?: number): Promise<boolean> {
  const timeout = pingTimeout ?? 5000;
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const replyEvent = `subagents:rpc:ping:reply:${requestId}`;

    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeout);

    const unsub = pi.events.on(replyEvent, (reply: any) => {
      clearTimeout(timer);
      unsub();
      resolve(reply.success === true);
    });

    pi.events.emit("subagents:rpc:ping", { requestId });
  });
}
