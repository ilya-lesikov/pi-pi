import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers, runUserGateDialog } from "./event-handlers.js";
import { loadTask } from "./state.js";

vi.mock("./cbm.js", () => ({ registerCbmTools: vi.fn() }));
vi.mock("./exa.js", () => ({ registerExaTools: vi.fn() }));
vi.mock("./ast-search.js", () => ({ registerAstSearchTool: vi.fn() }));
vi.mock("./agents/registry.js", () => ({
  registerAgentDefinitions: vi.fn(),
  unregisterAgentDefinitions: vi.fn(),
  setExtensionOnlyMode: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.js")>();
  return { ...original, loadConfig: vi.fn(() => ({
    mainModel: {
      implement: { model: "test/model", thinking: "high" },
      debug: { model: "test/model", thinking: "high" },
      brainstorm: { model: "test/model", thinking: "high" },
    },
    planners: { test: { enabled: true, model: "test/planner", thinking: "low" } },
    planReviewers: {},
    codeReviewers: { test: { enabled: true, model: "test/reviewer", thinking: "low" } },
    agents: {
      explore: { model: "test/explore", thinking: "low" },
      librarian: { model: "test/librarian", thinking: "medium" },
      task: { model: "test/task", thinking: "medium" },
    },
    commands: { afterEdit: [], afterImplement: [] },
    timeouts: { afterEdit: 1000, afterImplement: 1000, agentSpawn: 1000, agentReadyPing: 1000, lockStale: 600000, lockUpdate: 30000 },
    autoCommit: false,
  })) };
});

type Handler = (...args: any[]) => any;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-integration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePi() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler; description?: string }>();
  const tools = new Map<string, any>();

  const pi = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      }),
      emit: vi.fn((name: string, data?: any) => {
        const list = eventHandlers.get(name) ?? [];
        for (const h of list) h(data);
      }),
    },
    registerCommand: vi.fn((name: string, cmd: any) => {
      commands.set(name, cmd);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
    getAllTools: vi.fn().mockReturnValue([]),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    _handlers: handlers,
    _eventHandlers: eventHandlers,
    _commands: commands,
    _tools: tools,
  };

  return pi;
}

function makeConfig() {
  return {
    mainModel: {
      implement: { model: "test/model", thinking: "high" },
      debug: { model: "test/model", thinking: "high" },
      brainstorm: { model: "test/model", thinking: "high" },
    },
    planners: {
      test: { enabled: true, model: "test/planner", thinking: "low" },
    },
    planReviewers: {},
    codeReviewers: {
      test: { enabled: true, model: "test/reviewer", thinking: "low" },
    },
    agents: {
      explore: { model: "test/explore", thinking: "low" },
      librarian: { model: "test/librarian", thinking: "medium" },
      task: { model: "test/task", thinking: "medium" },
    },
    commands: { afterEdit: [], afterImplement: [] },
    timeouts: { afterEdit: 1000, afterImplement: 1000, agentSpawn: 1000, agentReadyPing: 1000, lockStale: 600000, lockUpdate: 30000 },
    autoCommit: false,
  };
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/project",
    hasUI: true,
    ui: {
      confirm: vi.fn(),
      select: vi.fn(),
      custom: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    abort: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn((opts?: any) => {
      if (opts?.onComplete) setTimeout(opts.onComplete, 0);
    }),
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue([
        { provider: "test", id: "model" },
      ]),
    },
    ...overrides,
  };
}

async function setupOrchestrator(cwd: string) {
  const pi = makePi();
  const orchestrator = new Orchestrator(pi as any);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);

  const sessionStartHandler = pi._handlers.get("session_start");
  if (sessionStartHandler) {
    await sessionStartHandler({}, makeCtx({ cwd }));
  }

  return { pi, orchestrator };
}

function getCommand(pi: ReturnType<typeof makePi>, name: string): Handler {
  const cmd = pi._commands.get(name);
  if (!cmd) throw new Error(`Command ${name} not registered`);
  return cmd.handler;
}

function getTool(pi: ReturnType<typeof makePi>, name: string): any {
  const tool = pi._tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function emitSubagentCreated(pi: ReturnType<typeof makePi>, id: string, description: string) {
  pi.events.emit("subagents:created", { id, description });
}

function emitSubagentCompleted(pi: ReturnType<typeof makePi>, id: string, description: string) {
  pi.events.emit("subagents:completed", { id, description, result: "done" });
}

function emitSubagentFailed(pi: ReturnType<typeof makePi>, id: string, error: string) {
  pi.events.emit("subagents:failed", { id, error });
}

describe("implement pipeline: brainstorm → plan → implement → done", () => {
  it("walks through the full implement pipeline with phase transitions", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Add feature X");

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.state.step).toBe("llm_work");
    expect(orchestrator.active!.type).toBe("implement");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "Add feature X to the system", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "## Affected Code\nsrc/main.ts\n## Recommended Approach\nDo it.", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result1 = await ppPhaseComplete.execute("call-1", { summary: "Research complete" }, undefined, undefined, ctx);
    expect(result1.content[0].text).toContain("Transitioned to plan");

    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("plan");

    const plansDir = join(taskDir, "plans");
    expect(existsSync(plansDir)).toBe(true);

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "# Plan\n- Do X\n- Do Y", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    expect(orchestrator.active!.state.step).toBe("synthesize");

    const synthPath = join(plansDir, `${Math.floor(Date.now() / 1000)}_synthesized.md`);
    writeFileSync(synthPath, "- [ ] Implement X\n- [ ] Implement Y\n", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve plan");

    const result2 = await ppPhaseComplete.execute("call-2", { summary: "Plan synthesized" }, undefined, undefined, ctx);
    expect(result2.content[0].text).toContain("Transitioned to implement");

    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");
    expect(orchestrator.active!.state.step).toBe("llm_work");

    const synthContent = readFileSync(synthPath, "utf-8");
    writeFileSync(synthPath, synthContent.replace(/- \[ \]/g, "- [x]"), "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve implementation");

    const result3 = await ppPhaseComplete.execute("call-3", { summary: "All items implemented" }, undefined, undefined, ctx);
    expect(result3.content[0].text).toContain("Task completed");

    expect(orchestrator.active).toBeNull();

    const finalState = loadTask(taskDir);
    expect(finalState.phase).toBe("done");
  });

  it("blocks brainstorm→plan transition without artifacts", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test task");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Transition blocked");
    expect(result.content[0].text).toContain("USER_REQUEST.md");
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
  });

  it("blocks implement→done transition with unchecked items", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test task");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [ ] Unchecked item\n", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    ctx.ui.select.mockResolvedValueOnce("Approve implementation");
    const result = await ppPhaseComplete.execute("call-3", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Transition blocked");
    expect(result.content[0].text).toContain("unchecked");
  });
});

describe("review cycle lifecycle", () => {
  it("auto review cycle: spawn → complete → apply_feedback → user gate", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test review");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [x] Done\n", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    ctx.ui.select.mockResolvedValueOnce("Automatic review");
    const result = await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Awaiting reviewers");

    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(orchestrator.active!.state.reviewCycle!.step).toBe("await_reviewers");
    expect(orchestrator.active!.state.reviewCycle!.pass).toBe(1);

    const reviewsDir = join(taskDir, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "LGTM", "utf-8");

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");
    expect(orchestrator.active!.state.step).toBe("apply_feedback");

    ctx.ui.select.mockResolvedValueOnce("Approve implementation");
    const result4 = await ppPhaseComplete.execute("call-4", { summary: "feedback applied" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(result4.content[0].text).toContain("Task completed");

    const finalState = loadTask(taskDir);
    expect(finalState.phase).toBe("done");
    expect(finalState.reviewPass).toBe(1);
    expect(finalState.reviewCycle).toBeNull();
  });

  it("review cycle completes even when all reviewers fail", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test failure");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [x] Done\n", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    ctx.ui.select.mockResolvedValueOnce("Automatic review");
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentFailed(pi, "reviewer-1", "model error");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");
  });

  it("zero enabled reviewers returns error without stalling", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test no reviewers");
    orchestrator.config = { ...orchestrator.config, codeReviewers: {} } as any;
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [x] Done\n", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    ctx.ui.select.mockResolvedValueOnce("Automatic review");
    const result = await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("No code reviewers enabled");
    expect(orchestrator.active!.state.reviewCycle).toBeNull();
  });
});

describe("subagent tracking", () => {
  it("blocks pp_phase_complete while subagents are running", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test blocking");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    emitSubagentCreated(pi, "explore-1", "Explore agent");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("subagent(s) still running");
  });

  it("pendingSubagentSpawns blocks pp_phase_complete", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test pending");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    orchestrator.pendingSubagentSpawns = 2;

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("subagent(s) still running");
  });

  it("abortAllSubagents resets pendingSubagentSpawns", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);

    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.pendingSubagentSpawns = 3;

    orchestrator.abortAllSubagents();

    expect(orchestrator.spawnedAgentIds.size).toBe(0);
    expect(orchestrator.pendingSubagentSpawns).toBe(0);
  });
});

describe("standalone brainstorm", () => {
  it("can finish without artifacts (escape hatch)", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");

    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.type).toBe("brainstorm");

    ctx.ui.select.mockResolvedValueOnce("Finish brainstorming");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "Explored ideas" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Brainstorm finished");

    expect(orchestrator.active).toBeNull();
  });

  it("offers 'Start implementation' when artifacts exist", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Start implementation");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "Conclusions ready" }, undefined, undefined, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("/pp:implement --from"),
    );
  });
});

describe("debug flow", () => {
  it("finishes debug and can start implementation", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Fix timeout bug");

    expect(orchestrator.active!.state.phase).toBe("debug");
    expect(orchestrator.active!.type).toBe("debug");

    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), "Fix the timeout", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "Root cause: missing retry logic", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Implement a fix");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "Diagnosis complete" }, undefined, undefined, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("/pp:implement --from"),
    );
  });
});

describe("planner completion tracking", () => {
  it("transitions await_planners → synthesize when all planners complete", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test planners");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    expect(orchestrator.pendingSubagentSpawns).toBe(0);

    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan content", "utf-8");

    emitSubagentCompleted(pi, "planner-1", "Planner (test)");
    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("transitions await_planners → synthesize when planner fails", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test planner fail");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    emitSubagentFailed(pi, "planner-1", "model error");

    expect(orchestrator.active!.state.step).toBe("synthesize");
  });
});

describe("pp:done cancellation", () => {
  it("marks task done and cleans up", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test done");
    const taskDir = orchestrator.active!.dir;

    const ppDone = getCommand(pi, "pp:done");
    await ppDone(undefined, ctx);

    expect(orchestrator.active).toBeNull();
    const state = loadTask(taskDir);
    expect(state.phase).toBe("done");
  });
});

describe("edge cases and regressions", () => {
  it("starting new task while another is active finishes the old one", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "First task");
    const firstDir = orchestrator.active!.dir;

    await orchestrator.startTask(ctx as any, "implement", "Second task");
    const secondDir = orchestrator.active!.dir;

    expect(firstDir).not.toBe(secondDir);
    expect(orchestrator.active!.description).toBe("Second task");

    const firstState = loadTask(firstDir);
    expect(firstState.phase).toBe("done");
  });

  it("pp:done during review cycle cleans up properly", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test review done");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [x] Done\n", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    ctx.ui.select.mockResolvedValueOnce("Automatic review");
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(orchestrator.spawnedAgentIds.size > 0 || orchestrator.pendingSubagentSpawns > 0).toBe(true);

    const ppDone = getCommand(pi, "pp:done");
    await ppDone(undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(orchestrator.spawnedAgentIds.size).toBe(0);
    expect(orchestrator.pendingSubagentSpawns).toBe(0);
  });

  it("multiple review passes increment reviewPass correctly", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Multi-review test");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [x] Done\n", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    ctx.ui.select.mockResolvedValueOnce("Automatic review");
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    const reviewsDir = join(taskDir, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "Needs fixes", "utf-8");

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");

    ctx.ui.select.mockResolvedValueOnce("Automatic review (pass 2)");
    await ppPhaseComplete.execute("call-4", { summary: "fixes applied" }, undefined, undefined, ctx);

    expect(orchestrator.active!.state.reviewPass).toBe(1);
    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(orchestrator.active!.state.reviewCycle!.pass).toBe(2);

    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-2.md`), "LGTM", "utf-8");

    emitSubagentCreated(pi, "reviewer-2", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-2", "Code reviewer (test)");

    ctx.ui.select.mockResolvedValueOnce("Approve implementation");
    const result = await ppPhaseComplete.execute("call-5", { summary: "all good" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Task completed");
    expect(orchestrator.active).toBeNull();

    const finalState = loadTask(taskDir);
    expect(finalState.reviewPass).toBe(2);
    expect(finalState.reviewCycle).toBeNull();
  });

  it("continue brainstorming sets step back to llm_work", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Continue test");

    ctx.ui.select.mockResolvedValueOnce("Continue brainstorming");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "not done yet" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.state.step).toBe("llm_work");
  });

  it("continue implementation sets step back to llm_work", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Continue impl test");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [ ] Todo\n", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve plan");
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    ctx.ui.select.mockResolvedValueOnce("Continue implementation");
    const result = await ppPhaseComplete.execute("call-3", { summary: "partial work" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("implement");
    expect(orchestrator.active!.state.step).toBe("llm_work");
  });

  it("review on my own sets step back to synthesize for plan phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Review own plan");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
    ctx.ui.select.mockResolvedValueOnce("Approve brainstorm");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "plan", "utf-8");
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), "- [ ] Todo\n", "utf-8");

    ctx.ui.select.mockResolvedValueOnce("Review on my own");
    const result = await ppPhaseComplete.execute("call-2", { summary: "plan ready" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("generic description task does not auto-trigger agent", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement");

    expect(ctx.ui.notify).toHaveBeenCalledWith("Task created. Describe what you'd like to do.", "info");
    const sendUserCalls = pi.sendUserMessage.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("Begin working"),
    );
    expect(sendUserCalls.length).toBe(0);
  });

  it("implement --from debug skips brainstorm", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), "Fix this bug", "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), "Root cause found", "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "Fix it", debugDir, true);

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(existsSync(join(orchestrator.active!.dir, "USER_REQUEST.md"))).toBe(true);
    expect(existsSync(join(orchestrator.active!.dir, "RESEARCH.md"))).toBe(true);
  });
});
