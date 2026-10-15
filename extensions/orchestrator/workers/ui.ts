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
const FINISHED_VISIBLE_MS = 30_000;

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
  pi.on("session_shutdown", async () => widget.detach());
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
  private frame = 0;
  private unsubscribe: (() => void) | null = null;
  private manager: WorkerManager | null = null;

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
    this.ui.setStatus?.("workers", active ? `${active} worker${active === 1 ? "" : "s"}${asking ? ` · ${asking} waiting on you` : ""}` : undefined);
    if (active && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        if (!this.visibleRecords().length) this.update();
        else this.tui?.requestRender();
      }, 200);
      this.timer.unref?.();
    } else if (!active) {
      this.stopTimer();
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
  }

  private visibleRecords(): WorkerRecord[] {
    const now = Date.now();
    return (this.orchestrator.workers?.list() ?? []).filter((record) => ACTIVE_STATUSES.has(record.status) || now - (record.settledAt ?? 0) < FINISHED_VISIBLE_MS);
  }

  private render(width: number, tui: TUI, theme: Theme): string[] {
    const records = this.visibleRecords().sort(order);
    if (!records.length) return [];
    const rows = tui?.terminal?.rows;
    const budget = typeof rows === "number" && rows > 0 ? Math.max(3, Math.floor(rows * MAX_ROWS_FRACTION)) : 12;
    const now = Date.now();
    const running = records.filter((record) => record.status === "running").length;
    const queued = records.filter((record) => record.status === "queued").length;
    const asking = records.filter((record) => record.question).length;
    const done = records.length - running - queued;
    const head = [`${running} running`, ...(queued ? [`${queued} queued`] : []), ...(asking ? [theme.fg("warning", `${asking} waiting on you`)] : []), ...(done ? [`${done} done`] : [])];
    const lines = [truncateToWidth(`${theme.fg("accent", "Workers")} ${theme.fg("dim", "·")} ${head.join(theme.fg("dim", " · "))} ${theme.fg("dim", "· /pp › Workers")}`, width)];
    for (const record of records) {
      const block = recordLines(record, now, this.frame, theme);
      if (lines.length + block.length > budget) {
        const hidden = records.length - records.indexOf(record);
        lines.push(theme.fg("dim", `  … ${hidden} more`));
        break;
      }
      lines.push(...block.map((line) => truncateToWidth(line, width)));
    }
    return lines;
  }
}

function order(a: WorkerRecord, b: WorkerRecord): number {
  const rank = (record: WorkerRecord) => record.question ? 0 : record.status === "running" ? 1 : record.status === "queued" ? 2 : 3;
  return rank(a) - rank(b) || a.createdAt - b.createdAt;
}

function recordLines(record: WorkerRecord, now: number, frame: number, theme: Theme): string[] {
  const elapsed = formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt));
  const name = `${theme.bold(record.spec.type)} ${theme.fg("muted", record.spec.description)}`;
  const stats = theme.fg("dim", `${elapsed} · ${record.toolUses} tools · ${record.id}`);
  if (record.status === "queued") return [`${theme.fg("dim", "◦")} ${name} ${theme.fg("dim", "queued")}`];
  if (record.status !== "running") {
    const ok = record.status === "completed";
    const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
    return [`${icon} ${name} ${stats}${ok ? "" : ` ${theme.fg("error", record.status)}`}`];
  }
  const silentMs = now - record.lastEventAt;
  const stalled = record.stallWarned && !record.question;
  const icon = stalled ? theme.fg("warning", "…") : theme.fg("accent", SPINNER[frame % SPINNER.length]!);
  const first = `${icon} ${name} ${stats}${stalled ? ` ${theme.fg("warning", `silent ${formatDuration(silentMs)}`)}` : ""}`;
  if (record.question) return [first, `  ${theme.fg("warning", `? asks: ${record.question.text.replace(/\s+/g, " ")}`)}`];
  const activity = record.activity
    ? `${record.activity.toolName}${record.activity.summary ? ` ${record.activity.summary}` : ""} (${formatDuration(now - record.activity.startedAt)})`
    : record.progress ?? (record.lastText ? lastLine(record.lastText) : "thinking…");
  return [first, `  ${theme.fg("dim", `⎿  ${activity}`)}`];
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim());
  return (lines.at(-1) ?? "").replace(/\s+/g, " ");
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
    if (record.status === "running" && record.activity) out.push("", th.fg("accent", `▍ ${record.activity.toolName} ${record.activity.summary} (${formatDuration(Date.now() - record.activity.startedAt)})`));
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

/** Opens the full-screen viewer for one worker; the panel is parked meanwhile so the overlay does not tear. */
export async function openWorkerViewer(orchestrator: Orchestrator, ctx: any, id: string): Promise<void> {
  const manager = orchestrator.workers;
  if (!manager?.get(id) || typeof ctx?.ui?.custom !== "function") return;
  orchestrator.workerWidget?.suspend();
  try {
    await ctx.ui.custom((tui: TUI, theme: Theme, _keys: unknown, done: (value: undefined) => void) => new WorkerViewer(tui, theme, manager, id, () => done(undefined)), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
    });
  } finally {
    orchestrator.workerWidget?.resume();
  }
}
