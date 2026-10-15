export type WorkerStatus = "queued" | "running" | "idle" | "completed" | "failed" | "stopped" | "killed" | "stalled" | "timed_out";

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

export interface WorkerSessionHooks {
  onEvent(): void;
  onToolStart(toolName: string, summary: string): void;
  onToolEnd(): void;
  onTurnEnd(): void;
  onUsage(usage: Partial<WorkerUsage>): void;
  onText(text: string): void;
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
  maxTurns?: number;
  timeoutMs?: number;
  notify: "wake" | "silent";
  resultSchema?: "findings";
  parentToolCallId?: string;
  /** Opaque tag for an owner other than the root model, e.g. a pi-tasks task id. */
  owner?: string;
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
  | { type: "changed"; record: WorkerRecord };
