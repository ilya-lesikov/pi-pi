export type WorkerStatus = "queued" | "running" | "idle" | "completed" | "failed" | "stopped" | "killed";

export const ACTIVE_STATUSES: ReadonlySet<WorkerStatus> = new Set(["queued", "running"]);

export interface WorkerResult {
  status: "done" | "partial" | "blocked" | "unstructured";
  summary: string;
  body: string;
  findings?: WorkerFinding[];
  openQuestions?: string[];
}

export interface WorkerFinding {
  severity: "critical" | "major" | "minor";
  location: string;
  issue: string;
}

export interface WorkerQuestion {
  id: string;
  text: string;
  askedAt: number;
}

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface WorkerActivity {
  toolName: string;
  summary: string;
  startedAt: number;
}

/** What the manager needs from a running child session; the real one wraps a pi AgentSession. */
export interface WorkerSession {
  /** Runs one prompt to completion. Resolves when the session goes idle; may reject on provider errors. */
  run(prompt: string): Promise<void>;
  steer(message: string): void;
  /** Interrupts the tool call currently executing, if any. Returns whether one was interrupted. */
  interruptTool(): boolean;
  /** Asks the session to stop. Never awaited by the manager. */
  abort(): void;
  /** Synchronously tears the session down: kills child processes, drops listeners. */
  dispose(): void;
  setModel(spec: string): Promise<boolean>;
  /** The last assistant text produced by the most recent run. */
  lastAssistantText(): string;
  /** The error text of the most recent run's terminal assistant message, if it ended in an error. */
  lastError(): string | undefined;
  contextPercent(): number | undefined;
  transcript(): unknown[];
}

export interface WorkerStep {
  label: string;
  since: number;
}

export interface WorkerSessionHooks {
  /** A step of building or starting the session, before its first event. */
  onPhase(phase: string): void;
  /** What the running session is doing now: waiting for the model, thinking, running a tool… */
  onStep(label: string): void;
  /** Any token the model streamed; `tail` is the readable part (thinking or reply), if any. */
  onOutput(tail?: string): void;
  onEvent(): void;
  onToolStart(toolName: string, summary: string): void;
  onToolEnd(): void;
  onTurnEnd(): void;
  onUsage(usage: Partial<WorkerUsage>): void;
  onText(text: string): void;
  /** A message the session finished: the user prompt, a reply, a tool result. */
  onMessage?(message: unknown): void;
  /** Child tool: structured result. */
  submitResult(result: WorkerResult): void;
  /** Child tool: non-blocking progress note. */
  reportProgress(text: string): void;
  /** Child tool: blocking question. Resolves with the answer, or with undefined on timeout/abort. */
  askParent(text: string, signal: AbortSignal | undefined): Promise<string | undefined>;
}

export interface WorkerSpawnSpec {
  type: string;
  description: string;
  prompt: string;
  /** Concrete provider/model spec the definition resolved to. */
  model: string;
  thinking: string;
  notify: "wake" | "silent";
  resultSchema?: "findings";
  parentToolCallId?: string;
}

export type WorkerSessionFactory = (spec: WorkerSpawnSpec, hooks: WorkerSessionHooks) => Promise<WorkerSession>;

export interface WorkerRecord {
  id: string;
  spec: WorkerSpawnSpec;
  status: WorkerStatus;
  createdAt: number;
  /** Start of the current or most recent run. */
  startedAt?: number;
  settledAt?: number;
  lastEventAt: number;
  turns: number;
  toolUses: number;
  activity?: WorkerActivity;
  /** Set from the start of a run until the session's first event: the step it is in. */
  startPhase?: string;
  /** The current step of a running worker and when it began. */
  step?: WorkerStep;
  lastOutputAt?: number;
  /** The last few hundred characters of thinking or reply the model streamed. */
  outputTail: string;
  lastText: string;
  progress?: string;
  question?: WorkerQuestion;
  result?: WorkerResult;
  error?: string;
  /** Lifetime usage across every run of this worker. */
  usage: WorkerUsage;
  /** Usage of the current or most recent run only; what a settlement bills. */
  runUsage: WorkerUsage;
  modelId: string;
  /** How many times this record has been resumed after settling. */
  runs: number;
  /** A settlement not yet delivered to the parent. */
  undelivered: boolean;
  /** Set while agent_wait holds this id, so the push delivery does not duplicate it. */
  waitHolds: number;
  stallWarned: boolean;
}

export type WorkerEvent =
  | { type: "created"; record: WorkerRecord }
  | { type: "started"; record: WorkerRecord }
  | { type: "settled"; record: WorkerRecord }
  | { type: "question"; record: WorkerRecord }
  | { type: "stall_warning"; record: WorkerRecord }
  | { type: "phase"; record: WorkerRecord; phase: string }
  | { type: "changed"; record: WorkerRecord };
