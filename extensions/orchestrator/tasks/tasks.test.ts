import { describe, expect, it } from "vitest";
import { createCadenceState, drainReminder, isCommitCall, observeToolResult, onTurnStart, type CadenceState } from "./cadence.js";
import { registerTasks } from "./index.js";
import { createTask, emptySnapshot, replaySnapshot, updateTask } from "./state.js";
import { renderTasks } from "./widget.js";

function harness() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const sent: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  registerTasks(pi as any);
  const branch: any[] = [];
  const widgets = new Map<string, any>();
  const ctx = {
    hasUI: true,
    ui: { setWidget: (key: string, content: any) => (content ? widgets.set(key, content) : widgets.delete(key)) },
    sessionManager: { getBranch: () => branch },
  };
  const fire = async (event: string, payload: any = {}) => {
    let out: any;
    for (const handler of handlers.get(event) ?? []) out = (await handler(payload, ctx)) ?? out;
    return out;
  };
  // Records results on the branch the way the session would.
  const call = async (name: string, params: any) => {
    const result = await tools.get(name).execute("id", params, undefined, undefined, ctx);
    branch.push({ type: "message", message: { role: "toolResult", toolName: name, details: result.details, isError: result.isError === true } });
    await fire("tool_result", { toolName: name, input: params, details: result.details, isError: result.isError === true });
    return result;
  };
  const text = (result: any) => result.content[0].text as string;
  return { tools, fire, call, text, branch, widgets, sent, ctx };
}

const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~${text}~` };

describe("task state", () => {
  it("starts a fresh list once every task is completed", () => {
    const snapshot = emptySnapshot();
    createTask(snapshot, { subject: "a", description: "" });
    createTask(snapshot, { subject: "b", description: "" });
    updateTask(snapshot, "1", { status: "completed" }, 0);
    expect(createTask(snapshot, { subject: "c", description: "" }).rolledOver).toBe(0);
    updateTask(snapshot, "2", { status: "completed" }, 0);
    updateTask(snapshot, "3", { status: "completed" }, 0);
    const { task, rolledOver } = createTask(snapshot, { subject: "d", description: "" });
    expect(rolledOver).toBe(3);
    // Ids keep counting so a stale "#1" from earlier in the conversation cannot hit the new list.
    expect(snapshot.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(task.id).toBe("4");
  });

  it("accepts #-prefixed ids and deletes", () => {
    const snapshot = emptySnapshot();
    createTask(snapshot, { subject: "a", description: "" });
    expect(updateTask(snapshot, "#1", { status: "deleted" }, 0)?.changed).toEqual(["deleted"]);
    expect(snapshot.tasks).toEqual([]);
    expect(updateTask(snapshot, "1", { status: "completed" }, 0)).toBeUndefined();
  });

  it("replays the highest revision, not the last result recorded", () => {
    const older = emptySnapshot();
    createTask(older, { subject: "a", description: "" });
    const newer = structuredClone(older);
    updateTask(newer, "1", { status: "in_progress" }, 0);
    const entry = (snapshot: any) => ({ type: "message", message: { role: "toolResult", toolName: "TaskUpdate", details: { snapshot } } });
    expect(replaySnapshot([entry(newer), entry(older)]).tasks[0]!.status).toBe("in_progress");
  });

  it("ignores other tools' results and malformed details", () => {
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "read", details: { snapshot: { version: 1, tasks: [{ id: "9" }], nextId: 10, revision: 99 } } } },
      { type: "message", message: { role: "toolResult", toolName: "TaskList", details: undefined } },
      { type: "message", message: { role: "toolResult", toolName: "TaskList", details: { snapshot: { tasks: "nope" } } } },
    ];
    expect(replaySnapshot(branch)).toEqual(emptySnapshot());
  });
});

describe("task tools", () => {
  it("restores the list of the branch it lands on", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "first", description: "d" });
    const forkPoint = h.branch.length;
    await h.call("TaskCreate", { subject: "second", description: "d" });
    expect(h.text(await h.call("TaskList", {}))).toContain("#2 [pending] second");

    h.branch.splice(forkPoint);
    await h.fire("session_tree");
    const listed = h.text(await h.call("TaskList", {}));
    expect(listed).toContain("#1 [pending] first");
    expect(listed).not.toContain("second");
  });

  it("starts empty for a new session and restores on resume", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "kept", description: "d" });
    const saved = [...h.branch];
    h.branch.length = 0;
    await h.fire("session_start");
    expect(h.text(await h.call("TaskList", {}))).toBe("No tasks.");
    h.branch.splice(0, h.branch.length, ...saved);
    await h.fire("session_start");
    expect(h.text(await h.call("TaskList", {}))).toContain("kept");
  });

  it("reports an unknown id as an error with the current list", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "only", description: "d" });
    const result = await h.call("TaskUpdate", { taskId: "7", status: "completed" });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toContain("#1 [pending] only");
  });

  it("shows and hides the widget with the list", async () => {
    const h = harness();
    await h.fire("session_start");
    expect(h.widgets.has("tasks")).toBe(false);
    await h.call("TaskCreate", { subject: "a", description: "d" });
    expect(h.widgets.has("tasks")).toBe(true);
    await h.call("TaskUpdate", { taskId: "1", status: "deleted" });
    expect(h.widgets.has("tasks")).toBe(false);
    await h.fire("session_shutdown");
  });

  it("keeps the widget away when there is no UI", async () => {
    const h = harness();
    (h.ctx as any).hasUI = false;
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "d" });
    expect(h.widgets.size).toBe(0);
  });

  it("re-shows open tasks right after a compaction summary until a task result is back in view", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "open one", description: "d" });
    const summary = { role: "compactionSummary", summary: "s" };
    const user = { role: "user", content: "go on" };
    const out = await h.fire("context", { messages: [summary, user] });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1].content[0].text).toContain("#1 [pending] open one");
    expect(out.messages[2]).toBe(user);
    const shown = { role: "toolResult", toolName: "TaskList" };
    expect(await h.fire("context", { messages: [summary, user, shown] })).toBeUndefined();
    await h.call("TaskUpdate", { taskId: "1", status: "completed" });
    expect(await h.fire("context", { messages: [summary, user] })).toBeUndefined();
  });

  it("does not let a no-op update or a read silence the reminder", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "d" });
    for (let i = 0; i < 8; i++) await h.fire("tool_result", { toolName: "edit", input: {}, isError: false });
    await h.call("TaskUpdate", { taskId: "1", status: "pending" });
    await h.call("TaskList", {});
    expect((await h.fire("context", { messages: [] }))?.messages).toHaveLength(1);
  });

  it("forgets the abandoned branch's work when moving in the tree", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "d" });
    for (let i = 0; i < 8; i++) await h.fire("tool_result", { toolName: "edit", input: {}, isError: false });
    await h.fire("session_tree");
    expect(await h.fire("context", { messages: [] })).toBeUndefined();
  });

  it("appends a reminder to the request after sustained work, naming the stale task", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "write parser", description: "d" });
    await h.call("TaskUpdate", { taskId: "1", status: "in_progress" });
    for (let i = 0; i < 8; i++) await h.fire("tool_result", { toolName: "edit", input: {}, isError: false });
    const out = await h.fire("context", { messages: [{ role: "user", content: "hi" }] });
    const reminder = out.messages.at(-1).content[0].text;
    expect(reminder).toContain('#1 "write parser" is still marked in_progress');
    expect(await h.fire("context", { messages: [] })).toBeUndefined();
  });
});

describe("task reminder cadence", () => {
  const observe = (state: CadenceState, toolName: string, extra: Partial<{ changedTasks: boolean; hasTasks: boolean; isEdit: boolean; isCommit: boolean; isError: boolean }> = {}) =>
    observeToolResult(state, { toolName, changedTasks: false, hasTasks: true, isEdit: false, isCommit: false, isError: false, ...extra });
  const turns = (state: CadenceState, n: number) => { for (let i = 0; i < n; i++) onTurnStart(state); };

  it("fires on edits before the turn threshold would", () => {
    const state = createCadenceState();
    turns(state, 1);
    for (let i = 0; i < 8; i++) observe(state, "edit", { isEdit: true });
    expect(state.reminderDue).toBe(true);
  });

  it("fires on commits", () => {
    const state = createCadenceState();
    turns(state, 1);
    observe(state, "bash", { isCommit: true });
    observe(state, "bash", { isCommit: true });
    expect(state.reminderDue).toBe(true);
  });

  it("does not count failed edits", () => {
    const state = createCadenceState();
    for (let i = 0; i < 10; i++) observe(state, "edit", { isEdit: true, isError: true });
    expect(state.editsSinceMutation).toBe(0);
  });

  it("resets on a change to the list, not on a task tool call that changed nothing", () => {
    const state = createCadenceState();
    turns(state, 5);
    observe(state, "read");
    expect(state.reminderDue).toBe(true);
    observe(state, "TaskList");
    observe(state, "TaskGet");
    observe(state, "TaskUpdate");
    expect(state.reminderDue).toBe(true);
    observe(state, "TaskUpdate", { changedTasks: true });
    expect(state.reminderDue).toBe(false);
    expect(state.lastMutationTurn).toBe(5);
  });

  it("re-fires on fresh evidence after an ignored reminder, escalating", () => {
    const state = createCadenceState();
    const escalations: number[] = [];
    for (let i = 0; i < 3; i++) {
      turns(state, 5);
      observe(state, "bash");
      escalations.push(drainReminder(state)!.escalation);
    }
    expect(escalations).toEqual([1, 2, 3]);
  });

  it("fires on work with an empty list, but not on idle turns", () => {
    const idle = createCadenceState();
    turns(idle, 50);
    observe(idle, "read", { hasTasks: false });
    expect(idle.reminderDue).toBe(false);
    const busy = createCadenceState();
    turns(busy, 1);
    for (let i = 0; i < 8; i++) observe(busy, "edit", { hasTasks: false, isEdit: true });
    expect(busy.reminderDue).toBe(true);
  });

  it("reports the evidence and drains once", () => {
    const state = createCadenceState();
    turns(state, 3);
    for (let i = 0; i < 8; i++) observe(state, "edit", { isEdit: true });
    observe(state, "bash", { isCommit: true });
    expect(drainReminder(state)).toEqual({ edits: 8, commits: 1, turns: 3, escalation: 1 });
    expect(drainReminder(state)).toBeNull();
  });

  it("recognises commits", () => {
    expect(isCommitCall("bash", { command: "git -C x commit -m y" })).toBe(true);
    expect(isCommitCall("bash", { command: "git log" })).toBe(false);
    expect(isCommitCall("read", { command: "git commit" })).toBe(false);
  });
});

describe("task widget", () => {
  const many = (n: number) => {
    const snapshot = emptySnapshot();
    for (let i = 0; i < n; i++) createTask(snapshot, { subject: `Task ${i + 1}`, description: "" });
    return snapshot;
  };

  it("keeps to a share of a short terminal and scrolls to the first open task", () => {
    const snapshot = many(20);
    for (let i = 1; i <= 10; i++) updateTask(snapshot, String(i), { status: "completed" }, 0);
    const lines = renderTasks(snapshot.tasks, 200, 20, theme, 0);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toContain("20 tasks (10 done, 10 open)");
    expect(lines.some((line) => line.includes("#11 Task 11"))).toBe(true);
    expect(lines.some((line) => line.includes("10 earlier"))).toBe(true);
    expect(lines.at(-1)).toContain("more");
  });

  it("still shows one task between both markers on a tiny terminal", () => {
    const snapshot = many(20);
    for (let i = 1; i <= 10; i++) updateTask(snapshot, String(i), { status: "completed" }, 0);
    const lines = renderTasks(snapshot.tasks, 200, 5, theme, 0);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("#11");
  });

  it("shows everything when the terminal has room", () => {
    expect(renderTasks(many(15).tasks, 200, 80, theme, 0)).toHaveLength(16);
    expect(renderTasks(many(15).tasks, 200, undefined, theme, 0)).toHaveLength(16);
  });

  it("marks each status and times the active task", () => {
    const snapshot = many(3);
    updateTask(snapshot, "1", { status: "completed" }, 0);
    updateTask(snapshot, "2", { status: "in_progress", activeForm: "Doing two" }, 1000);
    const lines = renderTasks(snapshot.tasks, 200, undefined, theme, 66_000);
    expect(lines.slice(1)).toEqual(["  ✔ ~#1 Task 1~", "  ◼ #2 Doing two… (1m5s)", "  ◻ #3 Task 3"]);
  });
});

