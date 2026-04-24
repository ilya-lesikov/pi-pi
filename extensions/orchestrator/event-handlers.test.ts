import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerEventHandlers } from "./event-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  return {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        eventHandlers.set(name, handler);
      }),
      emit: vi.fn(),
    },
    getAllTools: vi.fn().mockReturnValue([{ name: "lsp" }]),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    _handlers: handlers,
    _eventHandlers: eventHandlers,
  };
}

function makeConfig() {
  return {
    mainModel: {
      implement: { model: "a/b", thinking: "high" },
      debug: { model: "a/b", thinking: "high" },
      brainstorm: { model: "a/b", thinking: "high" },
    },
    planners: {},
    planReviewers: {},
    codeReviewers: {},
    agents: {
      explore: { model: "x/e", thinking: "low" },
      librarian: { model: "x/l", thinking: "medium" },
      task: { model: "x/t", thinking: "medium" },
    },
    commands: { afterEdit: [], afterImplement: [] },
    timeouts: { afterEdit: 1, afterImplement: 1, agentSpawn: 1, agentReadyPing: 1, lockStale: 1, lockUpdate: 1 },
    autoCommit: false,
  };
}

function makeActiveTask(): ActiveTask {
  return {
    dir: "/tmp/task",
    type: "implement",
    state: { phase: "implementation", from: null, description: "Test", startedAt: new Date().toISOString() },
    release: null,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewRound: 1,
    description: "Test",
  };
}

let pi: ReturnType<typeof makePi>;
let orchestrator: Orchestrator;

beforeEach(() => {
  pi = makePi();
  orchestrator = new Orchestrator(pi as any);
  orchestrator.cwd = "/project";
  orchestrator.config = makeConfig() as any;
  registerEventHandlers(orchestrator);
});

function getHandler(name: string): Handler {
  const h = pi._handlers.get(name);
  if (!h) throw new Error(`No handler for ${name}`);
  return h;
}

describe("tool_call write protection", () => {
  it("blocks non-.md writes to .pp/state/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/state/implement/123/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "Cannot write non-.md files in .pp/state/" });
  });

  it("blocks state.json writes under .pp/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { path: ".pp/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "state.json is managed by the extension" });
  });

  it("blocks config.json writes under .pp/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/config.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "config.json is managed by the user, not the LLM" });
  });

  it("allows .md writes to .pp/state/ when input uses path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { path: ".pp/state/implement/123/plans/synthesized.md" } },
      {},
    );
    expect(result).toBeUndefined();
  });

  it("backward compatibility: blocks using file_path field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "write", input: { file_path: ".pp/state/implement/123/state.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "Cannot write non-.md files in .pp/state/" });
  });

  it("backward compatibility: blocks using filePath field", async () => {
    const handler = getHandler("tool_call");
    const result = await handler(
      { toolName: "edit", input: { filePath: ".pp/config.json" } },
      {},
    );
    expect(result).toEqual({ block: true, reason: "config.json is managed by the user, not the LLM" });
  });
});

describe("tool_result implementation tracking", () => {
  it("adds file to modifiedFiles when input uses path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "write", input: { path: "src/index.ts" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.has("src/index.ts")).toBe(true);
  });

  it("skips .pp/ paths in modified-file tracking", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "write", input: { path: ".pp/state/plans/plan.md" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.size).toBe(0);
  });

  it("appends LSP nudge when input uses path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    const result = await handler(
      { toolName: "edit", input: { path: "src/foo.ts" }, isError: false, content: [{ type: "text", text: "ok" }] },
      {},
    );
    expect(result?.content).toBeDefined();
    const lastContent = result.content[result.content.length - 1];
    expect(lastContent.text).toContain("lsp diagnostics");
    expect(lastContent.text).toContain("src/foo.ts");
  });

  it("backward compatibility: tracks file using file_path field", async () => {
    orchestrator.active = makeActiveTask();
    const handler = getHandler("tool_result");
    await handler(
      { toolName: "edit", input: { file_path: "src/bar.ts" }, isError: false, content: [] },
      {},
    );
    expect(orchestrator.active.modifiedFiles.has("src/bar.ts")).toBe(true);
  });
});
