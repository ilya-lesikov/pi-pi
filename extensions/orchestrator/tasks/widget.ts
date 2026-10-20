import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { formatDuration } from "../workers/delivery.js";
import { TASK_GLYPH, TASK_ROWS, taskBoard } from "./board.js";
import type { Task, TaskSnapshot } from "./state.js";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

type WidgetUi = {
  setWidget(key: string, content: undefined | ((tui: TUI, theme: Theme) => { render(width: number): string[]; invalidate(): void }), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
};

const WIDGET_KEY = "tasks";
// A callback widget is composited whole, so an unbounded one on a short
// terminal pushes the editor and footer out of the area pi-tui renders
// differentially against, and it keeps painting onto rows that scrolled away.
const MAX_ROWS_FRACTION = 0.3;
const TICK_MS = 1000;

export class TaskWidget {
  private ui: WidgetUi | null = null;
  private registered = false;
  private tui: TUI | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly snapshot: () => TaskSnapshot) {}

  attach(ctx: any): void {
    if (this.ui !== (ctx?.hasUI === false ? null : ctx?.ui ?? null)) this.detach();
    this.ui = ctx?.hasUI === false ? null : ctx?.ui ?? null;
    this.update();
  }

  detach(): void {
    this.stopTimer();
    if (this.registered) this.ui?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = null;
  }

  update(): void {
    if (!this.ui) return;
    const tasks = this.snapshot().tasks;
    if (!tasks.some((task) => task.status !== "completed")) {
      this.detach();
      return;
    }
    if (tasks.some((task) => task.status === "in_progress")) this.startTimer();
    else this.stopTimer();
    if (!this.registered) {
      this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return { render: (width) => renderTasks(this.snapshot().tasks, width, tui?.terminal?.rows, theme, Date.now()), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tui?.requestRender(), TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function renderTasks(tasks: readonly Task[], width: number, rows: number | undefined, theme: Theme, now: number): string[] {
  // Done tasks are only counted: with nothing running or pending there is nothing to show.
  if (!tasks.some((task) => task.status !== "completed")) return [];
  // The header plus at most five task rows, fewer on a short terminal.
  const share = typeof rows === "number" && rows > 0 ? Math.floor(rows * MAX_ROWS_FRACTION) - 1 : TASK_ROWS;
  const board = taskBoard(tasks, Math.max(1, Math.min(TASK_ROWS, share)));
  const sep = theme.fg("dim", " • ");
  const counts = board.counts.map((count) => {
    const text = `${count.n} ${count.kind}`;
    return count.kind === "running" ? theme.fg("accent", text) : count.kind === "done" ? theme.fg("dim", text) : text;
  });
  const lines = [[theme.bold("Tasks"), ...counts].join(sep)];
  for (const row of board.rows) {
    if (row.kind === "more") {
      lines.push(`  ${theme.fg("dim", row.text)}`);
      continue;
    }
    if (row.kind === "pending") {
      lines.push(`  ${theme.fg("dim", TASK_GLYPH.pending)} ${row.text}`);
      continue;
    }
    const elapsed = row.task?.startedAt ? `${sep}${theme.fg("dim", formatDuration(now - row.task.startedAt))}` : "";
    lines.push(`  ${theme.fg("accent", TASK_GLYPH.running)} ${row.text}${elapsed}`);
  }
  return lines.map((line) => truncateToWidth(line, width));
}
