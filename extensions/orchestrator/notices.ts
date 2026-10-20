import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { detectHost, HostProfile, PRESENTATION_TYPES } from "./host.js";
import { getLogger } from "./log.js";

export type NoticeLevel = "info" | "warning" | "error";

const GLYPH: Record<NoticeLevel, string> = { info: "ℹ", warning: "⚠", error: "✗" };
const BUFFER_LIMIT = 20;

/**
 * Gets what pi-pi has to tell the user onto a surface the host actually
 * shows. notify reaches the terminal, Paseo, Orca and ACP clients; bb drops it
 * and T3 shows it only inside a turn; T3 drops custom messages. A notice
 * therefore goes out as notify and, where that may be invisible, also as a
 * chat message the model never sees. Raised between turns on a host that
 * shows either only inside one, it waits for the next run.
 */
let host = new HostProfile("tui");

class HostChannel {
  private buffered: Array<{ message: string; level: NoticeLevel; notified: boolean }> = [];
  /** Set while a slash command the user ran is executing: the host has a turn open for it. */
  inCommand = false;
  private lastCtx: any = null;

  constructor(private readonly pi: ExtensionAPI) {}

  get host(): HostProfile {
    return host;
  }

  attach(ctx: any): void {
    this.lastCtx = ctx;
    this.buffered = [];
  }

  notice(ctx: any, message: string, level: NoticeLevel, now = false): void {
    const current = ctx ?? this.lastCtx;
    if (this.host.headless) {
      process.stderr.write(`pi-pi: ${message}\n`);
      return;
    }
    if (now) {
      try {
        current?.ui?.notify?.(message, level);
      } catch {}
      if (this.needsChatCopy()) this.chat("pp-notice", `${GLYPH[level]} ${message}`, { level });
      return;
    }
    const idle = typeof current?.isIdle !== "function" || current.isIdle();
    const notifyNow = !(idle && this.host.id === "t3" && !this.inCommand);
    if (idle && (this.host.id === "t3" || this.needsChatCopy()) && !this.buffered.some((entry) => entry.message === message)) {
      this.buffered.push({ message, level, notified: notifyNow });
      if (this.buffered.length > BUFFER_LIMIT) this.buffered.shift();
    }
    if (notifyNow) {
      try {
        current?.ui?.notify?.(message, level);
      } catch {}
    }
    if (!idle && this.needsChatCopy()) this.chat("pp-notice", `${GLYPH[level]} ${message}`, { level });
  }

  /**
   * A report the user asked for: shown now, on every surface the host may
   * show. bb drops notify, and shows a chat message only inside a turn, which
   * a slash command does not open; there an idle report goes in a read-only
   * text dialog, which bb shows with its text.
   */
  async report(ctx: any, title: string, text: string, level: NoticeLevel): Promise<void> {
    const current = ctx ?? this.lastCtx;
    if (this.host.headless) {
      process.stderr.write(`${title}\n${text}\n`);
      return;
    }
    const idle = typeof current?.isIdle !== "function" || current.isIdle();
    if (this.host.id === "bb" && idle && typeof current?.ui?.editor === "function") {
      await current.ui.editor(`${title} (read-only; closing discards edits)`.slice(0, 200), text.slice(0, 60_000));
      return;
    }
    try {
      current?.ui?.notify?.(`${title}\n${text}`, level);
    } catch {}
    if (this.host.customMessagesVisible !== false && (this.needsChatCopy() || !this.host.notifyVisible)) {
      this.chat("pp-report", `${title}\n\n${text}`, { title });
    }
  }

  /** The run started: whatever waited for one goes out inside it. */
  flush(ctx: any): void {
    if (ctx) this.lastCtx = ctx;
    const pending = this.buffered.splice(0);
    for (const { message, level, notified } of pending) {
      if (!notified) {
        try {
          this.lastCtx?.ui?.notify?.(message, level);
        } catch {}
      }
      if (this.needsChatCopy()) this.chat("pp-notice", `${GLYPH[level]} ${message}`, { level });
    }
  }

  private needsChatCopy(): boolean {
    return !this.host.tui && !this.host.headless && (!this.host.notifyVisible || this.host.customMessagesVisible === undefined);
  }

  private chat(customType: string, content: string, details: Record<string, unknown>): void {
    try {
      this.pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false });
    } catch (error: any) {
      getLogger().debug({ s: "notice", err: error?.message }, "the host refused a notice message");
    }
  }
}

let channel: HostChannel | null = null;

/**
 * Registers the channel: the filter keeping presentation messages out of the
 * model's context goes first, so every later context handler, and what the
 * continuation check replays, sees the conversation without them.
 */
export function registerNotices(pi: ExtensionAPI): void {
  channel = new HostChannel(pi);
  const self = channel;
  pi.on("context", (event: any) => {
    if (!Array.isArray(event?.messages)) return undefined;
    const kept = event.messages.filter((message: any) => !(message?.role === "custom" && PRESENTATION_TYPES.has(message.customType)));
    return kept.length === event.messages.length ? undefined : { messages: kept };
  });
  // Compaction summarizes persisted messages with its own model call, which
  // the context filter never sees; the prepared lists are what it sends.
  pi.on("session_before_compact", (event: any) => {
    for (const key of ["messagesToSummarize", "turnPrefixMessages"]) {
      const list = event?.preparation?.[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((message: any) => !(message?.role === "custom" && PRESENTATION_TYPES.has(message.customType)));
      if (kept.length !== list.length) list.splice(0, list.length, ...kept);
    }
    return undefined;
  });
  pi.on("agent_start", (_event, ctx) => self.flush(ctx));
  for (const type of ["pp-notice", "pp-report"]) {
    pi.registerMessageRenderer(type, (message, _options, theme) => {
      const content = typeof message.content === "string" ? message.content : "";
      return new Text(theme.fg("muted", content), 0, 0);
    });
  }
}

export function attachHost(ctx: any): HostProfile {
  host = detectHost(ctx?.mode);
  channel?.attach(ctx);
  return host;
}

export function currentHost(): HostProfile {
  return host;
}

/** Tells the user something that matters, wherever pi is hosted. */
export function notice(ctx: any, message: string, level: NoticeLevel = "info"): void {
  if (channel) channel.notice(ctx, message, level);
  else if (host.headless) process.stderr.write(`pi-pi: ${message}\n`);
  else ctx?.ui?.notify?.(message, level);
}

/** Runs a slash command's handler with notices shown at once, since the host opened a turn for the command. */
export async function asCommand<T>(run: () => Promise<T>): Promise<T> {
  if (!channel) return run();
  channel.inCommand = true;
  try {
    return await run();
  } finally {
    channel.inCommand = false;
  }
}

/** Tells the user something about the command they just ran: shown now, never held for a later run. */
export function commandNotice(ctx: any, message: string, level: NoticeLevel = "info"): void {
  if (channel) channel.notice(ctx, message, level, true);
  else if (host.headless) process.stderr.write(`pi-pi: ${message}\n`);
  else ctx?.ui?.notify?.(message, level);
}

/** Shows a report the user asked for. */
export async function report(ctx: any, title: string, text: string, level: NoticeLevel = "info"): Promise<void> {
  if (channel) await channel.report(ctx, title, text, level);
  else if (host.headless) process.stderr.write(`${title}\n${text}\n`);
  else ctx?.ui?.notify?.(`${title}\n${text}`, level);
}
