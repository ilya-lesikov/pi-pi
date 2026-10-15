import { ACTIVE_STATUSES, type WorkerUsage, type WorkerEvent, type WorkerRecord, type WorkerResult, type WorkerSession, type WorkerSessionFactory, type WorkerSessionHooks, type WorkerSpawnSpec, type WorkerStatus } from "./types.js";

export interface WorkerManagerOptions {
  createSession: WorkerSessionFactory;
  maxConcurrent: () => number;
  /** Silence before the worker is flagged in the UI and the parent is told once. 0 disables. */
  stallWarnMs: () => number;
  /** How long a run may go without its session's first event before the worker fails. 0 disables. */
  startTimeoutMs?: () => number;
  /** How long a graceful stop waits for the worker to finish before killing it. */
  stopGraceMs?: number;
  /** How long an ask_parent question waits for an answer. */
  questionTimeoutMs?: () => number;
  tickMs?: number;
  /** Finished records kept for inspection and resume. */
  retainMs?: number;
  retainMax?: number;
  now?: () => number;
}

export type WaitOutcome =
  | { kind: "settled"; records: WorkerRecord[] }
  | { kind: "question"; records: WorkerRecord[] }
  | { kind: "timeout"; records: WorkerRecord[] }
  | { kind: "interrupted"; records: WorkerRecord[] };

const WRAP_UP = "[PI-PI] Your parent asked you to stop. Finish now: call submit_result with what you have (status \"partial\" if the work is incomplete) and end your turn.";
const SUBMIT_REMINDER = "[PI-PI] You ended without calling submit_result. Call it now with your final summary and body; do not redo any work.";

interface Live {
  session?: WorkerSession;
  /**
   * Bumped on kill so callbacks from the killed session are ignored. A resume
   * keeps it: the same session (and the hooks bound to it) carries on.
   */
  epoch: number;
  questionResolve?: (answer: string | undefined) => void;
  questionTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  startTimer?: ReturnType<typeof setTimeout>;
  pendingPrompt?: string;
  settledStatus?: WorkerStatus;
}

/**
 * Owns every worker the root session spawned. Nothing here awaits a child
 * session's own shutdown: a worker wedged in a tool or a provider stream is
 * settled by the manager itself, so no caller can be held by it.
 */
export class WorkerManager {
  private readonly records = new Map<string, WorkerRecord>();
  private readonly live = new Map<string, Live>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly waiters = new Set<() => void>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private counter = 0;
  private readonly now: () => number;

  constructor(private readonly options: WorkerManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): WorkerRecord[] {
    return [...this.records.values()];
  }

  /** Looks a worker up by id, or by a prefix that names exactly one. */
  get(id: string): WorkerRecord | undefined {
    const exact = this.records.get(id);
    if (exact || !id) return exact;
    const matches = [...this.records.values()].filter((record) => record.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** The live session of a worker, for callers that must act on it directly (model moves, the viewer). */
  sessionOf(id: string): WorkerSession | undefined {
    const record = this.get(id);
    return record ? this.live.get(record.id)?.session : undefined;
  }

  active(): WorkerRecord[] {
    return this.list().filter((record) => ACTIVE_STATUSES.has(record.status));
  }

  pendingQuestions(): WorkerRecord[] {
    return this.list().filter((record) => record.question).sort((a, b) => a.question!.askedAt - b.question!.askedAt);
  }

  spawn(spec: WorkerSpawnSpec): WorkerRecord {
    this.prune();
    const id = this.nextId(spec.type);
    const now = this.now();
    const record: WorkerRecord = {
      id,
      spec,
      status: "queued",
      createdAt: now,
      lastEventAt: now,
      turns: 0,
      toolUses: 0,
      lastText: "",
      outputTail: "",
      usage: emptyUsage(),
      runUsage: emptyUsage(),
      modelId: spec.model,
      runs: 0,
      undelivered: false,
      waitHolds: 0,
      stallWarned: false,
    };
    this.records.set(id, record);
    this.live.set(id, { epoch: 0, pendingPrompt: spec.prompt });
    this.queue.push(id);
    this.emit({ type: "created", record });
    this.drain();
    return record;
  }

  /**
   * Sends a message to a worker: a steer while it runs, a new run (with its
   * context intact) once it has settled. Returns what happened, for the tool result.
   */
  send(id: string, message: string): "steered" | "resumed" | "queued" | "answered" | "gone" {
    const record = this.get(id);
    if (!record) return "gone";
    const live = this.live.get(record.id);
    if (record.question) {
      this.answer(record.id, message);
      return "answered";
    }
    if (record.status === "running" && live?.session) {
      live.session.steer(message);
      this.touch(record);
      return "steered";
    }
    if (record.status === "queued" && live) {
      live.pendingPrompt = `${live.pendingPrompt ?? ""}\n\n${message}`;
      return "queued";
    }
    if (!live?.session) return "gone";
    return this.resume(record.id, message) ? "resumed" : "gone";
  }

  /** Re-runs a settled worker in its existing session. */
  resume(id: string, prompt: string): boolean {
    const record = this.records.get(id);
    const live = this.live.get(id);
    if (!record || !live?.session || ACTIVE_STATUSES.has(record.status)) return false;
    live.pendingPrompt = prompt;
    live.settledStatus = undefined;
    record.status = "queued";
    record.result = undefined;
    record.error = undefined;
    record.lastText = "";
    record.outputTail = "";
    record.lastOutputAt = undefined;
    record.progress = undefined;
    record.turns = 0;
    record.undelivered = false;
    record.stallWarned = false;
    record.lastEventAt = this.now();
    this.queue.push(id);
    this.emit({ type: "changed", record });
    this.drain();
    return true;
  }

  answer(id: string, answer: string): boolean {
    const record = this.get(id);
    const live = record && this.live.get(record.id);
    if (!record?.question || !live?.questionResolve) return false;
    const resolve = live.questionResolve;
    this.clearQuestion(record, live);
    resolve(answer);
    this.emit({ type: "changed", record });
    return true;
  }

  /** Interrupts only the tool call the worker is executing. */
  interruptTool(id: string): boolean {
    const record = this.get(id);
    const live = record && this.live.get(record.id);
    if (!record || record.status !== "running" || !live?.session) return false;
    return live.session.interruptTool();
  }

  /**
   * Graceful: asks the worker to wrap up and kills it if it has not settled
   * within the grace period. Returns immediately either way.
   */
  stop(id: string, reason: WorkerStatus = "stopped"): boolean {
    const record = this.get(id);
    if (!record || !ACTIVE_STATUSES.has(record.status)) return false;
    const live = this.live.get(record.id)!;
    if (record.status === "queued") {
      this.settle(record, reason, "stopped before it started");
      return true;
    }
    if (live.stopTimer) return true;
    live.settledStatus = reason;
    if (record.question && live.questionResolve) {
      const resolve = live.questionResolve;
      this.clearQuestion(record, live);
      resolve(undefined);
    }
    live.session?.steer(WRAP_UP);
    live.stopTimer = setTimeout(() => {
      live.stopTimer = undefined;
      if (ACTIVE_STATUSES.has(record.status)) this.kill(record.id, reason);
    }, this.options.stopGraceMs ?? 60_000);
    live.stopTimer.unref?.();
    return true;
  }

  /** Hard stop: settles the record now and tears the session down without waiting on it. */
  kill(id: string, reason: WorkerStatus = "killed", detail?: string): boolean {
    const record = this.get(id);
    if (!record || !ACTIVE_STATUSES.has(record.status)) return false;
    const live = this.live.get(record.id)!;
    live.epoch++;
    const session = live.session;
    live.session = undefined;
    try { session?.abort(); } catch {}
    try { session?.dispose(); } catch {}
    this.settle(record, reason, detail ?? (reason === "killed" ? "killed by the parent" : undefined));
    return true;
  }

  killAll(): void {
    for (const record of this.list()) {
      if (ACTIVE_STATUSES.has(record.status)) this.kill(record.id, "killed", "the parent session ended");
    }
  }

  /** Disposes every retained session; for a parent session that is going away. */
  shutdown(): void {
    // Nobody is left to tell: the kills below must not reach a delivery or a
    // UI bound to the session being torn down.
    this.listeners.clear();
    this.queue.length = 0;
    this.killAll();
    for (const [id, live] of this.live) {
      try { live.session?.dispose(); } catch {}
      live.session = undefined;
      this.clearTimers(live);
      this.live.delete(id);
    }
    this.records.clear();
    this.queue.length = 0;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Waits until any listed worker settles or asks a question, the timeout
   * passes, or the signal fires — whichever comes first. Never longer.
   */
  async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const records = ids.map((id) => this.get(id)).filter((record): record is WorkerRecord => !!record);
    const check = (): WaitOutcome | null => {
      const asking = records.filter((record) => record.question);
      if (asking.length) return { kind: "question", records: asking };
      const settled = records.filter((record) => !ACTIVE_STATUSES.has(record.status));
      if (settled.length) return { kind: "settled", records: settled };
      return null;
    };
    const immediate = check();
    if (immediate || records.length === 0) return immediate ?? { kind: "settled", records: [] };
    if (signal?.aborted) return { kind: "interrupted", records };
    for (const record of records) record.waitHolds++;
    try {
      return await new Promise<WaitOutcome>((resolve) => {
        const finish = (outcome: WaitOutcome) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.waiters.delete(onChange);
          resolve(outcome);
        };
        const onChange = () => {
          const outcome = check();
          if (outcome) finish(outcome);
          else if (records.every((record) => !this.records.has(record.id))) finish({ kind: "interrupted", records });
        };
        const onAbort = () => finish({ kind: "interrupted", records });
        const timer = setTimeout(() => finish({ kind: "timeout", records }), Math.max(0, timeoutMs));
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.add(onChange);
      });
    } finally {
      for (const record of records) record.waitHolds = Math.max(0, record.waitHolds - 1);
    }
  }

  /** Starts queued workers a raised concurrency limit now has room for. */
  poke(): void {
    this.drain();
  }

  /** Marks settlements as seen by the parent so they are not pushed again. */
  markDelivered(records: WorkerRecord[]): void {
    for (const record of records) record.undelivered = false;
  }

  private nextId(type: string): string {
    this.counter++;
    const base = type.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "worker";
    let id = `${base}-${this.counter}`;
    while (this.records.has(id)) id = `${base}-${++this.counter}`;
    return id;
  }

  private drain(): void {
    while (this.queue.length) {
      const running = this.list().filter((record) => record.status === "running").length;
      if (running >= Math.max(1, this.options.maxConcurrent())) return;
      const id = this.queue.shift()!;
      const record = this.records.get(id);
      if (!record || record.status !== "queued") continue;
      void this.start(record);
    }
  }

  private async start(record: WorkerRecord): Promise<void> {
    const live = this.live.get(record.id)!;
    const epoch = live.epoch;
    const now = this.now();
    record.status = "running";
    record.startedAt = now;
    record.lastEventAt = now;
    record.runs++;
    record.runUsage = emptyUsage();
    this.ensureTicker();
    this.emit({ type: "started", record });
    this.setPhase(record, live.session ? "sending the prompt" : "building the session");
    const startMs = this.options.startTimeoutMs?.() ?? 0;
    if (startMs > 0) {
      if (live.startTimer) clearTimeout(live.startTimer);
      live.startTimer = setTimeout(() => {
        live.startTimer = undefined;
        if (live.epoch !== epoch || record.status !== "running" || record.startPhase === undefined || live.stopTimer) return;
        this.kill(record.id, "failed", `The worker did not start within ${Math.round(startMs / 1000)}s: it was stuck ${record.startPhase} and never reached the model.`);
      }, startMs);
      live.startTimer.unref?.();
    }
    const prompt = live.pendingPrompt ?? record.spec.prompt;
    live.pendingPrompt = undefined;
    try {
      let session = live.session;
      if (!session) {
        session = await this.options.createSession(record.spec, this.hooks(record, epoch));
        record.lastEventAt = this.now();
        // Killed while the session was being built: nobody else holds it.
        if (live.epoch !== epoch) {
          try { session.dispose(); } catch {}
          return;
        }
        live.session = session;
        if (record.startPhase !== undefined) this.setPhase(record, "sending the prompt");
      }
      await session.run(prompt);
      if (live.epoch !== epoch || record.status !== "running") return;
      const error = session.lastError();
      if (error && !live.settledStatus) {
        this.settle(record, "failed", error);
        return;
      }
      // Only a schema the parent consumes, or an answer with no text at all, is
      // worth another turn; otherwise the final text stands in for the result.
      if (!record.result && !live.settledStatus && (record.spec.resultSchema || !session.lastAssistantText().trim())) {
        await session.run(SUBMIT_REMINDER);
        if (live.epoch !== epoch || record.status !== "running") return;
      }
      if (!record.result) {
        const text = session.lastAssistantText().trim() || record.lastText.trim();
        record.result = { status: "unstructured", summary: firstLine(text), body: text };
      }
      this.settle(record, live.settledStatus ?? "completed");
    } catch (error: any) {
      if (live.epoch !== epoch || record.status !== "running") return;
      this.settle(record, live.settledStatus ?? "failed", error?.message ?? String(error));
    }
  }

  private hooks(record: WorkerRecord, epoch: number): WorkerSessionHooks {
    const current = () => this.live.get(record.id)?.epoch === epoch && record.status === "running";
    return {
      onPhase: (phase) => { if (current() && record.startPhase !== undefined) this.setPhase(record, phase); },
      onEvent: () => {
        if (!current()) return;
        record.lastEventAt = this.now();
        if (record.startPhase === undefined) return;
        record.startPhase = undefined;
        const live = this.live.get(record.id);
        if (live?.startTimer) clearTimeout(live.startTimer);
        if (live) live.startTimer = undefined;
        this.emit({ type: "phase", record, phase: "first event" });
      },
      onStep: (label) => {
        if (!current()) return;
        if (label === "thinking" || label === "writing its reply") record.outputTail = "";
        this.setStep(record, label);
      },
      onOutput: (tail) => {
        if (!current()) return;
        record.lastOutputAt = record.lastEventAt = this.now();
        record.stallWarned = false;
        if (tail !== undefined) record.outputTail = tail;
      },
      onToolStart: (toolName, summary) => {
        if (!current()) return;
        record.toolUses++;
        record.activity = { toolName, summary, startedAt: this.now() };
        this.setStep(record, `running ${toolName}${summary ? ` ${summary}` : ""}`);
        this.touch(record);
      },
      onToolEnd: () => {
        if (!current()) return;
        record.activity = undefined;
        this.setStep(record, "finishing its tool calls");
        this.touch(record);
      },
      onTurnEnd: () => {
        if (!current()) return;
        record.turns++;
        this.touch(record);
      },
      onUsage: (usage) => {
        if (!current()) return;
        for (const total of [record.usage, record.runUsage]) {
          total.input += usage.input ?? 0;
          total.output += usage.output ?? 0;
          total.cacheRead += usage.cacheRead ?? 0;
          total.cacheWrite += usage.cacheWrite ?? 0;
          total.cost += usage.cost ?? 0;
        }
      },
      onText: (text) => {
        if (!current()) return;
        record.lastText = text;
        record.lastEventAt = this.now();
      },
      submitResult: (result: WorkerResult) => {
        if (!current()) return;
        record.result = result;
        this.touch(record);
      },
      reportProgress: (text) => {
        if (!current()) return;
        record.progress = text;
        this.touch(record);
      },
      askParent: (text, signal) => this.ask(record, epoch, text, signal),
    };
  }

  private ask(record: WorkerRecord, epoch: number, text: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const live = this.live.get(record.id);
    if (!live || live.epoch !== epoch || record.status !== "running" || live.stopTimer) return Promise.resolve(undefined);
    if (live.questionResolve) {
      const previous = live.questionResolve;
      this.clearQuestion(record, live);
      previous(undefined);
    }
    return new Promise((resolve) => {
      const done = (answer: string | undefined) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => {
        if (live.questionResolve !== done) return;
        this.clearQuestion(record, live);
        this.emit({ type: "changed", record });
        done(undefined);
      };
      live.questionResolve = done;
      record.question = { id: `${record.id}/q${record.turns}`, text, askedAt: this.now() };
      this.setStep(record, "waiting for the parent's answer");
      record.undelivered = true;
      const timeoutMs = this.options.questionTimeoutMs?.() ?? 10 * 60_000;
      // 0 means the question waits until it is answered or the worker is stopped.
      if (timeoutMs > 0) {
        live.questionTimer = setTimeout(() => {
          if (live.questionResolve !== done) return;
          this.clearQuestion(record, live);
          this.emit({ type: "changed", record });
          done(undefined);
        }, timeoutMs);
        live.questionTimer.unref?.();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.touch(record);
      this.emit({ type: "question", record });
      this.notifyWaiters();
    });
  }

  private setPhase(record: WorkerRecord, phase: string): void {
    record.startPhase = phase;
    this.setStep(record, `starting: ${phase}`);
    this.emit({ type: "phase", record, phase });
  }

  private setStep(record: WorkerRecord, label: string): void {
    if (record.step?.label === label) return;
    record.step = { label, since: this.now() };
  }

  private clearQuestion(record: WorkerRecord, live: Live): void {
    if (live.questionTimer) clearTimeout(live.questionTimer);
    live.questionTimer = undefined;
    live.questionResolve = undefined;
    record.question = undefined;
    record.lastEventAt = this.now();
  }

  private settle(record: WorkerRecord, status: WorkerStatus, error?: string): void {
    const live = this.live.get(record.id);
    if (live) {
      if (live.questionResolve) {
        const resolve = live.questionResolve;
        this.clearQuestion(record, live);
        resolve(undefined);
      }
      this.clearTimers(live);
      live.settledStatus = undefined;
    }
    const now = this.now();
    record.status = status;
    record.settledAt = now;
    record.lastEventAt = now;
    record.activity = undefined;
    record.startPhase = undefined;
    record.step = undefined;
    if (error) record.error = error;
    if (!record.result && record.lastText.trim()) {
      record.result = { status: status === "completed" ? "unstructured" : "partial", summary: firstLine(record.lastText), body: record.lastText.trim() };
    }
    record.undelivered = true;
    this.emit({ type: "settled", record });
    this.notifyWaiters();
    this.drain();
    this.prune();
  }

  private clearTimers(live: Live): void {
    if (live.stopTimer) clearTimeout(live.stopTimer);
    if (live.questionTimer) clearTimeout(live.questionTimer);
    if (live.startTimer) clearTimeout(live.startTimer);
    live.stopTimer = live.questionTimer = live.startTimer = undefined;
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), this.options.tickMs ?? 15_000);
    this.ticker.unref?.();
  }

  /** Liveness: flags workers that have produced nothing for too long; the parent decides what to do. */
  tick(): void {
    const now = this.now();
    const warnMs = this.options.stallWarnMs();
    for (const record of this.list()) {
      if (record.status !== "running" || record.question) continue;
      const silent = now - record.lastEventAt;
      if (warnMs > 0 && silent >= warnMs && !record.stallWarned) {
        record.stallWarned = true;
        this.emit({ type: "stall_warning", record });
      }
    }
    if (!this.list().some((record) => ACTIVE_STATUSES.has(record.status)) && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private touch(record: WorkerRecord): void {
    record.lastEventAt = this.now();
    record.stallWarned = false;
    this.emit({ type: "changed", record });
  }

  private prune(): void {
    const retainMs = this.options.retainMs ?? 60 * 60_000;
    const retainMax = this.options.retainMax ?? 20;
    const now = this.now();
    const finished = this.list()
      .filter((record) => !ACTIVE_STATUSES.has(record.status) && !record.undelivered && !record.waitHolds)
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    let excess = finished.length - retainMax;
    for (const record of finished) {
      if (excess <= 0 && now - (record.settledAt ?? now) < retainMs) continue;
      excess--;
      const live = this.live.get(record.id);
      try { live?.session?.dispose(); } catch {}
      if (live) this.clearTimers(live);
      this.live.delete(record.id);
      this.records.delete(record.id);
    }
  }

  private notifyWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private emit(event: WorkerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function emptyUsage(): WorkerUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n").find((entry) => entry.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
