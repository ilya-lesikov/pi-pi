import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCadenceState, drainReminder, isCommitCall, observeToolResult, onTurnStart, type ReminderEvidence } from "./cadence.js";
import { cloneSnapshot, createTask, emptySnapshot, findTask, replaySnapshot, TASK_TOOL_NAMES, updateTask, type Task, type TaskSnapshot } from "./state.js";
import { TaskWidget } from "./widget.js";
import { taskBoardText } from "./board.js";

const EDITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

const CREATE_DESCRIPTION = `Create a task in your checklist for the current request. The user sees the list above the editor.

Use it for work with 3 or more distinct steps, when the user gives several things to do, or to capture new instructions that arrive mid-work. Skip it for a single straightforward step or a purely conversational request.

- subject: brief imperative title ("Fix authentication bug in login flow")
- description: what needs to be done and how you will know it is done
- activeForm: present continuous form shown while it is in progress ("Fixing authentication bug")

Tasks start as pending. Once every task on the list is completed, the next TaskCreate starts a fresh list.`;

const UPDATE_DESCRIPTION = `Update a task in your checklist.

- Mark a task in_progress BEFORE you start working on it, and completed as soon as it is fully done. Do not batch completions.
- Mark completed only when the work is actually done: not while tests fail, the implementation is partial, or errors are unresolved. If blocked, keep it in_progress and create a task for the blocker.
- Set status to deleted for a task that is no longer relevant or was created in error.
- subject, description and activeForm can be changed when the work becomes clearer.`;

const LIST_DESCRIPTION = "List every task in your checklist with its id and status. Use it when you have lost track of the list, e.g. after a long stretch of work.";

const GET_DESCRIPTION = "Show one task from your checklist in full, including its description.";

interface TaskToolDetails {
  snapshot: TaskSnapshot;
  [paseo: string]: unknown;
}

/**
 * pi-pi's checklist: TaskCreate/TaskUpdate/TaskList/TaskGet on the root
 * session. Every result carries the whole list, so a resumed, forked or
 * rewound session restores the list as it stood at that point of the branch.
 */
export function registerTasks(pi: ExtensionAPI, onWidgetRegistered?: () => void): void {
  let snapshot = emptySnapshot();
  let cadence = createCadenceState();
  let lastObservedRevision = snapshot.revision;
  const widget = new TaskWidget(() => snapshot, onWidgetRegistered);

  // Under Paseo the four tools are one tool named "todo", whose results Paseo
  // draws as its own todo card when they carry the shape it knows.
  const paseo = !!process.env.PASEO_AGENT_ID;
  const result = (text: string, isError = false, call?: { action: string; params: Record<string, unknown> }) => ({
    content: [{ type: "text" as const, text }],
    details: {
      snapshot: cloneSnapshot(snapshot),
      ...(paseo && call ? paseoTodo(snapshot, call.action, call.params, isError ? text : undefined) : {}),
    } satisfies TaskToolDetails,
    ...(isError ? { isError: true } : {}),
  });
  // Apps that do not show pi-pi's widget see the list here, each time it changes.
  const withBoard = (text: string) => `${text}\n${taskBoardText(snapshot.tasks)}`;
  const create = (params: any) => {
    const { task, rolledOver } = createTask(snapshot, { subject: String(params.subject ?? ""), description: String(params.description ?? ""), activeForm: params.activeForm });
    widget.update();
    const fresh = rolledOver ? ` Started a new list; the ${rolledOver} completed task${rolledOver === 1 ? " was" : "s were"} cleared.` : "";
    return result(withBoard(`Task #${task.id} created: ${task.subject}.${fresh}`), false, { action: "create", params });
  };
  const update = (params: any) => {
    const outcome = updateTask(snapshot, String(params.taskId ?? ""), params, Date.now());
    if (!outcome) return result(`Task #${params.taskId} not found. Current list:\n${listText(snapshot.tasks)}`, true, { action: "update", params });
    widget.update();
    const id = String(params.taskId).replace(/^#/, "");
    return result(withBoard(outcome.changed.length ? `Updated task #${id}: ${outcome.changed.join(", ")}` : `Task #${id} already matched; nothing changed`), false, { action: "update", params });
  };
  const list = () => result(listText(snapshot.tasks), false, { action: "list", params: {} });
  const get = (params: any) => {
    const task = findTask(snapshot, String(params.taskId ?? ""));
    if (!task) return result(`Task #${params.taskId} not found. Current list:\n${listText(snapshot.tasks)}`, true, { action: "get", params });
    // Models sometimes double-escape newlines inside JSON strings.
    return result(`Task #${task.id}: ${task.subject}\nStatus: ${task.status}\nDescription: ${task.description.replace(/\\n/g, "\n")}`, false, { action: "get", params });
  };
  const restore = (ctx: any) => {
    snapshot = replaySnapshot(ctx.sessionManager?.getBranch?.() ?? []);
    lastObservedRevision = snapshot.revision;
    widget.attach(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    cadence = createCadenceState();
    restore(ctx);
  });
  // Another branch has its own history of work; counters from the abandoned one do not apply.
  pi.on("session_tree", async (_event, ctx) => {
    cadence = createCadenceState();
    restore(ctx);
  });
  pi.on("session_shutdown", async () => widget.detach());
  pi.on("turn_start", async () => onTurnStart(cadence));
  pi.on("tool_result", async (event: any) => {
    const revision = event.details?.snapshot?.revision;
    observeToolResult(cadence, {
      toolName: event.toolName,
      changedTasks: event.isError !== true && typeof revision === "number" && revision !== lastObservedRevision,
      hasTasks: snapshot.tasks.length > 0,
      isEdit: EDITING_TOOLS.has(event.toolName),
      isCommit: isCommitCall(event.toolName, event.input),
      isError: event.isError === true,
    });
    if (typeof revision === "number") lastObservedRevision = revision;
  });
  // Transient: added to this request only, never stored in the session. Runs
  // after promptcap has folded the request, so promptcap's notion of the last
  // user message, which bounds what it may fold, stays the user's own.
  pi.on("context", async (event: any) => {
    if (!Array.isArray(event?.messages)) return undefined;
    let messages: any[] = event.messages;
    const compacted = restoredListAt(messages);
    if (compacted !== undefined && snapshot.tasks.some((task) => task.status !== "completed")) {
      // Right after the summary, so the prompt prefix stays the same from request to request.
      messages = [...messages.slice(0, compacted + 1), userText(`Your task list (the results that showed it were compacted away):\n${listText(snapshot.tasks)}`), ...messages.slice(compacted + 1)];
    }
    const evidence = drainReminder(cadence);
    if (evidence) messages = [...messages, userText(renderReminder(evidence, snapshot.tasks, paseo))];
    return messages === event.messages ? undefined : { messages };
  });

  if (paseo) {
    registerTodoTool(pi, { create, update, list, get });
    return;
  }

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: CREATE_DESCRIPTION,
    parameters: Type.Object({
      subject: Type.String({ description: "A brief imperative title for the task" }),
      description: Type.String({ description: "What needs to be done and how you will know it is done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in progress (e.g. 'Running tests')" })),
    }),
    async execute(_id, params: any) {
      return create(params);
    },
    renderCall: (args: any, theme: any) => new Text(`${theme.fg("toolTitle", theme.bold("TaskCreate"))} ${theme.fg("muted", String(args?.subject ?? ""))}`, 0, 0),
    renderResult: renderResultLine,
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: UPDATE_DESCRIPTION,
    parameters: Type.Object({
      taskId: Type.String({ description: "The id of the task to update" }),
      status: Type.Optional(STATUS),
      subject: Type.Optional(Type.String({ description: "New subject" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      activeForm: Type.Optional(Type.String({ description: "New present continuous form" })),
    }),
    async execute(_id, params: any) {
      return update(params);
    },
    renderCall: (args: any, theme: any) => {
      const change = args?.status ? ` → ${args.status}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("TaskUpdate"))} ${theme.fg("accent", `#${String(args?.taskId ?? "").replace(/^#/, "")}`)}${theme.fg("muted", change)}`, 0, 0);
    },
    renderResult: renderResultLine,
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: LIST_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      return list();
    },
    renderCall: (_args: any, theme: any) => new Text(theme.fg("toolTitle", theme.bold("TaskList")), 0, 0),
    renderResult: renderResultLine,
  });

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: GET_DESCRIPTION,
    parameters: Type.Object({ taskId: Type.String({ description: "The id of the task to show" }) }),
    async execute(_id, params: any) {
      return get(params);
    },
    renderCall: (args: any, theme: any) => new Text(`${theme.fg("toolTitle", theme.bold("TaskGet"))} ${theme.fg("accent", `#${String(args?.taskId ?? "").replace(/^#/, "")}`)}`, 0, 0),
    renderResult: renderResultLine,
  });
}

const STATUS = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")], { description: "New status; deleted removes the task" });

const TODO_DESCRIPTION = `Your task checklist for the current request: create, update, list or get tasks. The user sees the list.

Use it for work with 3 or more distinct steps, when the user gives several things to do, or to capture new instructions that arrive mid-work. Skip it for a single straightforward step or a purely conversational request.

- action "create": subject (brief imperative title), description (what needs to be done and how you will know it is done), activeForm (present continuous, shown while in progress). Tasks start as pending; once every task is completed, the next create starts a fresh list.
- action "update": taskId plus what changed. Mark a task in_progress BEFORE you start it and completed as soon as it is fully done, not while tests fail or work is partial. Set status deleted for a task no longer relevant.
- action "list": every task with its id and status.
- action "get": one task in full.`;

/** The same four operations as one tool named "todo", the name Paseo draws as a todo card. */
function registerTodoTool(pi: ExtensionAPI, ops: { create(p: any): any; update(p: any): any; list(): any; get(p: any): any }): void {
  pi.registerTool({
    name: "todo",
    label: "todo",
    description: TODO_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("list"), Type.Literal("get")]),
      taskId: Type.Optional(Type.String({ description: "update/get: the id of the task" })),
      subject: Type.Optional(Type.String({ description: "create/update: a brief imperative title" })),
      description: Type.Optional(Type.String({ description: "create/update: what needs to be done and how you will know it is done" })),
      activeForm: Type.Optional(Type.String({ description: "create/update: present continuous form shown while in progress" })),
      status: Type.Optional(STATUS),
    }),
    async execute(_id, params: any) {
      switch (params?.action) {
        case "create": return ops.create(params);
        case "update": return ops.update(params);
        case "get": return ops.get(params);
        default: return ops.list();
      }
    },
    renderCall: (args: any, theme: any) => new Text(`${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("muted", `${args?.action ?? ""}${args?.taskId ? ` #${String(args.taskId).replace(/^#/, "")}` : ""}${args?.subject ? ` ${args.subject}` : ""}`)}`, 0, 0),
    renderResult: renderResultLine,
  });
}

/** The result shape Paseo's todo mapper reads; task ids must be numbers there. */
function paseoTodo(snapshot: TaskSnapshot, action: string, params: Record<string, unknown>, error?: string) {
  return {
    action,
    params,
    nextId: snapshot.nextId,
    tasks: snapshot.tasks.map((task) => ({ id: Number(task.id), subject: task.subject, status: task.status, ...(task.activeForm ? { activeForm: task.activeForm } : {}) })),
    ...(error ? { error } : {}),
  };
}

function renderResultLine(result: any, options: { expanded: boolean }, theme: any, context: any): Text {
  const text = result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
  const shown = options.expanded ? text : text.split("\n")[0];
  return new Text(context?.isError ? theme.fg("error", shown) : theme.fg("muted", shown), 0, 0);
}

/**
 * Where the list must be re-shown: right after the compaction summary, when no
 * task tool result survived the compaction to show it.
 */
function restoredListAt(messages: readonly any[]): number | undefined {
  let summary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "compactionSummary") {
      summary = i;
      break;
    }
    if (message?.role === "toolResult" && TASK_TOOL_NAMES.has(message.toolName)) return undefined;
  }
  return summary === -1 ? undefined : summary;
}

function userText(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function listText(tasks: readonly Task[]): string {
  if (!tasks.length) return "No tasks.";
  return tasks.map((task) => `#${task.id} [${task.status}] ${task.subject}`).join("\n");
}

function renderReminder(evidence: ReminderEvidence, tasks: readonly Task[], todoTool = false): string {
  const create = todoTool ? "todo with action create" : "TaskCreate";
  const update = todoTool ? "todo with action update" : "TaskUpdate";
  const work = [
    evidence.edits ? `${evidence.edits} file edit${evidence.edits === 1 ? "" : "s"}` : "",
    evidence.commits ? `${evidence.commits} commit${evidence.commits === 1 ? "" : "s"}` : "",
    `${evidence.turns} turn${evidence.turns === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
  const lines: string[] = [];
  if (evidence.escalation > 1) lines.push(`This is reminder ${evidence.escalation} since task state last changed; the previous ${evidence.escalation === 2 ? "one was" : "ones were"} not acted on.`);
  if (!tasks.length) {
    lines.push(`You have done ${work} of work with no tasks tracked. If this is multi-step work, record it with ${create}; if it is a single step, ignore this.`);
  } else {
    lines.push(`Task state has not changed in ${work}.`);
    const inProgress = tasks.filter((task) => task.status === "in_progress");
    for (const task of inProgress.slice(0, 3)) lines.push(`  #${task.id} "${task.subject}" is still marked in_progress.`);
    const pending = tasks.filter((task) => task.status === "pending").length;
    if (!inProgress.length && pending) lines.push(`  ${pending} task(s) are pending and none is in_progress.`);
    lines.push(`Update what actually changed: ${update} to completed for finished work, in_progress for what you are on now. If the list no longer reflects the work, correct it.`);
  }
  lines.push("Never mention this reminder to the user.");
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}
