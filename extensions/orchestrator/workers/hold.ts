import type { WorkerDelivery } from "./delivery.js";
import type { WorkerManager } from "./manager.js";
import type { WorkerRecord } from "./types.js";

export const HOLD_IDLE_MS = { rpc: 30 * 60_000, headless: 2 * 60 * 60_000 };
const PENDING_POLL_MS = 500;

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
    // Something already handed to the run but not taken in yet: pi takes it
    // in only after this handler returns, so waiting here would wait on itself.
    if (delivery.inFlightCount() > 0) return "yield";
    if (delivery.flushNow() === "queued") return "yield";
    if (!manager.active().length) return "settled";
    if (manager.active().some((record) => record.question)) return "released";
    if (signal?.aborted || host.hasPendingMessages()) return "released";
    this.touch();
    return new Promise<HoldOutcome>((resolve) => {
      let finished = false;
      const finish = (outcome: HoldOutcome) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(idleTimer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const check = () => {
        if (signal?.aborted || host.hasPendingMessages()) return finish("released");
        if (delivery.flushNow() === "queued" || delivery.inFlightCount() > 0) return finish("yield");
        const active = manager.active();
        if (active.some((record) => record.question)) return finish("released");
        if (!active.length && delivery.pending() === 0) return finish("settled");
        armIdle();
      };
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const left = Math.max(0, host.idleMs - (this.now() - this.lastActivity));
        idleTimer = setTimeout(() => (this.now() - this.lastActivity >= host.idleMs ? finish("idle") : armIdle()), left);
        idleTimer.unref?.();
      };
      const onAbort = () => finish("released");
      signal?.addEventListener("abort", onAbort, { once: true });
      const unsubscribe = manager.subscribe((event) => {
        if (event.type !== "phase") this.touch();
        if (event.type === "settled" || event.type === "question" || event.type === "changed") queueMicrotask(check);
      });
      // A submitted message raises no event an extension can await.
      const poll = setInterval(() => {
        if (signal?.aborted || host.hasPendingMessages()) {
          this.touch();
          finish("released");
        }
      }, PENDING_POLL_MS);
      poll.unref?.();
      armIdle();
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
