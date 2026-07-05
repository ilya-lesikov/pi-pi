import type { Phase } from "./state.js";

// Telemetry-driven SOFT delegation nudges. Detects two behaviour signals from the
// MAIN agent's tool stream — broad codebase search and a stuck debug loop — and lets
// event-handlers inject a soft suggestion to spawn explore / deep-debugger / advisor.
// Every threshold is a named constant (mirroring MAX_CONSECUTIVE_NUDGES) so tuning
// needs no redesign. Conservative on purpose: a false-positive nudge trains the agent
// (and user) to ignore nudges, so a missed nudge is preferable to a spurious one.

// Rolling window (most-recent qualifying search calls) inspected for the broad-search
// signal, and the counts that trip it. A trigger needs BROAD_SEARCH_MIN_CALLS qualifying
// calls spanning BROAD_SEARCH_MIN_DISTINCT distinct files/paths within the window — the
// distinct-path clause separates genuine discovery from re-reading one file in an edit loop.
export const BROAD_SEARCH_WINDOW = 8;
export const BROAD_SEARCH_MIN_CALLS = 5;
export const BROAD_SEARCH_MIN_DISTINCT = 3;

// Stuck-debug: consecutive failed runs on the SAME command family, or a long edit loop
// in one phase with no convergence (successful pp_commit / pp_phase_complete).
export const STUCK_DEBUG_MIN_FAILURES = 3;
export const STUCK_DEBUG_MIN_PHASE_TURNS = 20;

// Own anti-spam cap, matching the continuation nudge magnitude.
export const MAX_DELEGATION_NUDGES = 6;

// Effectiveness correlation: a fired nudge resolves as "accepted" if a matching
// discretionary spawn follows within this many turns (before the next nudge); else it
// expires. Bounds the accepted-vs-expired decision so it is deterministic.
export const NUDGE_SPAWN_CORRELATION_TURNS = 6;

// Defensive bound on the in-flight toolCallId->args map: evicted on tool_execution_end,
// but capped in case an end event is ever dropped, to avoid an unbounded leak.
export const TOOL_CALL_MAP_MAX = 50;

// Bash commands that count as a codebase SEARCH. Plain bash (git/build/test/cd/...) does
// NOT count — in real traces bash dwarfs grep/find, so counting all bash would trip the
// window almost constantly. Exact set is a named constant, tuned conservatively.
export const BASH_SEARCH_COMMANDS = new Set([
  "grep", "rg", "find", "ag", "ack", "ls", "cat", "head", "tail", "sed", "awk", "fd",
]);

export type DelegationSignal = "broad-search" | "stuck-debug";

// The discretionary (main-agent-initiated) roles. Orchestrated triad spawns
// (planner/*_reviewer, carrying model suffixes) are NOT discretionary and must not
// count as nudge acceptance. Kept in sync with SIMPLE_SUBAGENT_ROLES in config.ts.
const DISCRETIONARY_TYPES = new Set(["explore", "librarian", "task", "advisor", "deep-debugger", "reviewer"]);

export function isDiscretionarySpawn(type: string | undefined | null): boolean {
  if (!type) return false;
  return DISCRETIONARY_TYPES.has(type.toLowerCase());
}

// Which phases each signal may nudge in. Deliberately INVERTED from continuation nudges
// (plan/implement only): broad search happens during exploration, debugging during
// implementation. plan (read-only synthesis) and review (mechanical) are excluded.
export function broadSearchPhaseEnabled(phase: Phase): boolean {
  return phase === "brainstorm" || phase === "implement" || phase === "quick";
}

export function stuckDebugPhaseEnabled(phase: Phase): boolean {
  return phase === "debug" || phase === "implement" || phase === "quick";
}

interface ToolCallInfo {
  toolName: string;
  path?: string;
  command?: string;
}

// Defensive against unknown arg shapes: never throws, yields a non-search descriptor.
export function classifyTool(toolName: string, args: any): { isSearch: boolean; path?: string; commandFamily?: string; isBash: boolean } {
  const name = (toolName || "").toLowerCase();
  if (name === "read" || name === "grep" || name === "ls") {
    const path = typeof args?.path === "string" ? args.path : undefined;
    return { isSearch: true, path, isBash: false };
  }
  if (name === "find") {
    const path = typeof args?.path === "string" ? args.path : (typeof args?.pattern === "string" ? args.pattern : undefined);
    return { isSearch: true, path, isBash: false };
  }
  if (name === "bash") {
    const command = typeof args?.command === "string" ? args.command : "";
    // Real traces wrap searches as `cd <repo> && grep …`, so inspect each &&/;/|
    // segment, not just the leading token (which would misread as `cd`).
    const searchSeg = commandSegments(command).find((seg) => {
      const exe = firstExecutable(seg);
      return exe != null && BASH_SEARCH_COMMANDS.has(exe);
    });
    if (searchSeg) {
      return { isSearch: true, path: bashSearchTarget(searchSeg), commandFamily: commandFamily(command), isBash: true };
    }
    return { isSearch: false, commandFamily: commandFamily(command), isBash: true };
  }
  return { isSearch: false, isBash: false };
}

function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

function firstExecutable(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    const base = tok.split("/").pop() || tok;
    return base.toLowerCase();
  }
  return undefined;
}

// A stable "command family" for similarity comparison, compared instead of raw stderr/
// argument text. Skips a leading `cd` segment so `cd x && go test` keys on `go test`.
export function commandFamily(command: string): string {
  const segments = commandSegments(command);
  const seg = segments.find((s) => firstExecutable(s) !== "cd") ?? command;
  const tokens = seg.trim().split(/\s+/).filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (tokens.length === 0) return "";
  const exe = (tokens[0].split("/").pop() || tokens[0]).toLowerCase();
  const MULTIPLEXERS = new Set(["go", "npm", "yarn", "pnpm", "git", "cargo", "make", "npx", "python", "python3", "node", "bun", "deno"]);
  if (MULTIPLEXERS.has(exe) && tokens[1] && !tokens[1].startsWith("-")) {
    return `${exe} ${tokens[1].toLowerCase()}`;
  }
  return exe;
}

// The path/target operand of an allowlisted bash search command (last non-flag token),
// so it can contribute to the distinct-file set. Best-effort; undefined when unclear.
function bashSearchTarget(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 1; i--) {
    const tok = tokens[i];
    if (!tok || tok.startsWith("-") || tok === "|" || tok.includes("|")) continue;
    return tok;
  }
  return undefined;
}

export interface PendingNudge {
  nudgeId: string;
  signal: DelegationSignal;
  recommendedRole: string;
  firedTurnIndex: number;
}

// A spawn counts as accepting a nudge only when its role matches the recommended family:
// broad-search wants explore; stuck-debug wants deep-debugger or advisor. An unrelated
// discretionary spawn (task/librarian/reviewer) must not pollute the effectiveness metric.
export function spawnMatchesSignal(signal: DelegationSignal, spawnType: string | undefined | null): boolean {
  const t = (spawnType || "").toLowerCase();
  if (signal === "broad-search") return t === "explore";
  return t === "deep-debugger" || t === "advisor";
}

export function isPendingExpired(pending: PendingNudge, turnIndex: number): boolean {
  return turnIndex - pending.firedTurnIndex > NUDGE_SPAWN_CORRELATION_TURNS;
}

// Holds all transient per-session detection state. One instance lives on the Orchestrator;
// event-handlers feed it tool events and query it at turn_end.
export class DelegationDetector {
  private toolCalls = new Map<string, ToolCallInfo>();
  // Rolling window of recent qualifying search paths (undefined path allowed but does not
  // add to the distinct set).
  private searchWindow: Array<string | undefined> = [];
  // Count of qualifying search calls seen since the last explore spawn. Suppression
  // decays once this exceeds the window size (the spawn has rolled out of the window).
  private searchesSinceExplore = Number.MAX_SAFE_INTEGER;
  private lastFailedFamily: string | null = null;
  private failureStreak = 0;
  private phaseBaselineTurn = 0;
  private editedSinceConverge = false;
  pending: PendingNudge | null = null;

  reset(): void {
    this.toolCalls.clear();
    this.searchWindow = [];
    this.searchesSinceExplore = Number.MAX_SAFE_INTEGER;
    this.lastFailedFamily = null;
    this.failureStreak = 0;
    this.phaseBaselineTurn = 0;
    this.editedSinceConverge = false;
    this.pending = null;
  }

  onPhaseChange(turnIndex: number): void {
    this.phaseBaselineTurn = turnIndex;
    this.editedSinceConverge = false;
    this.searchWindow = [];
    this.searchesSinceExplore = Number.MAX_SAFE_INTEGER;
    this.lastFailedFamily = null;
    this.failureStreak = 0;
  }

  recordToolStart(toolCallId: string, toolName: string, args: any): void {
    if (!toolCallId) return;
    const c = classifyTool(toolName, args);
    this.toolCalls.set(toolCallId, { toolName: (toolName || "").toLowerCase(), path: c.path, command: c.isBash ? (typeof args?.command === "string" ? args.command : "") : undefined });
    if (this.toolCalls.size > TOOL_CALL_MAP_MAX) {
      const oldest = this.toolCalls.keys().next().value;
      if (oldest !== undefined) this.toolCalls.delete(oldest);
    }
  }

  // tool_execution_end lacks args, so correlate with the start-time descriptor by id,
  // update detection state, then evict. turnIndex feeds the convergence-reset (M5).
  recordToolEnd(toolCallId: string, toolName: string, isError: boolean, turnIndex: number): void {
    const info = toolCallId ? this.toolCalls.get(toolCallId) : undefined;
    if (toolCallId) this.toolCalls.delete(toolCallId);
    const name = (toolName || info?.toolName || "").toLowerCase();

    const c = classifyTool(name, name === "bash" ? { command: info?.command } : { path: info?.path, pattern: info?.path });
    if (c.isSearch) {
      this.searchWindow.push(c.path);
      if (this.searchWindow.length > BROAD_SEARCH_WINDOW) this.searchWindow.shift();
      if (this.searchesSinceExplore !== Number.MAX_SAFE_INTEGER) this.searchesSinceExplore += 1;
    }

    // Stuck-debug failure streak: only bash failures, keyed on command family.
    if (name === "bash") {
      const family = c.commandFamily ?? commandFamily(info?.command ?? "");
      if (isError && family) {
        if (family === this.lastFailedFamily) {
          this.failureStreak += 1;
        } else {
          this.lastFailedFamily = family;
          this.failureStreak = 1;
        }
      } else if (!isError && family && family === this.lastFailedFamily) {
        this.lastFailedFamily = null;
        this.failureStreak = 0;
      }
    }

    if (name === "edit" || name === "write") {
      this.editedSinceConverge = true;
    }
    // A commit / phase completion converges the edit loop: clear the flag AND restart the
    // turn window, else the next post-commit edit re-fires immediately past the threshold.
    if (name === "pp_commit" || name === "pp_phase_complete") {
      this.editedSinceConverge = false;
      this.phaseBaselineTurn = turnIndex;
    }
  }

  // Suppress broad-search only while the spawn is still within the rolling window: reset the
  // per-window search counter so suppression decays once the window advances past the spawn.
  onExploreSpawned(): void {
    this.searchesSinceExplore = 0;
  }

  private broadSearchActive(): boolean {
    if (this.searchesSinceExplore < BROAD_SEARCH_WINDOW) return false;
    const calls = this.searchWindow.length;
    if (calls < BROAD_SEARCH_MIN_CALLS) return false;
    const distinct = new Set(this.searchWindow.filter((p): p is string => typeof p === "string" && p.length > 0));
    return distinct.size >= BROAD_SEARCH_MIN_DISTINCT;
  }

  private stuckDebugActive(turnIndex: number): boolean {
    if (this.failureStreak >= STUCK_DEBUG_MIN_FAILURES) return true;
    if (this.editedSinceConverge && turnIndex - this.phaseBaselineTurn >= STUCK_DEBUG_MIN_PHASE_TURNS) return true;
    return false;
  }

  // Decide whether a signal is currently active for the given phase. Broad-search takes
  // precedence (cheaper to satisfy, primary concern). Returns null when nothing fires.
  evaluate(phase: Phase, turnIndex: number): { signal: DelegationSignal; recommendedRole: string } | null {
    if (broadSearchPhaseEnabled(phase) && this.broadSearchActive()) {
      return { signal: "broad-search", recommendedRole: "explore" };
    }
    if (stuckDebugPhaseEnabled(phase) && this.stuckDebugActive(turnIndex)) {
      return { signal: "stuck-debug", recommendedRole: "deep-debugger" };
    }
    return null;
  }

  // After a nudge fires, clear the window/streak so the same trigger does not immediately
  // re-fire on the next turn without new evidence.
  clearActiveSignals(): void {
    this.searchWindow = [];
    this.failureStreak = 0;
    this.lastFailedFamily = null;
    this.editedSinceConverge = false;
  }
}

export function delegationNudgeMessage(signal: DelegationSignal, phase: Phase): string {
  if (signal === "broad-search") {
    return `[PI-PI] You've done several file/search reads across the codebase this turn. Consider spawning an \`explore\` subagent to map this out and return a distilled answer — it keeps your context clean for the actual ${phase} work. You may continue inline if you judge that better.`;
  }
  return `[PI-PI] This looks like a persistent debug loop (repeated failures / a long edit cycle without converging). Consider spawning a \`deep-debugger\` (to root-cause) or \`advisor\` (for a design/"why is this broken" judgment) subagent. You may continue inline if you judge that better.`;
}
