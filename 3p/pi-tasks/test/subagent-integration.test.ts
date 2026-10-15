/**
 * Tests for task-subagent integration: TaskExecute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances.
beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

// ---- Mock pi ----

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

/** Minimal mock ExtensionContext. */
function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

// ---- Mock pi-pi workers handle ----

const WORKERS_KEY = Symbol.for("pi-pi:workers");

/** Stands in for pi-pi's typed workers handle on globalThis. */
function installSubagentsMock(_pi?: unknown, opts?: { spawnError?: string }) {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];
  const stopped: string[] = [];
  const listeners = new Set<(settled: any) => void>();
  (globalThis as any)[WORKERS_KEY] = {
    spawn(request: { type: string; prompt: string; description: string; owner: string; maxTurns?: number }) {
      if (opts?.spawnError) return { error: opts.spawnError };
      const id = `agent-${++idCounter}`;
      spawned.push({ id, type: request.type, prompt: request.prompt, options: { description: request.description, owner: request.owner, maxTurns: request.maxTurns } });
      return { id };
    },
    stop(id: string) {
      if (!spawned.some((entry) => entry.id === id)) return false;
      stopped.push(id);
      return true;
    },
    onSettled(listener: (settled: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    spawned,
    stopped,
    settle(id: string, status: string, extra: { result?: string; error?: string } = {}) {
      const owner = spawned.find((entry) => entry.id === id)?.options.owner ?? "pi-tasks";
      for (const listener of [...listeners]) listener({ id, owner, status, ...extra });
    },
    unsub() { delete (globalThis as any)[WORKERS_KEY]; },
  };
}

// ---- Tests ----

describe("TaskExecute", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    // Install mock BEFORE init so ping reply is received during extension init
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("is registered as a tool", () => {
    expect(mock.tools.has("TaskExecute")).toBe(true);
  });

  it("returns error when subagent extension is not loaded", async () => {
    // Re-init without the handle to simulate missing workers
    rpc.unsub();
    const freshMock = mockPi();
    initExtension(freshMock.pi as any);

    await freshMock.executeTool("TaskCreate", {
      subject: "Test task",
      description: "Do something",
      agentType: "general-purpose",
    });

    const result = await freshMock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
  });

  it("rejects non-existent tasks", async () => {
    const result = await mock.executeTool("TaskExecute", { task_ids: ["999"] });
    expect(result.content[0].text).toContain("#999: not found");
  });

  it("rejects tasks without agentType", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Plain task",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: no agentType set");
  });

  it("rejects non-pending tasks", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Already started",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: not pending");
  });

  it("rejects tasks with unresolved blockers", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Blocked",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("#2: blocked by #1");
  });

  it("spawns agent for valid task and updates metadata", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(result.content[0].text).toContain("#1 → agent agent-1");

    // Verify the RPC responder was called
    expect(rpc.spawned).toHaveLength(1);
    expect(rpc.spawned[0].type).toBe("general-purpose");
    expect(rpc.spawned[0].prompt).toContain("Run the test suite");
    expect(rpc.spawned[0].options.owner).toBe("pi-tasks");
  });

  it("passes additional_context and max_turns to spawned agents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Explore codebase",
      description: "Find all API endpoints",
      agentType: "Explore",
    });

    await mock.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
      max_turns: 10,
    });

    expect(rpc.spawned[0].prompt).toContain("Focus on REST endpoints only");
    expect(rpc.spawned[0].options.maxTurns).toBe(10);
  });

  it("allows executing tasks whose blockers are all completed", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
  });

  it("handles mixed valid and invalid tasks in one call", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Valid",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Desc",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1", "2", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("Launched 1 agent");
    expect(text).toContain("#2: no agentType set");
    expect(text).toContain("#999: not found");
  });
});

describe("TaskExecute with workers published late", () => {
  it("finds the handle when it is published after tasks init", async () => {
    // Init tasks WITHOUT the handle — pi-pi's workers not available yet
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Now publish the handle (pi-pi loading later)
    const rpc = installSubagentsMock(mock.pi);

    // Create a task and execute — should work because ready was received
    await mock.executeTool("TaskCreate", {
      subject: "Late-loaded test",
      description: "Desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(rpc.spawned).toHaveLength(1);

    rpc.unsub();
  });
});

describe("Completion listener", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("marks task completed on subagents:completed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent completion
    rpc.settle("agent-1", "completed");

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("reverts task to pending on subagents:failed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Failing task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent failure
    rpc.settle("agent-1", "failed", { error: "Out of turns" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("ignores events for unknown agent IDs", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Unrelated",
      description: "Desc",
    });

    // Should not throw or modify anything
    rpc.settle("unknown-agent", "completed");
    rpc.settle("unknown-agent", "failed", { error: "boom" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });
});

describe("Auto-cascade", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("does NOT cascade when auto-cascade is off (default)", async () => {
    // Create A → B chain
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    // Execute A
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Complete A
    rpc.settle("agent-1", "completed");

    // B should NOT have been auto-started
    expect(rpc.spawned).toHaveLength(1);

    // B should still be pending
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("does NOT cascade on failure (branch stops)", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    rpc.settle("agent-1", "failed", { error: "crashed" });

    // B should not start
    expect(rpc.spawned).toHaveLength(1);
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("tasks without agentType are not cascaded even if unblocked", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Manual task",
      description: "Desc",
      // No agentType — manual
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    rpc.settle("agent-1", "completed");

    // Manual task should stay pending
    expect(rpc.spawned).toHaveLength(1);
  });
});


describe("Standalone operation (no subagents extension)", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(() => {
    // Init WITHOUT installSubagentsMock — no subagents extension present
    mock = mockPi();
    initExtension(mock.pi as any);
  });

  it("all core task tools are registered", () => {
    for (const name of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskExecute"]) {
      expect(mock.tools.has(name)).toBe(true);
    }
  });

  it("TaskCreate works without subagents", async () => {
    const result = await mock.executeTool("TaskCreate", {
      subject: "Write tests",
      description: "Add unit tests for the parser",
    });
    expect(result.content[0].text).toContain("Write tests");
  });

  it("TaskList works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "A", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "desc" });
    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toContain("#1");
    expect(result.content[0].text).toContain("#2");
  });

  it("TaskGet works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Read me", description: "details here" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Read me");
    expect(result.content[0].text).toContain("details here");
  });

  it("TaskUpdate works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Update me", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("in_progress");
  });

  it("TaskExecute gracefully refuses without subagents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "desc",
      agentType: "general-purpose",
    });
    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
  });

  it("task dependencies work without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "First", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Blocked by");
    expect(result.content[0].text).toContain("#1");
  });
});

describe("Workers handle", () => {
  afterEach(() => { delete (globalThis as any)[WORKERS_KEY]; });

  it("ignores settlements of workers it did not start", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Mine", description: "desc", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    rpc.settle("agent-1", "completed");
    rpc.settle("ghost-agent", "failed", { error: "boom" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("finds the handle when it is published after a refusal", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Test", description: "desc", agentType: "general-purpose" });
    let result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");

    const rpc = installSubagentsMock(mock.pi);
    result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(rpc.spawned).toHaveLength(1);
  });

  it("reports a refused spawn and leaves the task pending", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi, { spawnError: "No active session" });
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Err test", description: "desc", agentType: "general-purpose" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("No active session");
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: pending");
  });

  it("stops the task's worker", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Stoppable", description: "desc", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");
    expect(rpc.stopped).toContain("agent-1");
  });

  it("stops a task whose worker is already gone without throwing", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Ghost", description: "desc", agentType: "general-purpose" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress", metadata: { agentType: "general-purpose", agentId: "ghost-agent" } });

    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");
  });

  it("TaskOutput waits for the worker to settle, bounded by its timeout", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Wait", description: "desc", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const pending = mock.executeTool("TaskOutput", { task_id: "1", block: true, timeout: 60_000 });
    rpc.settle("agent-1", "completed", { result: "done" });
    const result = await pending;
    expect(result.content[0].text).toContain("[completed]");

    await mock.executeTool("TaskCreate", { subject: "Slow", description: "desc", agentType: "general-purpose" });
    await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    const timed = await mock.executeTool("TaskOutput", { task_id: "2", block: true, timeout: 10 });
    expect(timed.content[0].text).toContain("[in_progress]");
  });
});

describe("Widget agent ID display", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  function mockUICtx() {
    const state = {
      widgets: new Map<string, any>(),
      statuses: new Map<string, string | undefined>(),
    };
    const ctx: UICtx = {
      setWidget(key, content, options) { state.widgets.set(key, { content, options }); },
      setStatus(key, text) { state.statuses.set(key, text); },
    };
    return { ctx, state };
  }

  function mockTheme(): Theme {
    return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    };
  }

  function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
    const entry = state.widgets.get("tasks");
    if (!entry?.content) return [];
    const theme = mockTheme();
    const tui = { terminal: { columns: 200 } };
    return entry.content(tui, theme).render();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows agent ID for active agent-backed tasks", () => {
    store.create("Agent task", "Desc", "Running tests", { agentType: "general-purpose", agentId: "abc1234567890" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent abc12");
    expect(lines[1]).toContain("Running tests");
  });

  it("shows agent ID for non-active in_progress agent-backed tasks", () => {
    store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "xyz9876543210" });
    store.update("1", { status: "in_progress" });
    // NOT calling setActiveTask — simulates external agent management
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent xyz98");
    expect(lines[1]).toContain("Agent task");
  });

  it("does not show agent ID for tasks without agentId", () => {
    store.create("Manual task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent");
    expect(lines[1]).toContain("Manual task");
  });

  it("does not show agent ID for pending tasks", () => {
    store.create("Pending agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });

  it("does not show agent ID for completed tasks", () => {
    store.create("Done", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });
});

describe("Cascade data injection (buildTaskPrompt)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    // Enable autoCascade via config file in cwd
    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(process.cwd(), ".pi", "tasks-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ autoCascade: true }));

    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Set latestCtx via turn_start lifecycle event
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(async () => {
    rpc.unsub();
    const fs = await import("node:fs");
    const path = await import("node:path");
    try { fs.unlinkSync(path.join(process.cwd(), ".pi", "tasks-config.json")); } catch {}
  });

  it("injects prerequisite result into cascaded agent prompt", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use Task A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    rpc.settle("agent-1", "completed", { result: "The answer is 42" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("Prerequisite task results");
    expect(bPrompt).toContain("Task #1");
    expect(bPrompt).toContain("The answer is 42");
  });

  it("truncates long prerequisite results at 4KB", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a long result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use truncated result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const longResult = "x".repeat(5000);
    rpc.settle("agent-1", "completed", { result: longResult });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("truncated");
    expect(bPrompt).toContain("TaskGet");
    expect(bPrompt.length).toBeLessThan(longResult.length);
  });

  it("handles dependencies with no stored result gracefully", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "No result stored",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Works without A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    rpc.settle("agent-1", "completed");

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).not.toContain("Prerequisite task results");
  });
});
