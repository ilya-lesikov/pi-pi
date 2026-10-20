/**
 * When to remind the model that its task list has drifted from its work.
 *
 * The clock is work, not turns alone: edits and commits since the last task
 * mutation. Reading the list is not maintaining it, an ignored reminder comes
 * back on fresh evidence rather than latching off, and sustained work with an
 * empty list is reported too — that is the drift that goes unnoticed longest.
 */

export interface CadenceState {
  currentTurn: number;
  lastMutationTurn: number;
  editsSinceMutation: number;
  commitsSinceMutation: number;
  editsSinceReminder: number;
  commitsSinceReminder: number;
  turnsSinceReminder: number;
  /** Reminders delivered without a mutation in between. */
  consecutiveReminders: number;
  reminderDue: boolean;
}

export interface ToolObservation {
  toolName: string;
  /** For a task tool: whether the call actually changed the list. */
  changedTasks: boolean;
  hasTasks: boolean;
  isEdit: boolean;
  isCommit: boolean;
  isError: boolean;
}

export interface ReminderEvidence {
  edits: number;
  commits: number;
  turns: number;
  /** 1 for the first reminder since a mutation, growing while ignored. */
  escalation: number;
}

const TURN_INTERVAL = 4;
const EDIT_INTERVAL = 8;
const COMMIT_INTERVAL = 2;
const TASK_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "todo"]);

export function createCadenceState(): CadenceState {
  return {
    currentTurn: 0,
    lastMutationTurn: 0,
    editsSinceMutation: 0,
    commitsSinceMutation: 0,
    editsSinceReminder: 0,
    commitsSinceReminder: 0,
    turnsSinceReminder: 0,
    consecutiveReminders: 0,
    reminderDue: false,
  };
}

export function onTurnStart(state: CadenceState): void {
  state.currentTurn++;
  state.turnsSinceReminder++;
}

export function observeToolResult(state: CadenceState, observation: ToolObservation): void {
  if (TASK_TOOLS.has(observation.toolName)) {
    if (observation.changedTasks) Object.assign(state, createCadenceState(), { currentTurn: state.currentTurn, lastMutationTurn: state.currentTurn });
    return;
  }
  if (!observation.isError) {
    if (observation.isEdit) {
      state.editsSinceMutation++;
      state.editsSinceReminder++;
    }
    if (observation.isCommit) {
      state.commitsSinceMutation++;
      state.commitsSinceReminder++;
    }
  }
  if (state.reminderDue) return;
  const delivered = state.consecutiveReminders > 0;
  const turns = delivered ? state.turnsSinceReminder : state.currentTurn - state.lastMutationTurn;
  const edits = delivered ? state.editsSinceReminder : state.editsSinceMutation;
  const commits = delivered ? state.commitsSinceReminder : state.commitsSinceMutation;
  if (edits < EDIT_INTERVAL && commits < COMMIT_INTERVAL && turns < TURN_INTERVAL) return;
  if (!observation.hasTasks && edits === 0 && commits === 0) return;
  state.reminderDue = true;
}

/** Takes the pending reminder, if any, for the request about to be sent. */
export function drainReminder(state: CadenceState): ReminderEvidence | null {
  if (!state.reminderDue) return null;
  state.reminderDue = false;
  state.consecutiveReminders++;
  state.editsSinceReminder = 0;
  state.commitsSinceReminder = 0;
  state.turnsSinceReminder = 0;
  return {
    edits: state.editsSinceMutation,
    commits: state.commitsSinceMutation,
    turns: state.currentTurn - state.lastMutationTurn,
    escalation: state.consecutiveReminders,
  };
}

export function isCommitCall(toolName: string, input: unknown): boolean {
  if (toolName !== "bash" && toolName !== "powershell") return false;
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && /\bgit\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*commit\b/.test(command);
}
