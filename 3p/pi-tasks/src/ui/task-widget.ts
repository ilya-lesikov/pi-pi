/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

import type { Task } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): { visible: Task[]; hiddenAbove: number; hiddenBelow: number } {
  const visible = tasks.slice(-limit);
  return { visible, hiddenAbove: tasks.length - visible.length, hiddenBelow: 0 };
}

// Scroll the window down past leading completed tasks so at least one
// non-completed task is visible; when everything is completed, show the tail.
function truncateScrolled(tasks: Task[], limit: number): { visible: Task[]; hiddenAbove: number; hiddenBelow: number } {
  const firstOpen = tasks.findIndex((t) => t.status !== "completed");
  const anchor = firstOpen === -1 ? tasks.length : firstOpen;
  const start = Math.max(0, Math.min(anchor, tasks.length - limit));
  const visible = tasks.slice(start, start + limit);
  return { visible, hiddenAbove: start, hiddenBelow: tasks.length - start - visible.length };
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateScrolled };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    // LOCAL PATCH (pi-pi): never claim more than a share of the terminal. The
    // host caps a widget only when it is a plain string array; a callback widget
    // like this one is composited whole, so on a short terminal it can push the
    // editor and the footer out of the visible area — and pi-tui, which renders
    // differentially against what it believes is on screen, then keeps writing
    // frames to rows that scrolled away.
    const rows = tui?.terminal?.rows;
    const rowBudget = typeof rows === "number" && rows > 0
      ? Math.max(3, Math.floor(rows * 0.3))
      : Number.POSITIVE_INFINITY;

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const showAll = this.config.showAll ?? false;
    // The budget covers the heading and both truncation markers.
    const limit = Math.max(1, Math.min(this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS, rowBudget - 3));
    const hiddenAt = this.config.hiddenAt ?? "bottom";
    // `showAll` is an explicit "print every one of them" and is left alone.
    const { visible, hiddenAbove, hiddenBelow } = showAll
      ? { visible: tasks, hiddenAbove: 0, hiddenBelow: 0 }
      : TRUNCATE_FNS[hiddenAt](tasks, limit);

    if (hiddenAbove > 0) {
      lines.push(truncate(theme.fg("dim", `    … ${hiddenAbove} earlier`)));
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (hiddenBelow > 0) {
      lines.push(truncate(theme.fg("dim", `    … and ${hiddenBelow} more`)));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
