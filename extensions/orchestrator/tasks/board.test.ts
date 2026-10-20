import { afterEach, describe, expect, it } from "vitest";
import { taskBoard, taskBoardText } from "./board.js";
import { registerTasks } from "./index.js";
import { replaySnapshot } from "./state.js";
import type { Task } from "./state.js";

const task = (id: number, status: Task["status"], subject = `task ${id}`, activeForm?: string): Task => ({ id: String(id), subject, description: "", status, ...(activeForm ? { activeForm } : {}) });

describe("taskBoard", () => {
  it("counts every state, lists running then pending, and only counts done", () => {
    const board = taskBoard([task(1, "completed"), task(2, "pending"), task(3, "in_progress", "Fix it", "Fixing it"), task(4, "pending")]);
    expect(board.counts).toEqual([{ kind: "running", n: 1 }, { kind: "pending", n: 2 }, { kind: "done", n: 1 }]);
    expect(board.rows.map((row) => row.text)).toEqual(["#3 Fixing it", "#2 task 2", "#4 task 4"]);
  });

  it("caps the rows and says what the last row hides", () => {
    const tasks = [task(1, "in_progress"), ...Array.from({ length: 8 }, (_, i) => task(i + 2, "pending"))];
    const board = taskBoard(tasks);
    expect(board.rows).toHaveLength(5);
    expect(board.rows.at(-1)).toEqual({ kind: "more", text: "… 5 more pending" });
    expect(taskBoard(tasks.slice(0, 5)).rows.every((row) => row.kind !== "more")).toBe(true);
  });

  it("renders the plain text other apps see", () => {
    expect(taskBoardText([task(1, "completed"), task(2, "in_progress", "Ship", "Shipping")])).toBe("Tasks • 1 running • 1 done\n  ◐ #2 Shipping");
    expect(taskBoardText([])).toBe("Tasks • none");
  });
});

describe("under Paseo", () => {
  afterEach(() => { delete process.env.PASEO_AGENT_ID; });

  function harness() {
    process.env.PASEO_AGENT_ID = "a";
    const tools = new Map<string, any>();
    registerTasks({ registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} } as any);
    return tools;
  }

  it("offers one todo tool instead of four, with the result shape Paseo draws as a todo card", async () => {
    const tools = harness();
    expect([...tools.keys()]).toEqual(["todo"]);
    const todo = tools.get("todo");
    await todo.execute("1", { action: "create", subject: "Write tests", description: "d", activeForm: "Writing tests" });
    const result = await todo.execute("2", { action: "update", taskId: "1", status: "in_progress" });
    expect(result.details).toMatchObject({
      action: "update",
      params: { taskId: "1", status: "in_progress" },
      nextId: 2,
      tasks: [{ id: 1, subject: "Write tests", status: "in_progress", activeForm: "Writing tests" }],
    });
    expect(result.content[0].text).toBe("Updated task #1: status\nTasks • 1 running\n  ◐ #1 Writing tests");
    // A resumed session restores the list from todo results too.
    const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: result.details } }];
    expect(replaySnapshot(branch).tasks[0]!.status).toBe("in_progress");
  });

  it("marks a failed call as an error Paseo leaves off the card", async () => {
    const todo = harness().get("todo");
    const result = await todo.execute("1", { action: "update", taskId: "9", status: "completed" });
    expect(result.isError).toBe(true);
    expect(result.details.error).toMatch(/^Task #9 not found/);
  });
});
