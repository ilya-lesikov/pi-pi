export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  /** When the task last moved to in_progress; drives the widget's elapsed time. */
  startedAt?: number;
}

/** The whole list, carried in every task tool result so any branch point can be restored from the session. */
export interface TaskSnapshot {
  version: 1;
  tasks: Task[];
  nextId: number;
  /**
   * Grows with every change. Parallel tool calls in one message can finish in a
   * different order than their results are recorded, so the newest state is the
   * highest revision on the branch, not the last result.
   */
  revision: number;
}

/** "todo" is the same tools as one, registered under Paseo. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "todo"]);

export function emptySnapshot(): TaskSnapshot {
  return { version: 1, tasks: [], nextId: 1, revision: 0 };
}

export function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return { version: 1, tasks: snapshot.tasks.map((task) => ({ ...task })), nextId: snapshot.nextId, revision: snapshot.revision };
}

function isSnapshot(value: any): value is TaskSnapshot {
  return value?.version === 1 && Array.isArray(value.tasks) && typeof value.nextId === "number" && typeof value.revision === "number";
}

/** The newest list recorded on the branch; entries before a compaction count too. */
export function replaySnapshot(branch: readonly any[]): TaskSnapshot {
  let newest: TaskSnapshot | undefined;
  for (const entry of branch) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || !TASK_TOOL_NAMES.has(message.toolName)) continue;
    const snapshot = message.details?.snapshot;
    if (isSnapshot(snapshot) && (!newest || snapshot.revision >= newest.revision)) newest = snapshot;
  }
  return newest ? cloneSnapshot(newest) : emptySnapshot();
}

/**
 * Adds a task. Once every task on the list is completed, the next one starts a
 * fresh list: the finished ones are dropped rather than left to crowd it.
 */
export function createTask(snapshot: TaskSnapshot, fields: { subject: string; description: string; activeForm?: string }): { task: Task; rolledOver: number } {
  const finished = snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === "completed");
  const rolledOver = finished ? snapshot.tasks.length : 0;
  if (finished) snapshot.tasks = [];
  const task: Task = { id: String(snapshot.nextId++), subject: fields.subject, description: fields.description, status: "pending" };
  if (fields.activeForm) task.activeForm = fields.activeForm;
  snapshot.tasks.push(task);
  snapshot.revision++;
  return { task, rolledOver };
}

export interface TaskUpdateFields {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
}

/** Applies the fields that differ; `deleted` removes the task. Returns undefined for an unknown id. */
export function updateTask(snapshot: TaskSnapshot, id: string, fields: TaskUpdateFields, now: number): { changed: string[] } | undefined {
  const index = snapshot.tasks.findIndex((task) => task.id === normalizeId(id));
  if (index === -1) return undefined;
  const task = snapshot.tasks[index]!;
  if (fields.status === "deleted") {
    snapshot.tasks.splice(index, 1);
    snapshot.revision++;
    return { changed: ["deleted"] };
  }
  const changed: string[] = [];
  for (const key of ["subject", "description", "activeForm"] as const) {
    if (fields[key] !== undefined && fields[key] !== task[key]) {
      task[key] = fields[key];
      changed.push(key);
    }
  }
  if (fields.status && fields.status !== task.status) {
    task.status = fields.status;
    if (fields.status === "in_progress") task.startedAt = now;
    else delete task.startedAt;
    changed.push("status");
  }
  if (changed.length) snapshot.revision++;
  return { changed };
}

export function findTask(snapshot: TaskSnapshot, id: string): Task | undefined {
  return snapshot.tasks.find((task) => task.id === normalizeId(id));
}

/** Models write "#3" as often as "3". */
function normalizeId(id: string): string {
  return String(id).trim().replace(/^#/, "");
}
