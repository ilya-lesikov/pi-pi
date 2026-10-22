import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bbForms, type BbForms } from "./bb-forms.js";
import { closeBbMenu, openBbMenu } from "./bb-menu.js";
import { menuNotices, type MenuNotice } from "./bb-menu-ui.js";
import { resolvePackageVersion } from "./custom-footer.js";
import { detectHost, fitLine } from "./host.js";
import { getLogger } from "./log.js";
import type { MainStatus } from "./main-status.js";
import type { Orchestrator } from "./orchestrator.js";
import type { TaskFeed } from "./tasks/index.js";
import type { WorkerManager } from "./workers/manager.js";
import type { WorkerRecord } from "./workers/types.js";

const TICK_MS = 500;
// Rewritten at least this often while the session lives, so a reader can tell a crashed pi from an idle one.
const HEARTBEAT_MS = 5000;
const RESULTS_KEPT = 20;
const PROMPT_CHARS = 1500;
// The parent usually answers a worker's question within this while its turn runs; the user's form waits that long first.
const QUESTION_FORM_DELAY_MS = 12_000;
// A worker's form bb could not show is tried again after this, not on every tick.
const QUESTION_FORM_RETRY_MS = 30_000;
const BB_ANSWER_TYPE = "pp-bb-answer";
const RESULT_CHARS = 2000;
// A request to open the menu older than this is left over, not the user's click now.
const MENU_COMMAND_MAX_AGE_MS = 15_000;
const VERSION = resolvePackageVersion();

/** What the pi-pi bb plugin reads; bump `version` on an incompatible change. */
export interface BbState {
  version: 1;
  pid: number;
  /** False once the session that wrote it has shut down. */
  live: boolean;
  heartbeatAt: number;
  /** pi-pi's package version. */
  piPiVersion: string;
  /** What the main agent is doing, as the footer's first line says it; `since` is on pi's clock, as `heartbeatAt` is. */
  status: MainStatus;
  tasks: Array<{ id: string; subject: string; status: string; activeForm?: string }>;
  workers: BbWorker[];
  commandResults: BbCommandResult[];
  /** What pi-pi said while its menu was open; `at` is on pi's clock. */
  notices: MenuNotice[];
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

export type BbCommand =
  | { id: string; workerId: string; action: "stop" | "kill" | "message"; text?: string }
  | { id: string; action: "menu" };

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
  let removeWarned = false;
  let sessionStartedAt = 0;

  const write = (live: boolean) => {
    const state: Omit<BbState, "heartbeatAt"> = {
      version: 1,
      pid: process.pid,
      live,
      piPiVersion: VERSION,
      status: bbStatus(orchestrator),
      tasks: tasks.current().tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status, ...(task.activeForm ? { activeForm: task.activeForm } : {}) })),
      workers: (orchestrator.workers?.list() ?? []).map(toBbWorker),
      commandResults: results,
      notices: menuNotices(),
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
      let age = 0;
      try {
        const mtime = statSync(file).mtimeMs;
        age = mtime < sessionStartedAt ? Infinity : Date.now() - mtime;
      } catch {}
      try {
        command = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      // Removed before it runs, and not run unless removed: it would run again on every tick.
      try {
        rmSync(file, { force: true });
      } catch (error: any) {
        if (!removeWarned) getLogger().warn({ s: "bb", err: error?.message, file }, "removing a bb command file failed");
        removeWarned = true;
        continue;
      }
      if (!command?.id) continue;
      let outcome: { ok: boolean; message: string };
      try {
        if (command.action !== "menu") outcome = runCommand(orchestrator.workers, command);
        // A click left from before this session started, or from a while ago, is not a request now.
        else if (age > MENU_COMMAND_MAX_AGE_MS) outcome = { ok: false, message: "Ignored an old request to open pi-pi's menu." };
        else {
          const { ok, message } = openBbMenu(orchestrator);
          outcome = { ok, message };
        }
      } catch (error: any) {
        outcome = { ok: false, message: `Failed: ${error?.message ?? String(error)}` };
      }
      results = [...results, { id: command.id, ...outcome, at: Date.now() }].slice(-RESULTS_KEPT);
    }
  };

  // Worker questions shown as forms, by question id and when it was asked: a worker
  // that asks twice in one turn reuses the id.
  // An entry stays after its form closes, so that question is not shown again; `open` is false then.
  const questionForms = new Map<string, { controller: AbortController; open: boolean }>();
  // When a question's form may be tried again after bb could not show it.
  const retryAt = new Map<string, number>();
  let forms: BbForms | null = null;

  const showQuestions = () => {
    const manager = orchestrator.workers;
    if (!forms || !manager) return;
    const asking = new Map(manager.list().filter((record) => record.question).map((record) => [`${record.question!.id}@${record.question!.askedAt}`, record]));
    for (const [questionId, form] of questionForms) {
      if (!asking.has(questionId)) {
        form.controller.abort();
        questionForms.delete(questionId);
      }
    }
    for (const questionId of retryAt.keys()) if (!asking.has(questionId)) retryAt.delete(questionId);
    const parentBusy = orchestrator.mainTurnInFlight || orchestrator.holdingRun;
    // The agent asking the user itself is most likely relaying these questions: one form is enough.
    // Forms already up are taken down, not closed for good: one still unanswered after the agent's form comes back.
    if (forms.busy) {
      for (const [questionId, form] of questionForms) {
        if (!form.open) continue;
        form.controller.abort();
        questionForms.delete(questionId);
      }
      return;
    }
    for (const [questionId, record] of asking) {
      if (questionForms.has(questionId) || Date.now() < (retryAt.get(questionId) ?? 0)) continue;
      // Counted again from the agent's last form: it has just asked the user, and its answer to the worker is on its way.
      const since = Math.max(record.question!.askedAt, forms.lastAskEndedAt);
      if (parentBusy && Date.now() - since < QUESTION_FORM_DELAY_MS) continue;
      const form = { controller: new AbortController(), open: true };
      questionForms.set(questionId, form);
      void askUserFor(forms, manager, record.id, record.question!, `${record.spec.type}: ${record.spec.description}`, form.controller.signal).then((shown) => {
        form.open = false;
        // Never shown, or bb could not keep it up: tried again later. One taken down
        // while the agent asks is already gone from the map, and comes back without waiting.
        if (!shown && questionForms.get(questionId) === form) {
          questionForms.delete(questionId);
          retryAt.set(questionId, Date.now() + QUESTION_FORM_RETRY_MS);
        }
      });
    }
  };

  /** False when the user never saw the form through to an answer or a cancel of their own. */
  const askUserFor = async (forms: BbForms, manager: WorkerManager, workerId: string, question: { id: string; text: string; askedAt: number }, workerLabel: string, signal: AbortSignal): Promise<boolean> => {
    const outcome = await forms.ask(
      { version: 1, kind: "worker-question", workerId, workerLabel: fitLine(workerLabel, 200), questionId: question.id, question: question.text.slice(0, 20_000) },
      { title: fitLine(`${workerLabel} asks`, 160), signal },
    );
    if (outcome.outcome === "unavailable" || (outcome.outcome === "cancelled" && outcome.reason !== "user")) return false;
    if (outcome.outcome !== "submitted" || outcome.value.kind !== "answer") return true;
    const answer = outcome.value.text.trim();
    // Answered elsewhere while the form was up (the agent, the worker list, a timeout): this one is late.
    const current = manager.get(workerId)?.question;
    if (!answer || current?.id !== question.id || current.askedAt !== question.askedAt) return true;
    manager.send(workerId, answer);
    const record = manager.get(workerId);
    const steer = orchestrator.mainTurnInFlight || orchestrator.holdingRun;
    orchestrator.pi.sendMessage(
      { customType: BB_ANSWER_TYPE, content: `The user answered ${workerId}'s question in bb: "${answer}". It has the answer; do not answer it again.`, display: false, details: { workerId, questionId: question.id, type: record?.spec.type } },
      { deliverAs: steer ? "steer" : "nextTurn", triggerTurn: false },
    );
    return true;
  };

  const tick = () => {
    runCommands();
    showQuestions();
    write(true);
  };

  orchestrator.pi.on("session_start", async (_event, ctx: any) => {
    // bb puts the variable in every shell the agent runs too; a pi started there
    // (in the terminal, or with -p) must not take over the thread's own file.
    if (detectHost(ctx?.mode, env).id !== "bb") return;
    closeBbMenu();
    sessionStartedAt = Date.now();
    forms = bbForms(env);
    await forms?.cancelStale();
    if (!timer) {
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    }
    tick();
  });
  // The menu runs only while the agent is idle, and only in the session it was opened in.
  orchestrator.pi.on("agent_start", async () => closeBbMenu());
  orchestrator.pi.on("session_shutdown", async () => {
    // Only the session that took the thread's file over may mark it ended.
    if (!timer) return;
    closeBbMenu();
    clearInterval(timer);
    timer = null;
    for (const form of questionForms.values()) form.controller.abort();
    questionForms.clear();
    write(false);
  });
  // bb no longer holds the composer while pi-pi's form is open: a reply typed there answers the form.
  orchestrator.pi.on("input", async (event: any) => {
    // Only what the user typed; an extension's own message must not answer anything.
    // A message with images is for the agent: a form takes only text.
    if (!timer || !forms || event?.source === "extension" || typeof event?.text !== "string" || event?.images?.length) return { action: "continue" as const };
    return forms.takeTyped(event.text) ? { action: "handled" as const } : { action: "continue" as const };
  });
  tasks.subscribe(() => {
    if (timer) write(true);
  });
}

function runCommand(manager: WorkerManager | null, command: Extract<BbCommand, { workerId: string }>): { ok: boolean; message: string } {
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

/** The footer's status, without its idle "done 5s ago", which would rewrite the file every second for nothing. */
function bbStatus(orchestrator: Orchestrator): MainStatus {
  const status = orchestrator.mainStatus?.current();
  if (!status) return { text: "Idle", level: "idle", since: 0 };
  if (status.level === "idle") return { text: "Idle", level: "idle", since: status.since };
  // "esc to interrupt" is the terminal's key; bb has a Stop button.
  const { suffix: _suffix, ...shown } = status;
  return shown;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
