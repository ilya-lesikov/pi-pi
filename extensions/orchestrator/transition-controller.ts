import { getLogger } from "./log.js";

// Role of an outbound message. Drives the SDK delivery mode:
//   - "context": injected background context/artifacts. Delivered as "steer" so
//     it never starts a turn (the agent is or will be working).
//   - "instruction": a handoff that should make the agent act. Delivered as
//     "followUp" so it queues and triggers a turn once the current one settles
//     (or runs immediately when idle). Never throws "Agent is already processing".
export type SendRole = "context" | "instruction";

// Dependency passed to standalone phase-module spawn functions so they can emit
// status/context messages WITHOUT importing the orchestrator (avoids circular
// imports) while still routing every send through the controller. Bound to
// TransitionController.sendCustom by the caller.
export type PhaseSend = (
  message: { customType: string; content: string; display: boolean; details?: unknown },
  role: SendRole,
) => void;

// The kind of transition the controller is coordinating. Phase transitions resume
// the main loop with a "Begin working" instruction; done/stop transitions finish
// the task (cleanup already performed by the caller) and resolve their awaitable.
export type TransitionKind = "phase" | "done";

export interface TransitionRequest {
  kind: TransitionKind;
  // Compaction summary used by the session_before_compact handler.
  summary?: string;
  // Runs after compaction completes (or is skipped), before the resume message.
  // Used for phase transitions to switch model + inject context/artifacts and to
  // spawn planners at the right moment. Throwing here is logged, not fatal.
  onResume?: () => void | Promise<void>;
  // For phase transitions: the instruction sent after onResume. When omitted
  // (e.g. plan/await_planners which only notifies, or done transitions), no
  // instruction is sent.
  instruction?: string;
}

export type ControllerState = "running" | "pending" | "compacting" | "resuming";

// Minimal surface the controller needs from the Orchestrator. Kept as an
// interface so the controller is unit-testable with a fake host and so phase
// modules can depend on `send` without importing the orchestrator (avoids
// circular imports).
export interface TransitionHost {
  // Outbound primitives — the controller is the ONLY caller of these for the
  // main session. `send` fans out to these based on role.
  rawSendUserMessage(text: string, deliverAs: "steer" | "followUp"): void;
  rawSendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, deliverAs: "steer" | "followUp" | "nextTurn"): void;
  // Compaction + idle probe come from the live ExtensionContext (lastCtx).
  compact(options: { customInstructions?: string; onComplete?: () => void; onError?: (err: Error) => void }): boolean;
  isIdle(): boolean;
  // Persisted step, used to derive the await_* "not running" predicate.
  currentStep(): string | null;
}

const COMPACT_NOOP_MESSAGES = [
  "Nothing to compact (session too small)",
  "Already compacted",
];

function isCompactNoop(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return COMPACT_NOOP_MESSAGES.some((m) => msg.includes(m));
}

// Single event-driven owner of phase/task transitions and main-session
// compaction + outbound messaging. See transition-controller flow in the plan:
//   requestTransition -> pending; agent_end (or already-idle) -> compact ->
//   compacting; session_compact / compact no-op / error -> resuming -> onResume
//   -> send(instruction) -> running.
export class TransitionController {
  private state: ControllerState = "running";
  private active: TransitionRequest | null = null;
  // Resolvers for callers that await the transition (done/stop/new-task paths).
  private waiters: Array<() => void> = [];

  constructor(private readonly host: TransitionHost) {}

  // Pre-bound PhaseSend handed to standalone spawn functions so they route every
  // outbound message through the controller without importing the orchestrator.
  readonly phaseSend: PhaseSend = (message, role) => this.sendCustom(message, role);

  getState(): ControllerState {
    return this.state;
  }

  // True only when the controller is idle (running) AND not waiting on subagents.
  // The await_* states live in persisted step, not the enum. Every consumer of
  // "may the agent loop start / may we nudge / may the menu proceed" reads THIS.
  isRunning(): boolean {
    if (this.state !== "running") return false;
    const step = this.host.currentStep();
    return step !== "await_planners" && step !== "await_reviewers";
  }

  // Inverse predicate used by before_agent_start / in-tool aborts: the agent
  // loop must NOT start while a transition is in flight or we're awaiting subagents.
  shouldBlockAgentStart(): boolean {
    return !this.isRunning();
  }

  // True while a transition is mid-flight (pending/compacting/resuming) — i.e.
  // the controller initiated the current compaction. Used by session_before_compact
  // to decide between supplying the transition summary vs. re-injecting artifacts
  // after a natural (user-triggered) compaction.
  isTransitioning(): boolean {
    return this.state !== "running";
  }

  // Compaction summary for the in-flight transition (empty when not transitioning).
  currentSummary(): string {
    return this.active?.summary ?? "";
  }

  // Outbound message fan-out. The ONLY path for main-session messaging.
  send(text: string, role: SendRole): void {
    if (role === "context") {
      this.host.rawSendUserMessage(text, "steer");
    } else {
      this.host.rawSendUserMessage(text, "followUp");
    }
  }

  // Like send, but for custom (non-LLM) messages (pp-context / pp-artifact).
  sendCustom(message: { customType: string; content: string; display: boolean; details?: unknown }, role: SendRole): void {
    this.host.rawSendMessage(message, role === "context" ? "steer" : "followUp");
  }

  // Request a transition. Returns a promise that resolves once the transition
  // has resumed (or finished, for done/stop). If the agent is already idle the
  // controller compacts immediately; otherwise it waits for agent_end.
  requestTransition(req: TransitionRequest): Promise<void> {
    const log = getLogger();
    if (this.state !== "running") {
      // A transition is already in flight. Coalesce: ignore the new request but
      // still attach the waiter so the caller is released when this settles.
      log.debug({ s: "controller", state: this.state, kind: req.kind }, "requestTransition while not running — coalescing");
      return new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active = req;
    this.state = "pending";
    log.debug({ s: "controller", kind: req.kind }, "transition pending");
    const promise = new Promise<void>((resolve) => this.waiters.push(resolve));
    // Already-idle path: no agent turn is in flight, so no agent_end will fire.
    // Compact immediately rather than waiting forever.
    if (this.host.isIdle()) {
      this.beginCompaction();
    }
    return promise;
  }

  // agent_end fires when the main loop goes idle. If a transition is pending,
  // this is the moment to compact. Repeated agent_end while running is a no-op
  // (prevents the self-trigger loop from injected followUp messages).
  onAgentEnd(): void {
    if (this.state !== "pending") return;
    this.beginCompaction();
  }

  // session_compact fires after compaction completes. Only advance the transition
  // we initiated (state must be compacting) — an unrelated/manual compaction
  // while running must not resume the wrong transition.
  onSessionCompact(): void {
    if (this.state !== "compacting") return;
    void this.resume();
  }

  private beginCompaction(): void {
    const req = this.active;
    if (!req) {
      this.state = "running";
      return;
    }
    this.state = "compacting";
    getLogger().debug({ s: "controller", kind: req.kind }, "compacting");
    const started = this.host.compact({
      customInstructions: req.summary,
      // onComplete is a fallback resume terminus; the authoritative one is the
      // session_compact event. Whichever lands first wins (resume is idempotent).
      onComplete: () => {
        if (this.state === "compacting") void this.resume();
      },
      onError: (err: Error) => {
        if (this.state !== "compacting") return;
        if (isCompactNoop(err)) {
          getLogger().debug({ s: "controller", err: err.message }, "compact no-op — resuming");
          void this.resume();
        } else {
          getLogger().error({ s: "controller", err: err.message }, "compact error — resuming anyway");
          void this.resume();
        }
      },
    });
    // host.compact returns false when no ctx is available (e.g. no live session);
    // treat as a no-op and resume so awaiting callers don't hang.
    if (!started) {
      void this.resume();
    }
  }

  private async resume(): Promise<void> {
    const req = this.active;
    this.state = "resuming";
    getLogger().debug({ s: "controller", kind: req?.kind }, "resuming");
    try {
      await req?.onResume?.();
    } catch (err: any) {
      getLogger().error({ s: "controller", err: err?.message ?? String(err) }, "onResume failed");
    }
    if (req?.instruction) {
      this.send(req.instruction, "instruction");
    }
    this.active = null;
    this.state = "running";
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
