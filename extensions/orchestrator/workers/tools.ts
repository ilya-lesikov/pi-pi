import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./delivery.js";
import type { WaitOutcome, WorkerManager } from "./manager.js";
import { ACTIVE_STATUSES, type WorkerRecord, type WorkerSpawnSpec } from "./types.js";

export interface WorkerToolsHost {
  manager: () => WorkerManager | null;
  /** Validates and resolves a spawn request into a spec; a string is the refusal shown to the model. */
  prepareSpawn(params: { subagent_type: string; description: string; prompt: string; skills?: string[]; notify?: "wake" | "silent" }, toolCallId: string, ctx: any): WorkerSpawnSpec | string;
  /** Called when a tool showed the model these outcomes, so the push delivery skips them. */
  consumed(records: WorkerRecord[], kind?: "settled" | "question"): void;
  /** The worker's transcript file, once it has one. */
  transcriptFile?(id: string): string | undefined;
  /** Whether to add what Paseo reads to show a worker as a native sub-agent card. */
  paseoCards?(): boolean;
}

const PROGRESS_MS = 2000;

/** How a worker status reads in the format Paseo's sub-agent cards understand. */
export function paseoStatus(status: WorkerRecord["status"]): string {
  if (status === "completed" || status === "idle") return "completed";
  if (status === "failed") return "error";
  if (status === "stopped" || status === "killed") return "stopped";
  return "running";
}

const WAIT_MAX_SEC = 600;
const WAIT_DEFAULT_SEC = 300;

function text(value: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: value }], details };
}

export function registerWorkerTools(pi: ExtensionAPI, host: WorkerToolsHost): void {
  // The types are known only once the session has registered its agents, and
  // the delegation roster in the system prompt lists them in full anyway.
  const subagentType = Type.String({ description: "The type of agent to start, from the roster in your instructions." });
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: [
      "Start a worker agent in the background. Returns its id at once; the worker runs while you keep working.",
      "Its result arrives on its own as a worker update — after your current tool calls if you are busy, or when you are idle — so do not wait for it unless your very next step needs it.",
      "Control it with agent_send (steer it, answer its question, or give a finished worker more work in the same context), agent_status, agent_wait (bounded), and agent_stop.",
    ].join("\n"),
    promptSnippet: "Start a background worker agent; returns its id immediately",
    parameters: Type.Object({
      subagent_type: subagentType,
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      prompt: Type.String({ description: "The task for the worker. It starts with an empty context: state everything it needs." }),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to preload into the worker's prompt. Only skills marked as usable by subagents in your skills catalog are accepted." })),
      notify: Type.Optional(Type.Union([Type.Literal("wake"), Type.Literal("silent")], { description: "\"wake\" (default): its result starts a turn if you are idle. \"silent\": the result waits for your next turn (outside the terminal it arrives in the current one, like \"wake\")." })),
    }),
    async execute(toolCallId, params: any, _signal, _onUpdate, ctx) {
      const manager = host.manager();
      if (!manager) return { ...text("Workers are unavailable: the session is not ready."), isError: true } as any;
      const spec = host.prepareSpawn(params, toolCallId, ctx);
      if (typeof spec === "string") return { ...text(spec), isError: true } as any;
      const record = manager.spawn(spec);
      const queued = record.status === "queued" ? " It is queued behind the concurrency limit and starts when a slot frees." : "";
      const message = `Started worker ${record.id} (${spec.type}: ${spec.description}); it is still running.${queued} Its result will arrive as a worker update; keep working.`;
      if (!host.paseoCards?.()) return text(message, { id: record.id });
      // Paseo follows the file named on an "Output file:" line, and needs the
      // worker id and status in the details to keep its card up to date.
      const file = host.transcriptFile?.(record.id);
      return text(`${message}${file ? `\nOutput file: ${file}` : ""}`, { id: record.id, agentId: record.id, status: paseoStatus(record.status), displayName: spec.type, description: spec.description });
    },
  });

  pi.registerTool({
    name: "agent_wait",
    label: "Wait for agents",
    description: "Wait for workers, bounded: returns as soon as any listed worker finishes or asks a question, or when the timeout passes, or when the user interrupts. Use only when your next step cannot proceed without a result; otherwise keep working and let the update arrive.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Worker ids to wait on.", minItems: 1 }),
      timeout_sec: Type.Optional(Type.Number({ description: `Seconds to wait, at most ${WAIT_MAX_SEC} (default ${WAIT_DEFAULT_SEC}).`, minimum: 1, maximum: WAIT_MAX_SEC })),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      const manager = host.manager();
      if (!manager) return { ...text("Workers are unavailable."), isError: true } as any;
      const ids: string[] = params.ids ?? [];
      const unknown = ids.filter((id) => !manager.get(id));
      if (unknown.length === ids.length) return { ...text(`No such worker: ${unknown.join(", ")}.`), isError: true } as any;
      const timeoutSec = Math.min(WAIT_MAX_SEC, Math.max(1, Number(params.timeout_sec) || WAIT_DEFAULT_SEC));
      // What the workers are doing, as the call's progress: hosts show a
      // running tool's updates, which is how a user outside the terminal sees
      // workers at all while the agent waits on them.
      let last = "";
      const report = () => {
        const lines = ids.map((id) => manager.get(id)).filter((record): record is WorkerRecord => !!record).map((record) => progressLine(record, Date.now()));
        const body = lines.join("\n");
        if (body === last) return;
        last = body;
        onUpdate?.({ content: [{ type: "text", text: body }], details: { progress: true } } as any);
      };
      report();
      const ticker = onUpdate ? setInterval(report, PROGRESS_MS) : undefined;
      ticker?.unref?.();
      const outcome = await manager.wait(ids, timeoutSec * 1000, signal).finally(() => { if (ticker) clearInterval(ticker); });
      if (outcome.kind === "settled" || outcome.kind === "question") host.consumed(outcome.records, outcome.kind);
      return text(renderWait(outcome, manager, unknown), { kind: outcome.kind, ids: outcome.records.map((record) => record.id) });
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "Message agent",
    description: "Send a message to a worker. While it runs: steers it at its next step. If it asked you a question: the message is the answer. If it has finished: starts it again on this message with its whole context intact (follow-up work, no re-briefing).",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id." }),
      message: Type.String(),
    }),
    async execute(_toolCallId, params: any) {
      const manager = host.manager();
      if (!manager) return { ...text("Workers are unavailable."), isError: true } as any;
      const record = manager.get(params.id);
      if (!record) return { ...text(`No such worker: ${params.id}.`), isError: true } as any;
      const was = record.status;
      const outcome = manager.send(record.id, String(params.message ?? ""));
      const messages: Record<typeof outcome, string> = {
        steered: `Steered ${record.id}; it sees the message at its next step.`,
        answered: `Answered ${record.id}'s question; it continues.`,
        queued: `${record.id} has not started yet; the message was added to its task.`,
        resumed: `Resumed ${record.id} (was ${was}) with its context intact. Its result will arrive as a worker update.`,
        gone: `${record.id} can no longer take messages (its session was released).`,
      };
      return { ...text(messages[outcome]), ...(outcome === "gone" ? { isError: true } : {}) } as any;
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Agent status",
    description: "Show workers: with no id, a line per worker with its turn, current step and how long it has been at it, and when the model last produced output; with an id, also the tail of what it is writing or thinking, any pending question, and the full result.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params: any) {
      const manager = host.manager();
      if (!manager) return { ...text("Workers are unavailable."), isError: true } as any;
      if (!params.id) {
        const records = manager.list();
        if (!records.length) return text("No workers.");
        return text(records.map((record) => statusLine(record, Date.now())).join("\n"));
      }
      const record = manager.get(params.id);
      if (!record) return { ...text(`No such worker: ${params.id}.`), isError: true } as any;
      if (!ACTIVE_STATUSES.has(record.status)) host.consumed([record]);
      return text(statusDetail(record, Date.now()));
    },
  });

  pi.registerTool({
    name: "agent_stop",
    label: "Stop agent",
    description: [
      "Stop a worker you started. Returns immediately.",
      "mode \"graceful\" (default): asks it to wrap up and submit what it has; kills it if it does not finish within a minute.",
      "mode \"kill\": ends it now, even if it is stuck in a tool or a model call. Its partial result is kept.",
      "mode \"tool\": cancels the tool calls it is running right now; the worker carries on.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({ description: "Worker id, or \"all\" for every active worker." }),
      mode: Type.Optional(Type.Union([Type.Literal("graceful"), Type.Literal("kill"), Type.Literal("tool")])),
    }),
    async execute(_toolCallId, params: any) {
      const manager = host.manager();
      if (!manager) return { ...text("Workers are unavailable."), isError: true } as any;
      const mode = params.mode ?? "graceful";
      const targets = params.id === "all" ? manager.list().filter((record) => ACTIVE_STATUSES.has(record.status) || manager.recovering(record.id)) : [manager.get(params.id)].filter((record): record is WorkerRecord => !!record);
      if (!targets.length) return { ...text(params.id === "all" ? "No active workers." : `No such worker: ${params.id}.`), isError: params.id !== "all" } as any;
      const lines = targets.map((record) => {
        if (mode === "tool") return manager.interruptTool(record.id) ? `${record.id}: interrupted its running tool calls.` : `${record.id}: no tool call in progress.`;
        if (!ACTIVE_STATUSES.has(record.status) && manager.recovering(record.id)) {
          manager.kill(record.id);
          return `${record.id}: failed; it will not be retried.`;
        }
        if (!ACTIVE_STATUSES.has(record.status)) return `${record.id}: already ${record.status}.`;
        if (mode === "kill") {
          manager.kill(record.id);
          // The kill is reported right here; a later update would only wake the
          // caller to repeat it, unless the worker left something behind.
          if (!record.result) host.consumed([record]);
          return record.result ? `${record.id}: killed; its partial result follows as a worker update.` : `${record.id}: killed; it left no result.`;
        }
        manager.stop(record.id);
        return record.status === "running" ? `${record.id}: asked to wrap up; killed in a minute if it does not.` : `${record.id}: ${record.status}.`;
      });
      return text(lines.join("\n"));
    },
  });
}

function renderWait(outcome: WaitOutcome, manager: WorkerManager, unknown: string[]): string {
  const now = Date.now();
  const lines: string[] = [];
  if (outcome.kind === "settled") {
    for (const record of outcome.records) lines.push(statusDetail(record, now));
  } else if (outcome.kind === "question") {
    for (const record of outcome.records) lines.push(`${record.id} asks: ${record.question?.text}\nAnswer with agent_send(id: "${record.id}", message: ...).`);
  } else {
    lines.push(outcome.kind === "timeout" ? "Timed out; the workers are still running:" : "Wait interrupted; the workers are still running:");
    for (const record of outcome.records) lines.push(statusLine(manager.get(record.id) ?? record, now));
  }
  if (unknown.length) lines.push(`Unknown ids ignored: ${unknown.join(", ")}.`);
  return lines.join("\n\n");
}

function progressLine(record: WorkerRecord, now: number): string {
  const mark = record.question ? "?" : record.status === "running" ? "⠿" : record.status === "queued" ? "…" : record.status === "completed" ? "✓" : "✗";
  const elapsed = formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt));
  const head = `${mark} ${record.id}  ${record.spec.description}  ${elapsed} · ${record.toolUses} tools`;
  const detail = record.question ? `asks: ${record.question.text}` : record.status === "running" ? record.step?.label : record.result?.summary ?? record.error;
  return detail ? `${head}\n  ⎿ ${detail.replace(/\s+/g, " ").slice(0, 160)}` : head;
}

export function statusLine(record: WorkerRecord, now: number): string {
  const elapsed = formatDuration((record.settledAt ?? now) - (record.startedAt ?? record.createdAt));
  const parts = [`${record.id} [${record.status}]`, `${record.spec.type}: ${record.spec.description}`, elapsed, `${record.toolUses} tools`];
  if (record.status === "running") parts.push(`turn ${record.turns + 1}`);
  if (record.status === "running" && record.step) parts.push(`${record.step.label} for ${formatDuration(now - record.step.since)}`);
  if (record.question) parts.push(`asks: ${record.question.text}`);
  if (record.status === "running") parts.push(record.lastOutputAt ? `last output ${formatDuration(now - record.lastOutputAt)} ago` : "no output yet");
  if (record.status === "running" && now - record.lastEventAt > 60_000) parts.push(`silent ${formatDuration(now - record.lastEventAt)}`);
  if (record.result?.summary && !ACTIVE_STATUSES.has(record.status)) parts.push(record.result.summary);
  return parts.join(" · ");
}

export function statusDetail(record: WorkerRecord, now: number): string {
  const lines = [statusLine(record, now)];
  if (record.progress) lines.push(`Progress: ${record.progress}`);
  if (record.status === "running" && record.outputTail.trim()) lines.push(`Latest output: …${record.outputTail.replace(/\s+/g, " ").trim()}`);
  if (record.error) lines.push(`Error: ${record.error}`);
  const result = record.result;
  if (result && !ACTIVE_STATUSES.has(record.status)) {
    lines.push(`Result (${result.status}): ${result.summary}`);
    if (result.findings?.length) lines.push(...result.findings.map((finding) => `- [${finding.severity}] ${finding.location}: ${finding.issue}`));
    if (result.body && result.body !== result.summary) lines.push(result.body);
    if (result.openQuestions?.length) lines.push(`Open questions:\n${result.openQuestions.map((question) => `- ${question}`).join("\n")}`);
  }
  return lines.join("\n");
}
