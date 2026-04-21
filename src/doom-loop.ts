import { SUGGESTIONS, GENERIC_SUGGESTION } from "./doom-loop-suggestions.js";
export const MAX_RECENT_TOOL_CALLS = 24;

export interface RecordedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  fingerprint: string;
}

export interface DoomLoopStep {
  toolName: string;
  input: Record<string, unknown>;
}

export type DoomLoopWarning =
  | {
      kind: "identical-tail";
      toolName: string;
      fingerprint: string;
    }
  | {
      kind: "repeated-subsequence";
      toolName: string;
      fingerprint: string;
      steps: DoomLoopStep[];
    };

export interface DoomLoopState {
  recentCalls: RecordedToolCall[];
  pendingWarnings: Map<string, DoomLoopWarning>;
}

export function createDoomLoopState(): DoomLoopState {
  return {
    recentCalls: [],
    pendingWarnings: new Map<string, DoomLoopWarning>(),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function makeToolFingerprint(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(input)}`;
}

function sameFingerprints(left: RecordedToolCall[], right: RecordedToolCall[]): boolean {
  return left.length === right.length && left.every((call, index) => call.fingerprint === right[index]?.fingerprint);
}

function hasIdenticalTail(calls: RecordedToolCall[]): boolean {
  if (calls.length < 3) {
    return false;
  }

  const last = calls[calls.length - 1]?.fingerprint;
  return calls[calls.length - 2]?.fingerprint === last && calls[calls.length - 3]?.fingerprint === last;
}

function findRepeatedSubsequenceWindow(calls: RecordedToolCall[]): number | null {
  const maxWindowSize = Math.floor(calls.length / 3);
  for (let windowSize = 2; windowSize <= maxWindowSize; windowSize++) {
    const newest = calls.slice(-windowSize);
    const middle = calls.slice(-windowSize * 2, -windowSize);
    const oldest = calls.slice(-windowSize * 3, -windowSize * 2);
    if (sameFingerprints(newest, middle) && sameFingerprints(middle, oldest)) {
      return windowSize;
    }
  }
  return null;
}

export function recordToolCall(
  state: DoomLoopState,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
): void {
  const fingerprint = makeToolFingerprint(toolName, input);
  state.recentCalls.push({ toolCallId, toolName, input, fingerprint });

  if (state.recentCalls.length > MAX_RECENT_TOOL_CALLS) {
    state.recentCalls.splice(0, state.recentCalls.length - MAX_RECENT_TOOL_CALLS);
  }

  if (hasIdenticalTail(state.recentCalls)) {
    state.pendingWarnings.set(toolCallId, {
      kind: "identical-tail",
      toolName,
      fingerprint,
    });
    return;
  }

  const windowSize = findRepeatedSubsequenceWindow(state.recentCalls);
  if (windowSize !== null) {
    const newest = state.recentCalls.slice(-windowSize);
    state.pendingWarnings.set(toolCallId, {
      kind: "repeated-subsequence",
      toolName,
      fingerprint,
      steps: newest.map((call) => ({ toolName: call.toolName, input: call.input })),
    });
  }
}

export function consumeDoomLoopWarning(
  state: DoomLoopState,
  toolCallId: string,
): DoomLoopWarning | null {
  const warning = state.pendingWarnings.get(toolCallId);
  if (!warning) return null;
  state.pendingWarnings.delete(toolCallId);
  return warning;
}

const COMPACT_LINE_BUDGET = 80;
const STEP_PREFIX = "  → ";

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function renderCompactStep(toolName: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const salient = keys.slice(0, 2);
  const base = `${STEP_PREFIX}${toolName}`;
  if (salient.length === 0) return truncate(`${base} {}`, COMPACT_LINE_BUDGET);

  let line = base;
  for (const key of salient) {
    const rendered = JSON.stringify(input[key]);
    const part = ` ${key}=${rendered}`;
    const candidate = line + part;
    if (candidate.length > COMPACT_LINE_BUDGET) {
      const remaining = COMPACT_LINE_BUDGET - (line + ` ${key}=`).length;
      line = `${line} ${key}=${truncate(rendered, Math.max(1, remaining))}`;
      return line;
    }
    line = candidate;
  }
  return truncate(line, COMPACT_LINE_BUDGET);
}

function parseFingerprintInput(fingerprint: string): Record<string, unknown> {
  const colon = fingerprint.indexOf(":");
  if (colon < 0) return {};
  const json = fingerprint.slice(colon + 1);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function suggestionsFor(toolName: string): string[] {
  const entry = SUGGESTIONS[toolName];
  if (entry && entry.length > 0) return [...entry];
  return [GENERIC_SUGGESTION];
}

function renderSuggestionBullets(toolNames: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of toolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const bullets = suggestionsFor(name);
    lines.push(`For ${name}:`);
    for (const bullet of bullets) {
      lines.push(`  • ${bullet}`);
    }
  }
  return lines.join("\n");
}

export function formatDoomLoopMessage(warning: DoomLoopWarning): string {
  if (warning.kind === "identical-tail") {
    const input = parseFingerprintInput(warning.fingerprint);
    const compact = renderCompactStep(warning.toolName, input);
    const suggestions = renderSuggestionBullets([warning.toolName]);
    return [
      "⚠ REPEATED-CALL WARNING: This is the 3rd identical tool call.",
      compact,
      "",
      "Continuing this pattern will not make progress. Suggestions:",
      suggestions,
    ].join("\n");
  }

  const stepLines = warning.steps.map((step) => renderCompactStep(step.toolName, step.input));
  const suggestions = renderSuggestionBullets(warning.steps.map((step) => step.toolName));
  return [
    `⚠ ALTERNATING-CALL WARNING: You have called this sequence ${warning.steps.length > 0 ? "3 times" : ""}:`.trimEnd(),
    ...stepLines,
    "",
    "Neither call is producing new information. Break the loop with a different approach.",
    "",
    suggestions,
  ].join("\n");
}

