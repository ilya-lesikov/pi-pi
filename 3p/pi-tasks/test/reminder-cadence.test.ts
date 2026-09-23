// LOCAL PATCH (pi-pi): rewritten alongside src/reminder-cadence.ts.
//
// The upstream suite asserted the three defects as intended behavior — that the
// reminder does not re-fire within a cycle, that any task tool (including a
// read) resets cadence, and that an empty list stays silent. Those cases are
// replaced here by their inverses, each of which fails against the original.

import { beforeEach, describe, expect, it } from "vitest";

import {
  type CadenceConfig,
  type CadenceState,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "../src/reminder-cadence.js";

const config: CadenceConfig = {
  reminderInterval: 4,
  editInterval: 8,
  commitInterval: 2,
  mutatingTaskTools: new Set(["TaskCreate", "TaskUpdate", "TaskExecute", "TaskStop"]),
  readOnlyTaskTools: new Set(["TaskList", "TaskGet", "TaskOutput"]),
  editingTools: new Set(["edit", "write"]),
};

describe("reminder cadence (pure)", () => {
  let state: CadenceState;

  beforeEach(() => {
    state = createCadenceState();
  });

  function advanceTurns(n: number): void {
    for (let i = 0; i < n; i++) onTurnStart(state);
  }

  function work(state: CadenceState, toolName: string, hasTasks: boolean) {
    return evaluateToolResult(state, { toolName, hasTasks }, config);
  }

  it("starts with reminder not due", () => {
    expect(state.reminderDue).toBe(false);
    expect(drainReminderForContext(state)).toBeNull();
  });

  it("marks reminder due after the turn interval with no task mutation", () => {
    advanceTurns(5);
    expect(work(state, "read", true).markDue).toBe(true);
    expect(state.reminderDue).toBe(true);
  });

  it("does NOT mark reminder due before any threshold is crossed", () => {
    advanceTurns(2);
    expect(work(state, "read", true).markDue).toBe(false);
  });

  it("fires on accumulated edits before the turn threshold would", () => {
    // Eight edits inside two turns: turn-based cadence would still be silent.
    advanceTurns(2);
    let due = false;
    for (let i = 0; i < 8; i++) due = work(state, "edit", true).markDue || due;
    expect(due).toBe(true);
    expect(state.editsSinceMutation).toBe(8);
  });

  it("fires on commits, which signal finished work most strongly", () => {
    advanceTurns(1);
    let due = false;
    for (let i = 0; i < 2; i++) {
      due = evaluateToolResult(state, { toolName: "bash", hasTasks: true, isCommit: true }, config).markDue || due;
    }
    expect(due).toBe(true);
  });

  it("a failed edit is not counted as work", () => {
    advanceTurns(1);
    for (let i = 0; i < 10; i++) {
      evaluateToolResult(state, { toolName: "edit", hasTasks: true, isError: true }, config);
    }
    expect(state.editsSinceMutation).toBe(0);
  });

  it("a mutating task tool resets cadence and clears any pending reminder", () => {
    advanceTurns(5);
    work(state, "read", true);
    expect(state.reminderDue).toBe(true);

    expect(work(state, "TaskUpdate", true).markDue).toBe(false);
    expect(state.reminderDue).toBe(false);
    expect(state.consecutiveReminders).toBe(0);
    expect(state.lastTaskMutationTurn).toBe(state.currentTurn);
  });

  // Replaces upstream "task tool usage resets cadence": reading is not
  // maintaining, and treating it as such silenced the reminder on a glance.
  it("a read-only task tool does NOT reset cadence or clear a pending reminder", () => {
    advanceTurns(5);
    work(state, "read", true);
    expect(state.reminderDue).toBe(true);

    for (const tool of ["TaskList", "TaskGet", "TaskOutput"]) {
      work(state, tool, true);
      expect(state.reminderDue).toBe(true);
    }
    expect(state.lastTaskMutationTurn).toBe(0);
  });

  // Replaces upstream "does not re-fire within the same injection cycle": an
  // ignored reminder previously latched off for the rest of the session.
  it("re-fires on fresh evidence after an ignored reminder, and escalates", () => {
    advanceTurns(5);
    work(state, "read", true);
    expect(drainReminderForContext(state)?.escalation).toBe(1);

    advanceTurns(5);
    work(state, "bash", true);
    expect(drainReminderForContext(state)?.escalation).toBe(2);

    advanceTurns(5);
    work(state, "bash", true);
    expect(drainReminderForContext(state)?.escalation).toBe(3);
  });

  it("keeps reminding for as long as work continues without a mutation", () => {
    let fired = 0;
    for (let i = 0; i < 100; i++) {
      onTurnStart(state);
      work(state, "bash", true);
      if (drainReminderForContext(state)) fired++;
    }
    // The original fired exactly once across the same 100 turns.
    expect(fired).toBeGreaterThan(10);
  });

  // Replaces upstream "does NOT mark reminder due when no tasks exist".
  it("fires on sustained work with an empty task list", () => {
    advanceTurns(1);
    let due = false;
    for (let i = 0; i < 8; i++) due = work(state, "edit", false).markDue || due;
    expect(due).toBe(true);
  });

  it("stays silent on an empty list when nothing has actually been done", () => {
    advanceTurns(50);
    expect(work(state, "read", false).markDue).toBe(false);
  });

  it("drainReminderForContext is a one-shot per queued reminder", () => {
    advanceTurns(5);
    work(state, "read", true);
    expect(drainReminderForContext(state)).not.toBeNull();
    expect(drainReminderForContext(state)).toBeNull();
  });

  it("reports the evidence the reminder must cite", () => {
    advanceTurns(3);
    for (let i = 0; i < 8; i++) work(state, "edit", true);
    evaluateToolResult(state, { toolName: "bash", hasTasks: true, isCommit: true }, config);

    const evidence = drainReminderForContext(state);
    expect(evidence).toEqual({ edits: 8, commits: 1, turns: 3, escalation: 1 });
  });

  it("resetCadenceState wipes everything", () => {
    advanceTurns(20);
    work(state, "edit", true);
    drainReminderForContext(state);

    resetCadenceState(state);
    expect(state).toEqual(createCadenceState());
  });
});
