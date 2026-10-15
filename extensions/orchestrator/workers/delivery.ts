import type { WorkerRecord } from "./types.js";

export const WORKER_MESSAGE_TYPE = "pi-pi-worker";

export type DeliveryKind = "settled" | "question" | "stall";

export interface DeliveryItem {
  kind: DeliveryKind;
  record: WorkerRecord;
}

export interface WorkerMessageDetails {
  items: Array<{
    kind: DeliveryKind;
    id: string;
    type: string;
    description: string;
    status: string;
    summary: string;
    error?: string;
    question?: string;
    findings?: number;
    /** Critical and major findings. */
    seriousFindings?: number;
    durationMs?: number;
    toolUses: number;
    silentMs?: number;
  }>;
}

export interface DeliveryHost {
  /** Whether the root agent is mid-run, so a message can ride its next tool-batch boundary. */
  isStreaming(): boolean;
  /** Whether waking an idle root agent now would collide with the user (dialog open, typing, model switch). */
  canWake(): boolean;
  send(message: { customType: string; content: string; display: boolean; details: WorkerMessageDetails }, options: { deliverAs?: "steer" | "nextTurn"; triggerTurn?: boolean }): void;
  now(): number;
}

/**
 * Hands worker outcomes to the root agent without ever making it wait for
 * them. A busy agent gets them at its next tool-batch boundary; an idle one is
 * woken, but only when nobody is mid-dialog or mid-sentence; everything ready
 * at that moment goes out as one message.
 */
export class WorkerDelivery {
  private readonly outbox: DeliveryItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: DeliveryHost, private readonly options: { pollMs?: number; coalesceMs?: number } = {}) {}

  enqueue(item: DeliveryItem): void {
    const existing = this.outbox.findIndex((entry) => entry.record.id === item.record.id && entry.kind === item.kind);
    if (existing >= 0) this.outbox.splice(existing, 1);
    this.outbox.push(item);
    this.schedule(this.options.coalesceMs ?? 250);
  }

  /** Drops queued items a wait already returned to the agent. */
  forget(ids: string[]): void {
    const set = new Set(ids);
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      if (set.has(this.outbox[i]!.record.id)) this.outbox.splice(i, 1);
    }
  }

  pending(): number {
    return this.outbox.length;
  }

  clear(): void {
    this.outbox.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const held = this.outbox.filter((item) => item.record.waitHolds > 0 && stillRelevant(item));
    const ready = this.outbox.filter((item) => item.record.waitHolds === 0 && stillRelevant(item));
    this.outbox.length = 0;
    this.outbox.push(...held);
    if (ready.length === 0) {
      if (held.length) this.schedule(this.options.pollMs ?? 1000);
      return;
    }
    const silent = ready.every((item) => item.kind === "settled" && item.record.spec.notify === "silent");
    const message = { customType: WORKER_MESSAGE_TYPE, content: renderForModel(ready, this.host.now()), display: true, details: describe(ready, this.host.now()) };
    if (silent) {
      this.host.send(message, { deliverAs: "nextTurn" });
    } else if (this.host.isStreaming()) {
      this.host.send(message, { deliverAs: "steer" });
    } else if (this.host.canWake()) {
      this.host.send(message, { triggerTurn: true });
    } else {
      this.outbox.unshift(...ready);
      this.schedule(this.options.pollMs ?? 1000);
      return;
    }
    for (const item of ready) if (item.kind === "settled") item.record.undelivered = false;
    if (held.length) this.schedule(this.options.pollMs ?? 1000);
  }
}

// An answered question, a worker that came back to life, or a settlement a
// wait already handed over is not news by the time the outbox drains.
function stillRelevant(item: DeliveryItem): boolean {
  if (item.kind === "settled") return item.record.undelivered;
  if (item.kind === "question") return !!item.record.question;
  return item.record.status === "running" && item.record.stallWarned;
}

const MODEL_BODY_LIMIT = 6000;

export function renderForModel(items: DeliveryItem[], now: number): string {
  const blocks = items.map(({ kind, record }) => {
    const head = `<worker id="${record.id}" type="${record.spec.type}" description="${escapeAttr(record.spec.description)}"`;
    if (kind === "question") {
      return `${head} event="question">\n${record.question?.text ?? ""}\nAnswer with agent_send(id: "${record.id}", message: ...). If only the user can answer, ask them, then send their answer. It waits for you, up to its question timeout.\n</worker>`;
    }
    if (kind === "stall") {
      return `${head} event="silent" silent_for="${formatDuration(now - record.lastEventAt)}">\nNo activity from this worker${record.activity ? ` (in ${record.activity.toolName}: ${record.activity.summary})` : ""}. Inspect it with agent_status, interrupt the tool with agent_stop(mode: "tool"), or stop it. It is ended automatically if it stays silent.\n</worker>`;
    }
    const result = record.result;
    const lines = [`${head} event="finished" status="${record.status}" duration="${formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt))}" tool_uses="${record.toolUses}">`];
    if (record.error) lines.push(`Error: ${record.error}`);
    if (result) {
      lines.push(`Result (${result.status}): ${result.summary}`);
      if (result.findings?.length) {
        lines.push("Findings:");
        for (const finding of result.findings) lines.push(`- [${finding.severity}] ${finding.location}: ${finding.issue}`);
      }
      if (result.body && result.body !== result.summary) {
        lines.push(result.body.length > MODEL_BODY_LIMIT ? `${result.body.slice(0, MODEL_BODY_LIMIT)}\n… truncated; agent_status(id: "${record.id}") returns the full result.` : result.body);
      }
      if (result.openQuestions?.length) lines.push(`Open questions:\n${result.openQuestions.map((question) => `- ${question}`).join("\n")}`);
    } else if (!record.error) {
      lines.push("No output.");
    }
    lines.push("</worker>");
    return lines.join("\n");
  });
  return `[PI-PI] Worker update. Results describe what the worker intended; verify edits before relying on them.\n${blocks.join("\n")}`;
}

function describe(items: DeliveryItem[], now: number): WorkerMessageDetails {
  return {
    items: items.map(({ kind, record }) => ({
      kind,
      id: record.id,
      type: record.spec.type,
      description: record.spec.description,
      status: record.status,
      summary: record.result?.summary ?? "",
      ...(record.error ? { error: record.error } : {}),
      ...(record.question ? { question: record.question.text } : {}),
      ...(record.result?.findings ? { findings: record.result.findings.length, seriousFindings: record.result.findings.filter((finding) => finding.severity !== "minor").length } : {}),
      ...(kind === "settled" ? { durationMs: (record.settledAt ?? now) - (record.startedAt ?? record.createdAt) } : {}),
      toolUses: record.toolUses,
      ...(kind === "stall" ? { silentMs: now - record.lastEventAt } : {}),
    })),
  };
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}
