import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { formatDuration } from "../workers/delivery.js";
import type { Task, TaskSnapshot } from "./state.js";

type Theme = { fg(color: string, text: string): string; strikethrough(text: string): string };

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
    if (!tasks.length) {
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
  if (!tasks.length) return [];
  // Four rows is the least that shows one task between both overflow markers.
  const budget = typeof rows === "number" && rows > 0 ? Math.max(4, Math.floor(rows * MAX_ROWS_FRACTION)) : Number.POSITIVE_INFINITY;
  const done = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "in_progress").length;
  const open = tasks.length - done - active;
  const counts = [done && `${done} done`, active && `${active} in progress`, open && `${open} open`].filter(Boolean).join(", ");
  const lines = [theme.fg("accent", `● ${tasks.length} task${tasks.length === 1 ? "" : "s"} (${counts})`)];
  // Room for the heading and both overflow markers.
  const limit = Math.max(1, Math.min(tasks.length, budget - 3));
  const firstOpen = tasks.findIndex((task) => task.status !== "completed");
  const start = tasks.length <= budget - 1 ? 0 : Math.max(0, Math.min(firstOpen === -1 ? tasks.length : firstOpen, tasks.length - limit));
  const visible = tasks.length <= budget - 1 ? tasks : tasks.slice(start, start + limit);
  if (start > 0) lines.push(theme.fg("dim", `    … ${start} earlier`));
  for (const task of visible) lines.push(taskLine(task, theme, now));
  const below = tasks.length - start - visible.length;
  if (below > 0) lines.push(theme.fg("dim", `    … and ${below} more`));
  return lines.map((line) => truncateToWidth(line, width));
}

function taskLine(task: Task, theme: Theme, now: number): string {
  const id = `#${task.id}`;
  if (task.status === "completed") return `  ${theme.fg("success", "✔")} ${theme.fg("dim", theme.strikethrough(`${id} ${task.subject}`))}`;
  if (task.status === "pending") return `  ◻ ${theme.fg("dim", id)} ${task.subject}`;
  const elapsed = task.startedAt ? ` ${theme.fg("dim", `(${formatDuration(now - task.startedAt)})`)}` : "";
  return `  ${theme.fg("accent", "◼")} ${theme.fg("dim", id)} ${theme.fg("accent", `${task.activeForm || task.subject}…`)}${elapsed}`;
}
