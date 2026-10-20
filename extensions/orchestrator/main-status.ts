import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./workers/delivery.js";

export type MainStatusLevel = "normal" | "attention" | "alarm" | "idle";

export interface MainStatus {
  text: string;
  level: MainStatusLevel;
  /** When the state began; the footer appends the time since. */
  since: number;
  /** Ends with "esc to interrupt" after the time, for a stall. */
  suffix?: string;
}

type State =
  | { kind: "idle"; since: number; settledAt?: number }
  | { kind: "waiting_model"; since: number; model: string }
  | { kind: "thinking"; since: number }
  | { kind: "writing"; since: number }
  | { kind: "tool"; since: number; label: string }
  | { kind: "waiting_workers"; since: number; count: number }
  | { kind: "waiting_user"; since: number }
  | { kind: "paused"; since: number; why: string; until?: number }
  | { kind: "compacting"; since: number };

/** How long a request may go without a token before the status says so in red. */
const NO_RESPONSE_MS = 120_000;

/**
 * What the main agent is doing right now, from pi's own events, for the
 * footer's first line. One state at a time, the most specific one. Some
 * states are owned by pi-pi rather than pi: a worker hold shows as waiting on
 * workers, and the orchestrator says so through holdingWorkers().
 */
export class MainStatusTracker {
  private state: State = { kind: "idle", since: Date.now() };
  /** What a dialog or a compaction interrupted, to go back to when it ends. */
  private underneath: State | null = null;
  private dialogs = 0;
  private readonly tools = new Map<string, string>();
  private modelLabel = "the model";
  private lastActivity = Date.now();
  private onChange: (() => void) | null = null;

  constructor(private readonly hooks: { holdingWorkers(): number; activeWaits(): number } = { holdingWorkers: () => 0, activeWaits: () => 0 }, private readonly now: () => number = Date.now) {}

  subscribe(listener: () => void): void {
    this.onChange = listener;
  }

  private set(next: State): void {
    this.state = next;
    this.onChange?.();
  }

  private activity(): void {
    this.lastActivity = this.now();
  }

  /** The tracker's clock, so whoever shows a status measures time on the same one. */
  clock(): number {
    return this.now();
  }

  current(): MainStatus {
    const now = this.now();
    const s = this.state;
    const holding = this.hooks.holdingWorkers();
    if (s.kind !== "idle" && holding > 0 && s.kind !== "waiting_user") {
      return { text: `Waiting for ${plural(holding, "worker")} to report`, level: "normal", since: s.since };
    }
    switch (s.kind) {
      case "idle":
        return { text: s.settledAt ? `Idle • done ${formatDuration(now - s.settledAt)} ago` : "Idle", level: "idle", since: s.since };
      case "waiting_model":
      case "thinking":
      case "writing": {
        // A model that has gone quiet, whether before its first token or mid-stream.
        if (now - this.lastActivity >= NO_RESPONSE_MS) {
          return { text: "No response", level: "alarm", since: this.lastActivity, suffix: "esc to interrupt" };
        }
        if (s.kind === "thinking") return { text: "Thinking", level: "normal", since: s.since };
        if (s.kind === "writing") return { text: "Writing the answer", level: "normal", since: s.since };
        return { text: `Waiting for ${s.model}`, level: "normal", since: s.since };
      }
      case "tool": {
        const waits = this.hooks.activeWaits();
        if (waits > 0 && this.tools.size === 1 && [...this.tools.values()][0] === "agent_wait") {
          return { text: `Waiting on ${plural(waits, "worker")}`, level: "normal", since: s.since };
        }
        return { text: `Running ${s.label}`, level: "normal", since: s.since };
      }
      case "waiting_workers":
        return { text: `Waiting on ${plural(s.count, "worker")}`, level: "normal", since: s.since };
      case "waiting_user":
        return { text: "Waiting for your answer", level: "attention", since: s.since };
      case "paused":
        // A wait that has run out while nothing else happened: back to what it was.
        if (s.until !== undefined && now >= s.until) return { text: "Idle", level: "idle", since: s.until };
        return { text: s.why, level: "attention", since: s.since };
      case "compacting":
        return { text: "Compacting context", level: "normal", since: s.since };
    }
  }

  /**
   * pi-pi's own waits that pi has no event for: a provider rate limit it is
   * waiting out. Cleared by the next event, or by running out.
   */
  pause(why: string, until?: number): void {
    this.set({ kind: "paused", since: this.now(), why, until });
  }

  register(pi: ExtensionAPI): void {
    const on = pi.on.bind(pi) as (event: string, handler: (event: any, ctx: any) => unknown) => void;
    on("agent_start", (_event, ctx) => {
      this.modelLabel = ctx?.model?.id ?? "the model";
      this.activity();
      this.underneath = null;
      this.set({ kind: "waiting_model", since: this.now(), model: this.modelLabel });
    });
    on("turn_start", (_event, ctx) => {
      if (ctx?.model?.id) this.modelLabel = ctx.model.id;
      this.activity();
      if (this.state.kind !== "waiting_user") this.set({ kind: "waiting_model", since: this.now(), model: this.modelLabel });
    });
    on("message_update", (event) => {
      this.activity();
      const type = event?.assistantMessageEvent?.type as string | undefined;
      if (!type || this.tools.size || this.state.kind === "waiting_user") return;
      const kind = type.startsWith("thinking") ? "thinking" : type.startsWith("text") ? "writing" : type.startsWith("toolcall") ? "writing" : undefined;
      if (kind && this.state.kind !== kind) this.set({ kind, since: this.now() } as State);
    });
    on("tool_execution_start", (event) => {
      this.activity();
      const name = String(event?.toolName ?? "a tool");
      this.tools.set(String(event?.toolCallId ?? name), name);
      if (name === "ask_user" || name === "confirm") return this.set({ kind: "waiting_user", since: this.now() });
      if (this.state.kind === "waiting_user") return;
      if (this.state.kind === "tool" && this.tools.size > 1) return this.set({ kind: "tool", since: this.state.since, label: `${this.tools.size} tools` });
      this.set({ kind: "tool", since: this.now(), label: toolLabel(name, event?.args) });
    });
    on("tool_execution_update", () => this.activity());
    on("tool_execution_end", (event) => {
      this.activity();
      this.tools.delete(String(event?.toolCallId ?? event?.toolName));
      if (this.tools.size) {
        // An answered question leaves the tools that ran beside it; a question
        // still open keeps the status on the user.
        const asking = [...this.tools.values()].some((name) => name === "ask_user" || name === "confirm");
        if (asking) return;
        // A dialog another tool opened is still up: what it covers moves on.
        if (this.state.kind === "waiting_user" && this.underneath) {
          if (this.underneath.kind === "tool") this.underneath = { ...this.underneath, label: this.tools.size === 1 ? [...this.tools.values()][0]! : `${this.tools.size} tools` };
          return;
        }
        if (this.state.kind === "tool" || this.state.kind === "waiting_user") {
          const since = this.state.kind === "tool" ? this.state.since : this.now();
          this.set({ kind: "tool", since, label: this.tools.size === 1 ? [...this.tools.values()][0]! : `${this.tools.size} tools` });
        }
        return;
      }
      const next: State = { kind: "waiting_model", since: this.now(), model: this.modelLabel };
      // A dialog still open over the finished tool keeps the status on the user.
      if (this.state.kind === "waiting_user" && this.underneath) {
        this.underneath = next;
        return;
      }
      this.set(next);
    });
    // A dialog can open while idle (a /pp menu) or in the middle of a tool;
    // when it closes the agent is back to whatever it was doing before.
    // pi reports each dialog's start and end in microtasks of their own, so
    // one dialog's end can arrive after the next one's start: count them.
    on("ui_prompt_start", () => {
      if (this.dialogs++ > 0 || this.state.kind === "waiting_user") return;
      this.underneath = this.state;
      this.set({ kind: "waiting_user", since: this.now() });
    });
    on("ui_prompt_end", () => {
      this.activity();
      this.dialogs = Math.max(0, this.dialogs - 1);
      if (this.dialogs > 0 || this.state.kind !== "waiting_user") return;
      const back = this.underneath;
      this.underneath = null;
      if (back) this.set(back.kind === "idle" ? back : { ...back, since: this.now() } as State);
    });
    // A /compact typed while idle ends idle; one pi runs mid-run goes back to the run.
    on("session_before_compact", () => {
      if (this.state.kind !== "compacting") this.underneath = this.state;
      this.set({ kind: "compacting", since: this.now() });
    });
    const compacted = () => {
      if (this.state.kind !== "compacting") return;
      this.activity();
      const back = this.underneath;
      this.underneath = null;
      this.set(!back || back.kind === "idle" ? { kind: "idle", since: this.now(), settledAt: this.now() } : { kind: "waiting_model", since: this.now(), model: this.modelLabel });
    };
    on("session_compact", compacted);
    on("session_compact_failed", compacted);
    on("agent_settled", () => {
      this.tools.clear();
      const idle: State = { kind: "idle", since: this.now(), settledAt: this.now() };
      // A dialog still open (a /pp menu) stays the status; idle is what it covers.
      if (this.dialogs > 0 && this.state.kind === "waiting_user") {
        this.underneath = idle;
        return;
      }
      this.underneath = null;
      this.set(idle);
    });
    on("session_start", () => {
      this.dialogs = 0;
      this.underneath = null;
    });
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function toolLabel(name: string, args: any): string {
  const detail = name === "bash" && typeof args?.command === "string" ? args.command
    : typeof args?.path === "string" ? args.path
    : typeof args?.filePath === "string" ? args.filePath
    : typeof args?.pattern === "string" ? args.pattern
    : typeof args?.query === "string" ? args.query
    : typeof args?.description === "string" ? args.description
    : "";
  const flat = String(detail).replace(/\s+/g, " ").trim();
  return flat ? `${name}: ${flat}` : name;
}
