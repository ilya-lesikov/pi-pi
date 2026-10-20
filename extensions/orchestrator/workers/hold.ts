import type { WorkerDelivery } from "./delivery.js";
import type { WorkerManager } from "./manager.js";
import type { WorkerRecord } from "./types.js";

export const HOLD_IDLE_MS = { rpc: 30 * 60_000, headless: 2 * 60 * 60_000 };
const POLL_MS = 500;

export type HoldOutcome =
  /** A result or question went into the run; the next turn deals with it. */
  | "yield"
  /** Nothing left to wait for: the run may end. */
  | "settled"
  /** Stopped waiting with workers still active: the user typed, the run was aborted, or a worker asks something. */
  | "released"
  /** Nothing happened for the whole idle limit. */
  | "idle";

export interface HoldHost {
  manager: WorkerManager;
  delivery: WorkerDelivery;
  /** Workers that failed and are still being considered for a retry on another provider. */
  recovering?(): number;
  signal: AbortSignal | undefined;
  /** Whether the user submitted a message pi has not yet taken in. */
  hasPendingMessages(): boolean;
  idleMs: number;
  now?: () => number;
}

/**
 * Keeps the main agent's run open while workers it started are still busy,
 * so a host that tracks one turn per prompt sees their results inside that
 * turn instead of an unprompted run after it, and a run without a UI does
 * not exit and kill them. Called from turn_end, which pi awaits before it
 * looks for queued messages: anything delivered here continues the same run.
 *
 * The idle clock is shared across turns and runs on activity: any worker
 * event or a message the user submitted resets it.
 */
export class WorkerHold {
  private lastActivity: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastActivity = now();
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  async wait(host: HoldHost): Promise<HoldOutcome> {
    const { manager, delivery, signal } = host;
    const recovering = () => host.recovering?.() ?? 0;
    const lastWorkerActivity = () => Math.max(0, ...manager.active().map((record) => record.lastEventAt));
    // Anything already handed to the run but not taken in yet: pi takes it in
    // only after this handler returns, so waiting here would wait on itself.
    const ready = () => delivery.inFlightCount() > 0 || delivery.flushNow() === "queued";
    if (ready()) return "yield";
    if (!manager.active().length && !recovering() && delivery.pending() === 0) return "settled";
    if (manager.active().some((record) => record.question)) return "released";
    if (signal?.aborted || host.hasPendingMessages()) return "released";
    // Not touched here: after a hold timed out, the next turn of the same run
    // must not wait the whole limit again for the same silent worker. A
    // message from the user, or worker activity, is what restarts the clock.
    return new Promise<HoldOutcome>((resolve) => {
      let finished = false;
      const finish = (outcome: HoldOutcome) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      // Everything is re-checked on a short poll as well as on events: a
      // delivery coalesces on its own timer, a failed worker's result waits on
      // its recovery decision, and a worker's streaming updates its activity
      // time without raising an event.
      const check = () => {
        if (finished) return;
        if (signal?.aborted || host.hasPendingMessages()) return finish("released");
        if (ready()) return finish("yield");
        const active = manager.active();
        if (active.some((record) => record.question)) return finish("released");
        if (!active.length && !recovering() && delivery.pending() === 0) return finish("settled");
        this.lastActivity = Math.max(this.lastActivity, lastWorkerActivity());
        if (this.now() - this.lastActivity >= host.idleMs) finish("idle");
      };
      const onAbort = () => finish("released");
      signal?.addEventListener("abort", onAbort, { once: true });
      const unsubscribe = manager.subscribe((event) => {
        // A stall warning reports silence; it is not activity.
        if (event.type !== "phase" && event.type !== "stall_warning") this.touch();
        queueMicrotask(check);
      });
      const poll = setInterval(check, POLL_MS);
      poll.unref?.();
      check();
    });
  }
}

/** What the final answer of a run without a UI says about workers that were still busy when it gave up waiting. */
export function unfinishedSummary(records: WorkerRecord[]): string {
  const lines = records.map((record) => `- ${record.id} (${record.spec.type}: ${record.spec.description}) — ${record.status}${record.progress ? `; last progress: ${record.progress}` : ""}${record.step ? `; was ${record.step.label}` : ""}`);
  return [
    "[PI-PI] Workers you started stayed silent for too long and were stopped, because this run has no user to wait for. They did not finish:",
    ...lines,
    "Finish your answer now. Restate your complete final answer in this reply (it is the only one printed), and say plainly which of the work above is incomplete.",
  ].join("\n");
}
