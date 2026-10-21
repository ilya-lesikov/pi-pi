// The state file pi-pi writes (extensions/orchestrator/bb-bridge.ts), and pure
// helpers over it shared by server.ts and app.tsx. The types are a copy, so the
// plugin builds on its own; pi-pi's tests check the two stay compatible.

export interface BbState {
  version: 1;
  pid: number;
  live: boolean;
  heartbeatAt: number;
  tasks: Array<{ id: string; subject: string; status: string; activeForm?: string }>;
  workers: BbWorker[];
  commandResults: Array<{ id: string; ok: boolean; message: string; at: number }>;
}

export interface BbWorker {
  id: string;
  type: string;
  description: string;
  prompt: string;
  status: "queued" | "running" | "idle" | "completed" | "failed" | "stopped" | "killed";
  model: string;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  lastEventAt: number;
  silent: boolean;
  toolUses: number;
  tokens: number;
  step?: { label: string; since: number };
  progress?: string;
  outputTail: string;
  question?: string;
  result?: { status: string; summary: string; body: string };
  error?: string;
}

export interface BbCommand {
  id: string;
  workerId: string;
  action: "stop" | "kill" | "message";
  text?: string;
}

/** pi rewrites the file at least every few seconds while its session lives. */
const STALE_MS = 15_000;

export type Staleness = "ended" | "unresponsive" | null;

export type WorkerState = "asking" | "silent" | "failed" | "running" | "pending" | "stopped" | "done";

const STATE_ORDER: WorkerState[] = ["asking", "silent", "failed", "running", "pending", "stopped", "done"];

export function workerState(worker: BbWorker): WorkerState {
  if (worker.question) return "asking";
  if (worker.status === "queued") return "pending";
  if (worker.status === "running") return worker.silent ? "silent" : "running";
  if (worker.status === "failed" || worker.status === "killed") return "failed";
  if (worker.status === "stopped") return "stopped";
  return "done";
}

export function isActive(worker: BbWorker): boolean {
  return worker.status === "queued" || worker.status === "running";
}

/** Most urgent first: questions, then trouble, then work in progress. */
export function orderWorkers(workers: readonly BbWorker[]): BbWorker[] {
  return [...workers].sort((a, b) => STATE_ORDER.indexOf(workerState(a)) - STATE_ORDER.indexOf(workerState(b)) || a.createdAt - b.createdAt);
}

/**
 * Why the file can no longer be trusted to be current, if it cannot.
 * `heartbeatAgeMs` is measured on the reader's clock, since the last poll that
 * saw `heartbeatAt` change: pi may run on a machine whose clock differs.
 */
export function staleness(state: BbState, heartbeatAgeMs: number): Staleness {
  if (!state.live) return "ended";
  return heartbeatAgeMs > STALE_MS ? "unresponsive" : null;
}

/** Workers as they can be shown: with pi gone, nothing of theirs is still running or asking. */
export function shownWorkers(state: BbState, stale: Staleness): BbWorker[] {
  if (!stale) return state.workers;
  const reason = stale === "ended" ? "pi's session ended" : "pi is not responding";
  return state.workers.map((worker) => {
    if (!isActive(worker)) return worker;
    const { question: _question, step: _step, ...rest } = worker;
    return { ...rest, status: "stopped", settledAt: worker.lastEventAt, error: reason };
  });
}

/** The one line under a worker's name. */
export function workerActivity(worker: BbWorker, now: number): string {
  const state = workerState(worker);
  if (state === "asking") return `asks: ${oneLine(worker.question!)}`;
  if (state === "pending") return "queued";
  if (state === "silent") return `silent ${formatDuration(now - worker.lastEventAt)}${worker.step ? ` in ${worker.step.label.replace(/^running /, "")}` : ""}`;
  if (state === "failed") return worker.error ? `${worker.status}: ${oneLine(worker.error)}` : worker.status;
  if (state === "running") return oneLine(worker.progress || worker.step?.label || lastLine(worker.outputTail) || "thinking");
  if (state === "stopped" && worker.error) return oneLine(worker.error);
  return worker.result?.summary ? oneLine(worker.result.summary) : worker.status;
}

export function workerElapsed(worker: BbWorker, now: number): string {
  return formatDuration((worker.settledAt ?? now) - (worker.startedAt ?? worker.createdAt));
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The checklist card's one-line summary; null when there is nothing left to show. */
export function taskSummary(tasks: BbState["tasks"]): { done: number; total: number; current: string | null } | null {
  if (!tasks.some((task) => task.status !== "completed")) return null;
  const current = tasks.find((task) => task.status === "in_progress");
  return {
    done: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
    current: current ? current.activeForm || current.subject : null,
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter((line) => line.trim()).at(-1)?.trim() ?? "";
}
