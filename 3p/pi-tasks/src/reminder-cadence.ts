/**
 * Pure cadence logic for the system-reminder injection.
 *
 * Decisions are made here as plain functions so they're easy to unit-test
 * without spinning up the whole extension. The default export of the
 * extension wires these into the `tool_result` and `context` hooks.
 *
 * LOCAL PATCH (pi-pi): rewritten from a turn-counting cadence to one driven by
 * observed work. The original had three defects, each proven by a test below:
 *
 *   • It fired at most once per session. `reminderInjectedThisCycle` latched on
 *     delivery and cleared only on a task-tool call or a session reset, so an
 *     agent that ignored the first reminder was never reminded again — the
 *     agent most in need of the mechanism was the one it gave up on.
 *   • Reading the list counted as maintaining it. TaskList/TaskGet/TaskOutput
 *     reset the timer, so glancing at a stale list silenced the reminder whose
 *     job was to report that staleness.
 *   • An empty list was silent forever, making "no checklist was ever made" —
 *     the most common drift — structurally unreachable.
 *
 * Turns were also the wrong clock: a turn is one read or twenty minutes of
 * debugging. Cadence now counts edits and commits since the last task
 * *mutation*, and escalates instead of latching.
 */

/** Internal cadence state. Plain object so it round-trips through tests. */
export interface CadenceState {
  currentTurn: number;
  /** Turn of the last task-tool call that actually changed task state. */
  lastTaskMutationTurn: number;
  /** File-modifying tool calls since the last task mutation. */
  editsSinceMutation: number;
  /** Commits observed since the last task mutation. */
  commitsSinceMutation: number;
  /** Work counted since the last reminder was delivered. */
  editsSinceReminder: number;
  commitsSinceReminder: number;
  turnsSinceReminder: number;
  /** How many reminders have been delivered without an intervening mutation. */
  consecutiveReminders: number;
  reminderDue: boolean;
}

export interface CadenceConfig {
  /** Turns without a task mutation before a reminder is considered due. */
  reminderInterval: number;
  /** Edits without a task mutation before a reminder is considered due. */
  editInterval: number;
  /** Commits without a task mutation before a reminder is considered due. */
  commitInterval: number;
  /** Task tools that change state. Only these reset cadence. */
  mutatingTaskTools: ReadonlySet<string>;
  /** Task tools that only read. These are explicitly NOT cadence resets. */
  readOnlyTaskTools: ReadonlySet<string>;
  /** Tools whose successful use counts as a file modification. */
  editingTools: ReadonlySet<string>;
}

export function createCadenceState(): CadenceState {
  return {
    currentTurn: 0,
    lastTaskMutationTurn: 0,
    editsSinceMutation: 0,
    commitsSinceMutation: 0,
    editsSinceReminder: 0,
    commitsSinceReminder: 0,
    turnsSinceReminder: 0,
    consecutiveReminders: 0,
    reminderDue: false,
  };
}

export function resetCadenceState(state: CadenceState): void {
  Object.assign(state, createCadenceState());
}

/** Increment the turn counter at `turn_start`. */
export function onTurnStart(state: CadenceState): void {
  state.currentTurn++;
  state.turnsSinceReminder++;
}

export interface ToolResultDecision {
  /** True when caller should mark `reminderDue` for the next `context` event. */
  markDue: boolean;
}

export interface ToolObservation {
  toolName: string;
  /** Whether any task currently exists. Drives which drift is reported. */
  hasTasks: boolean;
  /** Whether the call modified a file (caller classifies; see editingTools). */
  isEdit?: boolean;
  /** Whether the call produced a commit. */
  isCommit?: boolean;
  /** Whether the call failed — a failed edit is not work that changed anything. */
  isError?: boolean;
}

/**
 * Decide what cadence change a tool result implies. Mutates `state` in place
 * and returns whether the reminder should be queued for the next LLM call.
 *
 * A mutating task tool resets everything: that is the agent doing the thing the
 * reminder exists to ask for. A read-only task tool changes nothing — looking
 * is not maintaining.
 */
export function evaluateToolResult(
  state: CadenceState,
  observation: ToolObservation,
  config: CadenceConfig,
): ToolResultDecision {
  const { toolName, hasTasks } = observation;

  if (config.mutatingTaskTools.has(toolName)) {
    state.lastTaskMutationTurn = state.currentTurn;
    state.editsSinceMutation = 0;
    state.commitsSinceMutation = 0;
    state.editsSinceReminder = 0;
    state.commitsSinceReminder = 0;
    state.turnsSinceReminder = 0;
    state.consecutiveReminders = 0;
    state.reminderDue = false;
    return { markDue: false };
  }

  if (config.readOnlyTaskTools.has(toolName)) return { markDue: false };

  if (!observation.isError) {
    if (observation.isEdit || config.editingTools.has(toolName)) {
      state.editsSinceMutation++;
      state.editsSinceReminder++;
    }
    if (observation.isCommit) {
      state.commitsSinceMutation++;
      state.commitsSinceReminder++;
    }
  }

  if (state.reminderDue) return { markDue: false };

  // Measured from the last reminder once one has been delivered, so an ignored
  // reminder returns on fresh evidence rather than latching off forever.
  const delivered = state.consecutiveReminders > 0;
  const turns = delivered ? state.turnsSinceReminder : state.currentTurn - state.lastTaskMutationTurn;
  const edits = delivered ? state.editsSinceReminder : state.editsSinceMutation;
  const commits = delivered ? state.commitsSinceReminder : state.commitsSinceMutation;

  const due =
    edits >= config.editInterval ||
    commits >= config.commitInterval ||
    turns >= config.reminderInterval;
  if (!due) return { markDue: false };

  // An empty list is the loudest case, not the silent one: sustained work with
  // nothing tracked is the drift that goes unnoticed longest.
  if (!hasTasks && edits === 0 && commits === 0) return { markDue: false };

  state.reminderDue = true;
  return { markDue: true };
}

/** What the reminder must describe. Text lives in the extension, not here. */
export interface ReminderEvidence {
  edits: number;
  commits: number;
  turns: number;
  /** 1 for the first reminder since a mutation, growing while ignored. */
  escalation: number;
}

/**
 * Drain the pending reminder when `context` fires. Returns the evidence the
 * caller should render, or null when nothing is due.
 */
export function drainReminderForContext(state: CadenceState): ReminderEvidence | null {
  if (!state.reminderDue) return null;
  state.reminderDue = false;
  state.consecutiveReminders++;

  const evidence: ReminderEvidence = {
    edits: state.editsSinceMutation,
    commits: state.commitsSinceMutation,
    turns: state.currentTurn - state.lastTaskMutationTurn,
    escalation: state.consecutiveReminders,
  };

  state.editsSinceReminder = 0;
  state.commitsSinceReminder = 0;
  state.turnsSinceReminder = 0;

  return evidence;
}
