import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectHost } from "./host.js";
import { getLogger } from "./log.js";
import type { Orchestrator } from "./orchestrator.js";
import type { TaskFeed } from "./tasks/index.js";
import type { WorkerManager } from "./workers/manager.js";
import type { WorkerRecord } from "./workers/types.js";

const TICK_MS = 500;
// Rewritten at least this often while the session lives, so a reader can tell a crashed pi from an idle one.
const HEARTBEAT_MS = 5000;
const RESULTS_KEPT = 20;
const PROMPT_CHARS = 1500;
const RESULT_CHARS = 2000;

/** What the pi-pi bb plugin reads; bump `version` on an incompatible change. */
export interface BbState {
  version: 1;
  pid: number;
  /** False once the session that wrote it has shut down. */
  live: boolean;
  heartbeatAt: number;
  tasks: Array<{ id: string; subject: string; status: string; activeForm?: string }>;
  workers: BbWorker[];
  commandResults: BbCommandResult[];
}

export interface BbWorker {
  id: string;
  type: string;
  description: string;
  prompt: string;
  status: WorkerRecord["status"];
  model: string;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  lastEventAt: number;
  silent: boolean;
  toolUses: number;
  tokens: number;
  step?: { label: string; since: number };
  progress?: string;
  outputTail: string;
  question?: string;
  result?: { status: string; summary: string; body: string };
  error?: string;
}

export interface BbCommand {
  id: string;
  workerId: string;
  action: "stop" | "kill" | "message";
  text?: string;
}

export interface BbCommandResult {
  id: string;
  ok: boolean;
  message: string;
  at: number;
}

/**
 * bb drops pi's widgets, so under bb the task list and the workers are
 * mirrored into the thread's storage directory, where pi-pi's bb plugin reads
 * them; the plugin's Stop/Kill/Message buttons come back as command files.
 */
export function registerBbBridge(orchestrator: Orchestrator, tasks: TaskFeed, env: NodeJS.ProcessEnv = process.env): void {
  const storage = env.BB_THREAD_STORAGE;
  if (!storage) return;
  const dir = join(storage, "pi-pi");
  const commandsDir = join(dir, "commands");
  const stateFile = join(dir, "state.json");
  let timer: ReturnType<typeof setInterval> | null = null;
  let written = "";
  let writtenAt = 0;
  let results: BbCommandResult[] = [];
  let failed = false;

  const write = (live: boolean) => {
    const state: Omit<BbState, "heartbeatAt"> = {
      version: 1,
      pid: process.pid,
      live,
      tasks: tasks.current().tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status, ...(task.activeForm ? { activeForm: task.activeForm } : {}) })),
      workers: (orchestrator.workers?.list() ?? []).map(toBbWorker),
      commandResults: results,
    };
    const json = JSON.stringify(state);
    const now = Date.now();
    if (json === written && now - writtenAt < HEARTBEAT_MS) return;
    try {
      mkdirSync(commandsDir, { recursive: true });
      const temp = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...state, heartbeatAt: now } satisfies BbState));
      renameSync(temp, stateFile);
      written = json;
      writtenAt = now;
      failed = false;
    } catch (error: any) {
      // Logged once per run of failures: the tick retries every half second.
      if (!failed) getLogger().warn({ s: "bb", err: error?.message }, "writing the bb state file failed");
      failed = true;
    }
  };

  const runCommands = () => {
    let names: string[];
    try {
      names = readdirSync(commandsDir).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(commandsDir, name);
      let command: BbCommand | undefined;
      try {
        command = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      // Removed before it runs: a command that throws must not run again on the next tick.
      try { rmSync(file, { force: true }); } catch {}
      if (!command?.id) continue;
      let outcome: { ok: boolean; message: string };
      try {
        outcome = runCommand(orchestrator.workers, command);
      } catch (error: any) {
        outcome = { ok: false, message: `Failed: ${error?.message ?? String(error)}` };
      }
      results = [...results, { id: command.id, ...outcome, at: Date.now() }].slice(-RESULTS_KEPT);
    }
  };

  const tick = () => {
    runCommands();
    write(true);
  };

  orchestrator.pi.on("session_start", async (_event, ctx: any) => {
    // bb puts the variable in every shell the agent runs too; a pi started there
    // (in the terminal, or with -p) must not take over the thread's own file.
    if (detectHost(ctx?.mode, env).id !== "bb") return;
    results = [];
    if (!timer) {
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    }
    tick();
  });
  orchestrator.pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = null;
    write(false);
  });
  tasks.subscribe(() => {
    if (timer) write(true);
  });
}

function runCommand(manager: WorkerManager | null, command: BbCommand): { ok: boolean; message: string } {
  const record = manager?.get(command.workerId);
  if (!manager || !record) return { ok: false, message: "That worker is no longer retained." };
  const name = record.spec.type;
  if (command.action === "stop") {
    return manager.stop(record.id) ? { ok: true, message: `Asked ${name} to wrap up; killed in a minute if it does not.` } : { ok: false, message: `${name} is not running.` };
  }
  if (command.action === "kill") {
    return manager.kill(record.id) ? { ok: true, message: `Killed ${name}.` } : { ok: false, message: `${name} is not running.` };
  }
  if (command.action === "message") {
    const text = String(command.text ?? "").trim();
    if (!text) return { ok: false, message: "The message is empty." };
    const outcome = manager.send(record.id, text);
    if (outcome === "gone") return { ok: false, message: `${name} can no longer take messages.` };
    return { ok: true, message: outcome === "answered" ? "Answer sent." : outcome === "steered" ? "Message sent." : outcome === "resumed" ? "Resumed with your message." : "Added to its task." };
  }
  return { ok: false, message: `Unknown action ${String(command.action)}.` };
}

function toBbWorker(record: WorkerRecord): BbWorker {
  const usage = record.usage;
  return {
    id: record.id,
    type: record.spec.type,
    description: record.spec.description,
    prompt: clip(record.spec.prompt, PROMPT_CHARS),
    status: record.status,
    model: record.modelId,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
    lastEventAt: record.lastEventAt,
    silent: record.stallWarned,
    toolUses: record.toolUses,
    tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    ...(record.step ? { step: { ...record.step } } : {}),
    ...(record.progress ? { progress: record.progress } : {}),
    outputTail: record.outputTail,
    ...(record.question ? { question: record.question.text } : {}),
    ...(record.result ? { result: { status: record.result.status, summary: record.result.summary, body: clip(record.result.body, RESULT_CHARS) } } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
