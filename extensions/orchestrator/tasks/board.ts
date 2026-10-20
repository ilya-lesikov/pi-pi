import type { Task } from "./state.js";

/** At most this many task rows; the rest is one "… N more" row. */
export const TASK_ROWS = 5;

export interface TaskBoardRow {
  kind: "running" | "pending" | "more";
  text: string;
  task?: Task;
}

export interface TaskBoard {
  /** Counts in display order, only the non-zero ones. */
  counts: Array<{ kind: "running" | "pending" | "done"; n: number }>;
  rows: TaskBoardRow[];
}

/**
 * What the task section shows: counts, then running tasks, then pending ones
 * up to the row limit. Done tasks are only counted. Shared by the widget and
 * by the plain text other apps see in task tool results.
 */
export function taskBoard(tasks: readonly Task[], maxRows = TASK_ROWS): TaskBoard {
  const running = tasks.filter((task) => task.status === "in_progress");
  const pending = tasks.filter((task) => task.status === "pending");
  const done = tasks.length - running.length - pending.length;
  const counts = ([["running", running.length], ["pending", pending.length], ["done", done]] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => ({ kind, n }));
  const open = [...running, ...pending];
  const fits = open.length <= maxRows ? open.length : Math.max(0, maxRows - 1);
  const rows: TaskBoardRow[] = open.slice(0, fits).map((task) => ({
    kind: task.status === "in_progress" ? "running" : "pending",
    text: `#${task.id} ${task.status === "in_progress" ? task.activeForm || task.subject : task.subject}`,
    task,
  }));
  const hidden = open.slice(fits);
  if (hidden.length) {
    const hiddenRunning = hidden.filter((task) => task.status === "in_progress").length;
    const hiddenPending = hidden.length - hiddenRunning;
    const parts = [hiddenRunning ? `${hiddenRunning} running` : "", hiddenPending ? `${hiddenPending} pending` : ""].filter(Boolean);
    rows.push({ kind: "more", text: `… ${parts.join(", ")} more` });
  }
  return { counts, rows };
}

export const TASK_GLYPH = { running: "◐", pending: "○" } as const;

/** The board as plain text, for apps that show tool results but not pi-pi's widget. */
export function taskBoardText(tasks: readonly Task[]): string {
  if (!tasks.length) return "Tasks • none";
  const board = taskBoard(tasks);
  const header = ["Tasks", ...board.counts.map((count) => `${count.n} ${count.kind}`)].join(" • ");
  const rows = board.rows.map((row) => (row.kind === "more" ? `  ${row.text}` : `  ${TASK_GLYPH[row.kind]} ${row.text}`));
  return [header, ...rows].join("\n");
}
