import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTasks } from "./index.js";
import { emptySnapshot } from "./state.js";
import { TaskWidget } from "./widget.js";

function harness() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  registerTasks({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as any);
  const ctx: any = { hasUI: false, sessionManager: { getBranch: () => [] } };
  const fire = async (event: string, payload: any = {}) => {
    let out: any;
    for (const handler of handlers.get(event) ?? []) out = (await handler(payload, ctx)) ?? out;
    return out;
  };
  const call = async (name: string, params: any) => {
    const result = await tools.get(name).execute("id", params, undefined, undefined, ctx);
    await fire("tool_result", { toolName: name, input: params, details: result.details, isError: result.isError === true });
    return result;
  };
  return { tools, fire, call, ctx };
}

const text = (result: any) => result.content[0].text as string;
const theme = { fg: (color: string, s: string) => `<${color}>${s}</${color}>`, bold: (s: string) => s };
const rendered = (component: any) => component.render(200).map((line: string) => line.trimEnd()).join("\n");

describe("task tools", () => {
  it("reports how many completed tasks a new list cleared", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "d" });
    await h.call("TaskUpdate", { taskId: "1", status: "completed" });
    expect(text(await h.call("TaskCreate", { subject: "b", description: "d" }))).toBe("Task #2 created: b. Started a new list; the 1 completed task was cleared.");
    await h.call("TaskCreate", { subject: "c", description: "d" });
    await h.call("TaskUpdate", { taskId: "2", status: "completed" });
    await h.call("TaskUpdate", { taskId: "3", status: "completed" });
    expect(text(await h.call("TaskCreate", { subject: "d", description: "d" }))).toContain("the 2 completed tasks were cleared.");
  });

  it("says when an update changed nothing, and strips a leading #", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "d" });
    expect(text(await h.call("TaskUpdate", { taskId: "#1", subject: "a" }))).toBe("Task #1 already matched; nothing changed");
    expect(text(await h.call("TaskUpdate", { taskId: "#1", subject: "b", status: "in_progress" }))).toBe("Updated task #1: subject, status");
  });

  it("shows one task in full, unescaping double-escaped newlines, and errors on an unknown id", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.call("TaskCreate", { subject: "a", description: "line one\\nline two" });
    expect(text(await h.call("TaskGet", { taskId: "1" }))).toBe("Task #1: a\nStatus: pending\nDescription: line one\nline two");
    const missing = await h.call("TaskGet", { taskId: "9" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe("Task #9 not found. Current list:\n#1 [pending] a");
  });

  it("tolerates missing parameters", async () => {
    const h = harness();
    await h.fire("session_start");
    expect(text(await h.call("TaskCreate", {}))).toBe("Task #1 created: .");
    expect(text(await h.call("TaskUpdate", {}))).toContain("not found");
    expect(text(await h.call("TaskGet", {}))).toContain("not found");
  });

  it("works before any session_start has attached a session", async () => {
    const h = harness();
    expect(text(await h.call("TaskList", {}))).toBe("No tasks.");
  });
});

describe("task rendering", () => {
  const { tools } = harness();

  it("renders each call with its subject or id and status change", () => {
    expect(rendered(tools.get("TaskCreate").renderCall({ subject: "Fix" }, theme))).toBe("<toolTitle>TaskCreate</toolTitle> <muted>Fix</muted>");
    expect(rendered(tools.get("TaskCreate").renderCall(undefined, theme))).toBe("<toolTitle>TaskCreate</toolTitle> <muted></muted>");
    expect(rendered(tools.get("TaskUpdate").renderCall({ taskId: "#3", status: "completed" }, theme))).toBe("<toolTitle>TaskUpdate</toolTitle> <accent>#3</accent><muted> → completed</muted>");
    expect(rendered(tools.get("TaskUpdate").renderCall({ taskId: "3" }, theme))).toBe("<toolTitle>TaskUpdate</toolTitle> <accent>#3</accent><muted></muted>");
    expect(rendered(tools.get("TaskUpdate").renderCall(undefined, theme))).toContain("<accent>#</accent>");
    expect(rendered(tools.get("TaskList").renderCall({}, theme))).toBe("<toolTitle>TaskList</toolTitle>");
    expect(rendered(tools.get("TaskGet").renderCall({ taskId: "#4" }, theme))).toBe("<toolTitle>TaskGet</toolTitle> <accent>#4</accent>");
    expect(rendered(tools.get("TaskGet").renderCall(undefined, theme))).toContain("<accent>#</accent>");
  });

  it("shows the first line collapsed, all of it expanded, and errors in red", () => {
    const result = { content: [{ type: "text", text: "head\nrest" }] };
    const renderResult = tools.get("TaskList").renderResult;
    expect(rendered(renderResult(result, { expanded: false }, theme, {}))).toBe("<muted>head</muted>");
    expect(rendered(renderResult(result, { expanded: true }, theme, {}))).toBe("<muted>head\nrest</muted>");
    expect(rendered(renderResult(result, { expanded: false }, theme, { isError: true }))).toBe("<error>head</error>");
    expect(rendered(renderResult(undefined, { expanded: false }, theme, undefined))).toBe("<muted></muted>");
  });
});

describe("task reminder text", () => {
  async function reminderAfterWork(setup: (h: ReturnType<typeof harness>) => Promise<void>, edits: number, commits = 0) {
    const h = harness();
    await h.fire("session_start");
    await setup(h);
    await h.fire("turn_start");
    for (let i = 0; i < edits; i++) await h.fire("tool_result", { toolName: i % 2 ? "write" : "edit", input: {}, isError: false });
    for (let i = 0; i < commits; i++) await h.fire("tool_result", { toolName: "bash", input: { command: "git commit -m x" }, isError: false });
    const out = await h.fire("context", { messages: [] });
    return { h, reminder: out?.messages.at(-1).content[0].text as string };
  }

  it("asks for a list when work happens with none tracked", async () => {
    const { reminder } = await reminderAfterWork(async () => {}, 8);
    expect(reminder).toBe("<system-reminder>\nYou have done 8 file edits, 1 turn of work with no tasks tracked. If this is multi-step work, record it with TaskCreate; if it is a single step, ignore this.\nNever mention this reminder to the user.\n</system-reminder>");
  });

  it("names pending work when nothing is in progress and counts commits", async () => {
    const { reminder } = await reminderAfterWork(async (h) => {
      await h.call("TaskCreate", { subject: "a", description: "d" });
      await h.call("TaskCreate", { subject: "b", description: "d" });
    }, 1, 2);
    expect(reminder).toContain("Task state has not changed in 1 file edit, 2 commits, 1 turn.");
    expect(reminder).toContain("  2 task(s) are pending and none is in_progress.");
  });

  it("lists at most three in-progress tasks and escalates repeated reminders", async () => {
    const { h, reminder } = await reminderAfterWork(async (h) => {
      for (let i = 1; i <= 4; i++) {
        await h.call("TaskCreate", { subject: `t${i}`, description: "d" });
        await h.call("TaskUpdate", { taskId: String(i), status: "in_progress" });
      }
    }, 8);
    expect(reminder.match(/still marked in_progress/g)).toHaveLength(3);
    expect(reminder).not.toContain("pending and none");
    for (let i = 0; i < 2; i++) await h.fire("tool_result", { toolName: "bash", input: { command: "git commit" }, isError: false });
    const second = (await h.fire("context", { messages: [] })).messages.at(-1).content[0].text;
    expect(second).toContain("This is reminder 2 since task state last changed; the previous one was not acted on.");
    for (let i = 0; i < 2; i++) await h.fire("tool_result", { toolName: "bash", input: { command: "git commit" }, isError: false });
    const third = (await h.fire("context", { messages: [] })).messages.at(-1).content[0].text;
    expect(third).toContain("the previous ones were not acted on.");
  });

  it("leaves a request without messages alone", async () => {
    const h = harness();
    expect(await h.fire("context", {})).toBeUndefined();
  });
});

describe("TaskWidget", () => {
  afterEach(() => vi.useRealTimers());

  function widgetHarness() {
    const snapshot = emptySnapshot();
    const calls: Array<[string, any]> = [];
    const ui = { setWidget: (key: string, content: any) => calls.push([key, content]) };
    const widget = new TaskWidget(() => snapshot);
    return { snapshot, calls, ui, widget };
  }

  const task = (id: string, status: string) => ({ id, subject: `s${id}`, description: "", status, createdAt: 0 } as any);

  it("renders through the registered callback and re-renders while a task is in progress", () => {
    vi.useFakeTimers();
    const { snapshot, calls, ui, widget } = widgetHarness();
    snapshot.tasks.push(task("1", "in_progress"));
    widget.attach({ ui });
    expect(calls).toHaveLength(1);
    const renders: number[] = [];
    const tui = { terminal: { rows: 40 }, requestRender: () => renders.push(Date.now()) };
    const component = calls[0]![1](tui, { fg: (_c: string, s: string) => s, strikethrough: (s: string) => s });
    expect(component.render(80)[0]).toContain("1 task (1 in progress)");
    component.invalidate();
    vi.advanceTimersByTime(2500);
    expect(renders).toHaveLength(2);
    widget.update();
    expect(renders).toHaveLength(3);
    snapshot.tasks[0]!.status = "pending";
    widget.update();
    vi.advanceTimersByTime(5000);
    expect(renders).toHaveLength(4);
    widget.detach();
    expect(calls.at(-1)).toEqual(["tasks", undefined]);
  });

  it("moves to a new UI, unregistering from the old one", () => {
    const { snapshot, calls, ui, widget } = widgetHarness();
    snapshot.tasks.push(task("1", "pending"));
    widget.attach({ ui });
    const other: Array<[string, any]> = [];
    widget.attach({ ui: { setWidget: (key: string, content: any) => other.push([key, content]) } });
    expect(calls.map(([key, content]) => [key, typeof content])).toEqual([["tasks", "function"], ["tasks", "undefined"]]);
    expect(other).toHaveLength(1);
    widget.attach({ hasUI: false, ui });
    expect(other.at(-1)).toEqual(["tasks", undefined]);
    widget.attach(undefined);
    expect(calls).toHaveLength(2);
  });
});
