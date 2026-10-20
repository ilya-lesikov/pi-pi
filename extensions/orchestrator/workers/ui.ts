import { Input, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Orchestrator } from "../orchestrator.js";
import { formatDuration, WORKER_MESSAGE_TYPE, type WorkerMessageDetails } from "./delivery.js";
import type { WorkerManager } from "./manager.js";
import { ACTIVE_STATUSES, type WorkerRecord } from "./types.js";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// The host caps only plain string widgets; a component one is composited whole,
// so on a short terminal it would push the editor off screen. Shared in spirit
// with the task widget, which takes the same share.
const MAX_ROWS_FRACTION = 0.3;
// A worker that finished well shows briefly; one that failed stays until opened.
const FINISHED_VISIBLE_MS = 10_000;
const WORKER_ROWS = 3;
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "killed"]);

/**
 * The always-visible worker panel above the editor, the transcript viewer the
 * /pp menu opens, and the renderer for worker updates in the transcript.
 */
export function registerWorkerUi(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  pi.registerMessageRenderer<WorkerMessageDetails>(WORKER_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    if (!details?.items?.length) return undefined;
    return new Text(details.items.map((item) => renderItem(item, expanded, theme as Theme)).join("\n"), 0, 0);
  });
  const widget = new WorkerWidget(orchestrator);
  orchestrator.workerWidget = widget;
  pi.on("session_shutdown", async () => {
    widget.detach();
    resetScreens();
  });
  // A question from the agent or another extension: worker screens step
  // aside while it is open.
  const on = pi.on.bind(pi) as (event: string, handler: (event: any) => void) => void;
  // pi reports one top-level dialog at a time, start and end each in a
  // microtask of their own, so they can arrive swapped; a balance settles
  // either way. The /pp viewer is such a dialog itself (and nothing else is
  // reported while it is open), so only screens opened with ctrl+n follow it.
  on("ui_prompt_start", () => setPromptBalance(promptBalance + 1));
  on("ui_prompt_end", () => setPromptBalance(promptBalance - 1));
  // A dialog nested inside another (the agent asking while /pp is open) is
  // not reported at all: the agent's own questions are caught by their tools.
  on("tool_execution_start", (event) => {
    if (event?.toolName !== "ask_user" && event?.toolName !== "confirm") return;
    questionTools.add(String(event.toolCallId));
    refreshScreens();
  });
  on("tool_execution_end", (event) => {
    if (questionTools.delete(String(event?.toolCallId))) refreshScreens();
  });
  on("session_start", () => resetScreens());
  pi.registerShortcut?.("ctrl+n", {
    description: "Select a worker: see its output, message, interrupt, stop or kill it",
    handler: async (ctx: any) => {
      if (ctx?.mode !== undefined && ctx.mode !== "tui") return;
      await openWorkerPicker(orchestrator, ctx);
    },
  });
}

function renderItem(item: WorkerMessageDetails["items"][number], expanded: boolean, theme: Theme): string {
  const name = `${theme.bold(item.type)} ${theme.fg("muted", item.description)}`;
  if (item.kind === "question") {
    const head = `${theme.fg("warning", "?")} ${name} ${theme.fg("warning", "asks:")} ${item.question ?? ""}`;
    return head;
  }
  if (item.kind === "stall") {
    return `${theme.fg("warning", "…")} ${name} ${theme.fg("warning", `silent ${formatDuration(item.silentMs ?? 0)}`)}`;
  }
  const ok = item.status === "completed";
  const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const stats = [formatDuration(item.durationMs ?? 0), `${item.toolUses} tools`];
  if (item.findings !== undefined) stats.push(`${item.findings} findings${item.seriousFindings ? ` (${item.seriousFindings} critical/major)` : ""}`);
  let line = `${icon} ${name} ${theme.fg("dim", `${ok ? "" : `${item.status} · `}${stats.join(" · ")}`)}`;
  const body = item.error && !ok ? item.error : item.summary;
  if (body) {
    const text = expanded ? body : body.split("\n")[0]!.slice(0, 120);
    line += `\n  ${theme.fg(item.error && !ok ? "error" : "dim", `⎿  ${text}`)}`;
  }
  return line;
}

export class WorkerWidget {
  private ui: any = null;
  private tui: TUI | null = null;
  private registered = false;
  private suspended = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private unsubscribe: (() => void) | null = null;
  private manager: WorkerManager | null = null;
  private readonly seen = new Map<string, number | undefined>();

  constructor(private readonly orchestrator: Orchestrator) {}

  attach(ctx: any): void {
    this.ui = ctx?.hasUI === false ? null : ctx?.ui ?? null;
    this.follow();
  }

  /** Re-binds to the current session's manager; called whenever it is replaced. */
  follow(): void {
    const manager = this.orchestrator.workers;
    if (manager === this.manager) return;
    this.unsubscribe?.();
    this.manager = manager;
    this.unsubscribe = manager?.subscribe(() => this.update()) ?? null;
    this.update();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.manager = null;
    this.stopTimer();
    if (this.registered) this.ui?.setWidget?.("workers", undefined);
    this.ui?.setStatus?.("workers", undefined);
    this.registered = false;
    this.tui = null;
  }

  suspend(): void {
    this.suspended = true;
    this.stopTimer();
    if (this.registered) this.ui?.setWidget?.("workers", undefined);
    this.registered = false;
    this.tui = null;
  }

  resume(): void {
    this.suspended = false;
    this.update();
  }

  /** Adds the panel again, so it stacks below a widget that was just added. */
  restack(): void {
    if (!this.registered || this.suspended) return;
    this.ui?.setWidget?.("workers", undefined);
    this.registered = false;
    this.tui = null;
    this.update();
  }

  update(): void {
    if (!this.ui || this.suspended) return;
    const visible = this.visibleRecords();
    if (!visible.length) {
      this.stopTimer();
      if (this.registered) this.ui.setWidget?.("workers", undefined);
      this.ui.setStatus?.("workers", undefined);
      this.registered = false;
      this.tui = null;
      return;
    }
    const active = visible.filter((record) => ACTIVE_STATUSES.has(record.status)).length;
    const asking = visible.filter((record) => record.question).length;
    // For apps that show a status line but not this panel (MonoCode); pi-pi's own footer leaves it out.
    this.ui.setStatus?.("workers", active ? `${active} worker${active === 1 ? "" : "s"}${asking ? ` • ${asking} waiting on you` : ""}` : undefined);
    if (active && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        if (!this.visibleRecords().length) this.update();
        else this.tui?.requestRender();
      }, 200);
      this.timer.unref?.();
    } else if (!active) {
      this.stopTimer();
      this.scheduleExpiry(visible);
    }
    if (!this.registered) {
      this.ui.setWidget?.("workers", (tui: TUI, theme: Theme) => {
        this.tui = tui;
        return { render: (width: number) => this.render(width, tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  /** With nothing running there is no animation tick; a finished worker still has to leave on time. */
  private scheduleExpiry(visible: readonly WorkerRecord[]): void {
    const now = Date.now();
    const due = visible
      .filter((record) => !FAILED_STATUSES.has(record.status) && record.settledAt)
      .map((record) => record.settledAt! + FINISHED_VISIBLE_MS - now);
    if (!due.length) return;
    this.expiry = setTimeout(() => {
      this.expiry = null;
      this.update();
    }, Math.max(0, Math.min(...due)) + 50);
    this.expiry.unref?.();
  }

  visibleRecords(): WorkerRecord[] {
    const now = Date.now();
    for (const id of this.seen.keys()) if (!this.orchestrator.workers?.get(id)) this.seen.delete(id);
    return (this.orchestrator.workers?.list() ?? []).filter((record) =>
      ACTIVE_STATUSES.has(record.status)
      || (FAILED_STATUSES.has(record.status) && this.seen.get(record.id) !== record.settledAt)
      || now - (record.settledAt ?? 0) < FINISHED_VISIBLE_MS);
  }

  /**
   * A failed worker stays on the panel until the user has opened it. What is
   * acknowledged is that failure: opening a worker before it fails, or a
   * later run failing again, does not hide anything.
   */
  markSeen(id: string): void {
    const record = this.orchestrator.workers?.get(id);
    if (!record || !FAILED_STATUSES.has(record.status)) return;
    this.seen.set(id, record.settledAt);
    this.update();
  }

  private render(width: number, tui: TUI, theme: Theme): string[] {
    const records = this.visibleRecords().sort(order);
    if (!records.length) return [];
    const rows = tui?.terminal?.rows;
    // Header plus two rows per worker, and one for what does not fit.
    const share = typeof rows === "number" && rows > 0 ? Math.floor(rows * MAX_ROWS_FRACTION) : 1 + WORKER_ROWS * 2 + 1;
    const fit = Math.max(1, Math.min(WORKER_ROWS, Math.floor((share - 2) / 2)));
    const now = Date.now();
    const sep = theme.fg("dim", " • ");
    const lines = [workerHeader(records, theme, sep)];
    const shown = records.length <= fit ? records : records.slice(0, fit);
    for (const record of shown) lines.push(...recordLines(record, now, this.frame, theme, sep));
    const hidden = records.slice(shown.length);
    if (hidden.length) lines.push(`  ${theme.fg("dim", `… ${hiddenSummary(hidden)}`)}`);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

type WorkerState = "asking" | "silent" | "failed" | "running" | "pending" | "stopped" | "done";

function stateOf(record: WorkerRecord): WorkerState {
  if (record.question) return "asking";
  if (record.status === "queued") return "pending";
  if (record.status === "running") return record.stallWarned ? "silent" : "running";
  if (FAILED_STATUSES.has(record.status)) return "failed";
  if (record.status === "stopped") return "stopped";
  return "done";
}

const STATE_ORDER: WorkerState[] = ["asking", "silent", "failed", "running", "pending", "stopped", "done"];
const STATE_COLOR: Record<WorkerState, string> = { asking: "warning", silent: "error", failed: "error", running: "accent", pending: "muted", stopped: "dim", done: "dim" };

function workerHeader(records: readonly WorkerRecord[], theme: Theme, sep: string): string {
  const counts = new Map<WorkerState, number>();
  for (const record of records) counts.set(stateOf(record), (counts.get(stateOf(record)) ?? 0) + 1);
  const parts = STATE_ORDER.filter((state) => counts.get(state)).map((state) => theme.fg(STATE_COLOR[state], `${counts.get(state)} ${state}`));
  return `${[theme.bold("Workers"), ...parts].join(sep)}   ${theme.fg("dim", "ctrl+n")}`;
}

function hiddenSummary(hidden: readonly WorkerRecord[]): string {
  const counts = new Map<WorkerState, number>();
  for (const record of hidden) counts.set(stateOf(record), (counts.get(stateOf(record)) ?? 0) + 1);
  return STATE_ORDER.filter((state) => counts.get(state)).map((state, i) => `${counts.get(state)}${i === 0 ? " more" : ""} ${state}`).join(", ");
}

function order(a: WorkerRecord, b: WorkerRecord): number {
  return STATE_ORDER.indexOf(stateOf(a)) - STATE_ORDER.indexOf(stateOf(b)) || a.createdAt - b.createdAt;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function recordLines(record: WorkerRecord, now: number, frame: number, theme: Theme, sep: string): string[] {
  const state = stateOf(record);
  const glyph = {
    asking: theme.fg("warning", "?"),
    silent: theme.fg("error", "!"),
    failed: theme.fg("error", "✗"),
    running: theme.fg("accent", SPINNER[frame % SPINNER.length]!),
    pending: theme.fg("dim", "○"),
    stopped: theme.fg("dim", "■"),
    done: theme.fg("success", "✓"),
  }[state];
  const name = `${record.spec.type}${theme.fg("dim", ":")} ${record.spec.description}`;
  if (state === "pending") return [`  ${glyph} ${theme.fg("dim", `${record.spec.type}: ${record.spec.description} • queued`)}`];
  const elapsed = formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt));
  const tokens = record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite;
  const stats = [elapsed, ...(tokens ? [formatTokens(tokens)] : [])].map((part) => theme.fg("dim", part)).join(sep);
  const first = `  ${glyph} ${name}${sep}${stats}`;
  if (state === "done" || state === "stopped") return [first];
  if (state === "failed") {
    const reason = record.error ? `${record.status}: ${record.error.replace(/\s+/g, " ")}` : record.status;
    return [`${first}${sep}${theme.fg("error", reason)}`];
  }
  if (state === "asking") return [first, `    ${theme.fg("warning", `⎿ asks: ${record.question!.text.replace(/\s+/g, " ")}`)}`];
  if (state === "silent") {
    const where = record.step ? ` in ${record.step.label.replace(/^running /, "")}` : "";
    return [first, `    ${theme.fg("error", `⎿ silent ${formatDuration(now - record.lastEventAt)}${where}`)}`];
  }
  const activity = record.progress || record.step?.label || (record.lastText ? lastLine(record.lastText) : "thinking");
  return [first, `    ${theme.fg("dim", `⎿ ${activity}`)}`];
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim());
  return (lines.at(-1) ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Full-screen live transcript of one worker, with the controls a user needs
 * when the parent is busy: steer, answer, interrupt the current tool, stop, kill.
 */
export class WorkerViewer implements Component {
  private scroll = 0;
  private follow = true;
  private composer: { input: Input; mode: "steer" | "answer" } | null = null;
  private armed: "stop" | "kill" | null = null;
  private notice = "";
  private lastWidth = 80;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly manager: WorkerManager,
    private readonly id: string,
    private readonly done: () => void,
  ) {
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    this.timer.unref?.();
  }

  private get record(): WorkerRecord | undefined {
    return this.manager.get(this.id);
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const record = this.record;
    const active = !!record && ACTIVE_STATUSES.has(record.status);
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.dispose();
      this.done();
      return;
    }
    if (matchesKey(data, "enter") && record) {
      this.openComposer(record.question ? "answer" : "steer");
      return;
    }
    if (matchesKey(data, "a") && record?.question) {
      this.openComposer("answer");
      return;
    }
    if (matchesKey(data, "i") && active) {
      this.notice = this.manager.interruptTool(this.id) ? "Interrupted the current tool call." : "No tool call in progress.";
      this.armed = null;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "x") && active) {
      if (this.armed === "stop") {
        this.manager.stop(this.id);
        this.notice = "Asked to wrap up; killed in a minute if it does not.";
        this.armed = null;
      } else {
        this.armed = "stop";
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+k") && active) {
      if (this.armed === "kill") {
        this.manager.kill(this.id);
        this.notice = "Killed.";
        this.armed = null;
      } else {
        this.armed = "kill";
      }
      this.tui.requestRender();
      return;
    }
    this.armed = null;
    const total = this.content(this.lastWidth).length;
    const view = this.viewport();
    const max = Math.max(0, total - view);
    if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down")) this.scroll = Math.min(max, this.scroll + 1);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - view);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(max, this.scroll + view);
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = max;
    else return;
    this.follow = this.scroll >= max;
    this.tui.requestRender();
  }

  private openComposer(mode: "steer" | "answer"): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const text = value.trim();
      this.composer = null;
      if (text) {
        const outcome = this.manager.send(this.id, text);
        this.notice = outcome === "answered" ? "Answer sent." : outcome === "steered" ? "Steer sent." : outcome === "resumed" ? "Resumed with your message." : outcome === "queued" ? "Added to its task." : "It can no longer take messages.";
      }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = null;
      this.tui.requestRender();
    };
    this.composer = { input, mode };
    this.tui.requestRender();
  }

  private viewport(): number {
    return Math.max(3, (this.tui.terminal?.rows ?? 30) - 6 - (this.record?.question ? 1 : 0));
  }

  render(width: number): string[] {
    if (width < 10) return [];
    const th = this.theme;
    const inner = width - 4;
    this.lastWidth = inner;
    const pad = (text: string) => text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
    const row = (text: string) => `${th.fg("border", "│")} ${truncateToWidth(pad(text), inner)} ${th.fg("border", "│")}`;
    const record = this.record;
    const lines = [th.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    if (!record) {
      lines.push(row("This worker is no longer retained."), row(th.fg("dim", "Esc close")), th.fg("border", `╰${"─".repeat(width - 2)}╯`));
      return lines;
    }
    const now = Date.now();
    lines.push(row(`${th.bold(record.spec.type)} ${th.fg("muted", record.spec.description)} ${th.fg("dim", `· ${record.status} · ${formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt))} · ${record.toolUses} tools · ${record.modelId} · ${record.id}`)}`));
    if (record.question) lines.push(row(th.fg("warning", `? ${record.question.text.replace(/\s+/g, " ")}`)));
    lines.push(row(th.fg("dim", "─".repeat(inner))));
    const content = this.content(inner);
    const view = this.viewport();
    const max = Math.max(0, content.length - view);
    if (this.follow) this.scroll = max;
    const start = Math.min(this.scroll, max);
    for (let i = 0; i < view; i++) lines.push(row(content[start + i] ?? ""));
    lines.push(row(th.fg("dim", "─".repeat(inner))));
    if (this.composer) {
      lines.push(row(`${th.fg("accent", this.composer.mode === "answer" ? "answer ›" : "steer ›")} ${this.composer.input.render(inner - 9)[0] ?? ""}`));
    } else {
      const active = ACTIVE_STATUSES.has(record.status);
      const keys = [
        record.question ? "Enter answer" : active ? "Enter steer" : "Enter follow-up",
        ...(active ? ["i interrupt tool", this.armed === "stop" ? th.fg("warning", "x again to STOP") : "x stop", this.armed === "kill" ? th.fg("error", "K again to KILL") : "K kill"] : []),
        "↑↓ PgUp/PgDn scroll",
        "Esc close",
      ];
      lines.push(row(this.notice ? `${th.fg("accent", this.notice)}  ${th.fg("dim", keys.join(" · "))}` : th.fg("dim", keys.join(" · "))));
    }
    lines.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  private content(width: number): string[] {
    const th = this.theme;
    const record = this.record;
    if (!record) return [];
    const session = this.manager.sessionOf(this.id);
    const messages = (session?.transcript() ?? []) as any[];
    const out: string[] = [];
    const push = (label: string, text: string, color?: string) => {
      if (!text.trim()) return;
      if (out.length) out.push(th.fg("dim", "───"));
      out.push(label);
      for (const line of wrapTextWithAnsi(text.trim(), width)) out.push(color ? th.fg(color, line) : line);
    };
    for (const message of messages) {
      if (message.role === "user") push(th.fg("accent", "[Task]"), textOf(message.content));
      else if (message.role === "custom") push(th.fg("accent", "[Message]"), textOf(message.content));
      else if (message.role === "assistant") {
        const text = textOf(message.content);
        const calls = (message.content ?? []).filter((part: any) => part.type === "toolCall").map((part: any) => `  [${part.name}] ${summarize(part.arguments)}`);
        if (out.length) out.push(th.fg("dim", "───"));
        out.push(th.bold("[Worker]"));
        if (text.trim()) out.push(...wrapTextWithAnsi(text.trim(), width));
        for (const call of calls) out.push(truncateToWidth(th.fg("muted", call), width));
      } else if (message.role === "toolResult") {
        const text = textOf(message.content);
        push(th.fg("dim", "[Result]"), text.length > 600 ? `${text.slice(0, 600)}… (truncated)` : text, "dim");
      }
    }
    if (!messages.length) out.push(th.fg("dim", record.status === "queued" ? "(queued)" : "(no transcript retained)"));
    if (record.status === "running" && record.step) out.push("", th.fg("accent", `▍ ${record.step.label} (${formatDuration(Date.now() - record.step.since)})`));
    if (record.result && !ACTIVE_STATUSES.has(record.status)) push(th.fg("success", `[Result: ${record.result.status}]`), [record.result.summary, record.result.body !== record.result.summary ? record.result.body : ""].filter(Boolean).join("\n\n"));
    if (record.error) push(th.fg("error", "[Error]"), record.error, "error");
    return out.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
}

function summarize(args: any): string {
  if (!args || typeof args !== "object") return "";
  const value = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.operation;
  const text = typeof value === "string" ? value : JSON.stringify(args);
  return text.replace(/\s+/g, " ").slice(0, 120);
}

/** A worker's transcript as plain text, for hosts without the live viewer; the newest part when long. */
export function workerTranscriptText(manager: WorkerManager, id: string, maxChars = 6000): string {
  const record = manager.get(id);
  if (!record) return "This worker is no longer retained.";
  const now = Date.now();
  const head = `${record.spec.type} · ${record.spec.description} · ${record.status} · ${formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt))} · ${record.toolUses} tools`;
  const out: string[] = [];
  for (const message of (manager.sessionOf(id)?.transcript() ?? []) as any[]) {
    if (message.role === "user") out.push(`[Task] ${textOf(message.content).trim()}`);
    else if (message.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) out.push(text);
      for (const part of message.content ?? []) if (part?.type === "toolCall") out.push(`  ▸ ${part.name} ${summarize(part.arguments)}`);
    }
  }
  if (record.question) out.push(`? waiting on you: ${record.question.text}`);
  if (record.status === "running" && record.step) out.push(`▍ ${record.step.label} (${formatDuration(now - record.step.since)})`);
  if (record.result && !ACTIVE_STATUSES.has(record.status)) out.push(`[Result: ${record.result.status}] ${record.result.summary}`);
  if (record.error) out.push(`[Error] ${record.error}`);
  let body = out.join("\n") || (record.status === "queued" ? "(queued)" : "(no transcript retained)");
  if (body.length > maxChars) body = `… earlier messages omitted\n${body.slice(body.length - maxChars)}`;
  return `${head}\n\n${body}`;
}

/** Opens the full-screen viewer for one worker; the panel is parked meanwhile so the overlay does not tear. */
export async function openWorkerViewer(orchestrator: Orchestrator, ctx: any, id: string, fromPicker = false): Promise<void> {
  const manager = orchestrator.workers;
  if (!manager?.get(id) || typeof ctx?.ui?.custom !== "function") return;
  orchestrator.workerWidget?.markSeen(id);
  // From the picker the panel is already suspended, and the picker resumes it.
  if (!fromPicker) orchestrator.workerWidget?.suspend();
  let untrack = () => {};
  try {
    await ctx.ui.custom((tui: TUI, theme: Theme, _keys: unknown, done: (value: undefined) => void) =>
      new WorkerViewer(tui, theme, manager, id, () => done(undefined)), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
      // Full screen, it would hide a question: it steps aside while one is open.
      onHandle: (handle: any) => { untrack = trackScreen(handle, fromPicker); },
    });
  } finally {
    untrack();
    // It may have failed while the transcript was open: that failure was seen.
    orchestrator.workerWidget?.markSeen(id);
    if (!fromPicker) orchestrator.workerWidget?.resume();
  }
}

/**
 * ctrl+n: the worker panel, selectable, over the bottom of the screen. Arrow
 * keys pick a worker; single keys act on it; Esc gives the editor back with
 * the draft untouched.
 */
export class WorkerPicker implements Component {
  /** The selected worker, by id: the list re-sorts as workers change state. */
  private selectedId: string | null = null;
  private composer: { input: Input; id: string } | null = null;
  private armedId: string | null = null;
  private notice = "";
  private readonly timer: ReturnType<typeof setInterval>;
  private frame = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly widget: WorkerWidget,
    private readonly manager: WorkerManager,
    private readonly open: (id: string) => Promise<void>,
    private readonly done: () => void,
  ) {
    this.timer = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, 200);
    this.timer.unref?.();
  }

  private records(): WorkerRecord[] {
    return this.widget.visibleRecords().sort(order);
  }

  private selected(records = this.records()): WorkerRecord | undefined {
    const current = records.find((record) => record.id === this.selectedId) ?? records[0];
    this.selectedId = current?.id ?? null;
    return current;
  }

  private close(): void {
    clearInterval(this.timer);
    this.done();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const records = this.records();
    const record = this.selected(records);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+n") || !record) {
      this.close();
      return;
    }
    const active = ACTIVE_STATUSES.has(record.status);
    const armed = this.armedId === record.id;
    this.armedId = null;
    const at = records.indexOf(record);
    if (matchesKey(data, "up")) this.selectedId = records[Math.max(0, at - 1)]!.id;
    else if (matchesKey(data, "down")) this.selectedId = records[Math.min(records.length - 1, at + 1)]!.id;
    else if (matchesKey(data, "enter")) {
      clearInterval(this.timer);
      void this.open(record.id).finally(() => this.done());
      return;
    } else if (matchesKey(data, "m")) {
      this.openComposer(record);
    } else if (matchesKey(data, "i") && active) {
      this.notice = this.manager.interruptTool(record.id) ? "Interrupted the current tool call." : "No tool call in progress.";
    } else if (matchesKey(data, "s") && active) {
      this.manager.stop(record.id);
      this.notice = `Asked ${record.spec.type} to wrap up; killed in a minute if it does not.`;
    } else if (matchesKey(data, "k") && active) {
      if (armed) {
        this.manager.kill(record.id);
        this.notice = `Killed ${record.spec.type}.`;
      } else {
        this.armedId = record.id;
        this.notice = `Press k again to kill ${record.spec.type}.`;
      }
    } else return;
    this.tui.requestRender();
  }

  private openComposer(record: WorkerRecord): void {
    const input = new Input();
    input.focused = true;
    const id = record.id;
    input.onSubmit = (value: string) => {
      const text = value.trim();
      this.composer = null;
      if (text) {
        const outcome = this.manager.send(id, text);
        this.notice = outcome === "answered" ? "Answer sent." : outcome === "steered" ? "Message sent." : outcome === "resumed" ? "Resumed with your message." : outcome === "queued" ? "Added to its task." : "It can no longer take messages.";
      }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = null;
      this.tui.requestRender();
    };
    this.composer = { input, id };
  }

  render(width: number): string[] {
    const th = this.theme;
    const records = this.records();
    const selected = this.selected(records);
    if (!records.length || !selected) return [truncateToWidth(th.fg("dim", "No workers. Esc to go back."), width)];
    const sep = th.fg("dim", " • ");
    const now = Date.now();
    const header = truncateToWidth(workerHeader(records, th, sep).replace(/\s+\S*ctrl\+n\S*$/, ""), width);
    const footer: string[] = [];
    if (this.composer) {
      const target = this.manager.get(this.composer.id);
      const label = target?.question ? `Answer ${target.spec.type}: ` : `Message ${target?.spec.type ?? "worker"}: `;
      footer.push(truncateToWidth(`${th.fg("accent", label)}${this.composer.input.render(Math.max(1, width - visibleWidth(label)))[0] ?? ""}`, width));
      footer.push(truncateToWidth(th.fg("dim", "  enter send · esc cancel"), width));
    } else {
      if (this.notice) footer.push(truncateToWidth(th.fg("warning", `  ${this.notice}`), width));
      const answer = selected.question ? "m answer" : "m message";
      const actions = ACTIVE_STATUSES.has(selected.status) ? [answer, "i interrupt", "s stop", "k kill"] : [answer];
      footer.push(truncateToWidth(th.fg("dim", `  ↑↓ select · enter output · ${actions.join(" · ")} · esc back`), width));
    }
    // A long list scrolls to keep the selected worker in view; the picker,
    // markers included, stays within its share of the terminal as it resizes.
    const blocks = records.map((record) => {
      const lines = recordLines(record, now, this.frame, th, sep);
      const mark = record === selected ? th.fg("accent", "▌") : " ";
      return lines.map((line, i) => truncateToWidth(`${i === 0 || record === selected ? mark : " "}${line.slice(1)}`, width));
    });
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    const height = pickerHeight(rowsOf(this.tui));
    let room = Math.max(2, height - 1 - footer.length);
    // The "N more" markers only when there is a row for them beside the selection.
    const markers = total > room && room - 2 >= 2;
    if (markers) room -= 2;
    const at = records.indexOf(selected);
    let first = at;
    let used = blocks[at]!.length;
    while (first > 0 && used + blocks[first - 1]!.length <= room) used += blocks[--first]!.length;
    let last = at;
    while (last < blocks.length - 1 && used + blocks[last + 1]!.length <= room) used += blocks[++last]!.length;
    const body = blocks.slice(first, last + 1).flat();
    if (markers && first > 0) body.unshift(truncateToWidth(th.fg("dim", `  ↑ ${first} more`), width));
    if (markers && last < blocks.length - 1) body.push(truncateToWidth(th.fg("dim", `  ↓ ${blocks.length - 1 - last} more`), width));
    // On a terminal too short for all of it, the header goes first: the keys stay.
    const lines = [header, ...body, ...footer];
    return lines.length > height ? lines.slice(lines.length - height) : lines;
  }

  invalidate(): void {}
}

/** Rows the picker may take. */
function pickerHeight(rows: number): number {
  return Math.min(rows, Math.max(8, Math.floor(rows * 0.6)));
}

function rowsOf(tui: TUI | null): number {
  return tui?.terminal?.rows ?? process.stdout.rows ?? 30;
}

/**
 * The worker screens on screen now, by their overlay handles. A question
 * opened meanwhile takes the keyboard but would sit under them, so they step
 * aside until it is answered. Hiding goes by handle: pi closes overlays by
 * removing the topmost one, which by then may be the question itself.
 */
type OverlayHandle = { setHidden(hidden: boolean): void };
/** Screen → whether reported dialogs hide it (only those opened with ctrl+n). */
const screens = new Map<OverlayHandle, { followsPrompts: boolean; hidden: boolean }>();
let promptBalance = 0;
const questionTools = new Set<string>();

function shouldHide(followsPrompts: boolean): boolean {
  return questionTools.size > 0 || (followsPrompts && promptBalance > 0);
}

function refreshScreens(): void {
  for (const [handle, state] of screens) {
    const hide = shouldHide(state.followsPrompts);
    if (hide === state.hidden) continue;
    state.hidden = hide;
    handle.setHidden(hide);
  }
}

function setPromptBalance(next: number): void {
  promptBalance = next;
  refreshScreens();
}

function resetScreens(): void {
  promptBalance = 0;
  questionTools.clear();
  refreshScreens();
}

function trackScreen(handle: OverlayHandle, followsPrompts: boolean): () => void {
  const state = { followsPrompts, hidden: false };
  screens.set(handle, state);
  refreshScreens();
  return () => screens.delete(handle);
}

/** Opens the picker over the bottom of the screen; its Enter opens the full viewer. */
export async function openWorkerPicker(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const manager = orchestrator.workers;
  const widget = orchestrator.workerWidget;
  if (!manager || !widget || typeof ctx?.ui?.custom !== "function") return;
  if (!widget.visibleRecords().length) {
    ctx.ui.notify?.("No workers to select.", "info");
    return;
  }
  widget.suspend();
  try {
    // An overlay, not a stand-in for the editor: a question the agent asks
    // meanwhile takes the editor's place, and would otherwise drop the picker
    // with its promise never settling.
    let untrack = () => {};
    try {
      await ctx.ui.custom((tui: TUI, theme: Theme, _keys: unknown, done: (value: undefined) => void) =>
        new WorkerPicker(tui, theme, widget, manager, (id) => openWorkerViewer(orchestrator, ctx, id, true), () => done(undefined)), {
        overlay: true,
        // No height cap here: pi fixes it when the overlay opens, while the
        // picker sizes itself to the terminal it is drawn on.
        overlayOptions: { anchor: "bottom-center", width: "100%", margin: 0 },
        onHandle: (handle: any) => { untrack = trackScreen(handle, true); },
      });
    } finally {
      untrack();
    }
  } finally {
    widget.resume();
  }
}
