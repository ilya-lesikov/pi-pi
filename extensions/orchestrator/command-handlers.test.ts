import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommandHandlers } from "./command-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";

vi.mock("./event-handlers.js", () => ({
  runUserGateDialog: vi.fn().mockResolvedValue("User wants to continue. Run /pp:next when ready to advance."),
}));

import { runUserGateDialog } from "./event-handlers.js";

type Handler = (args: string | undefined, ctx: any) => any;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-cmd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(runUserGateDialog).mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makePi() {
  const commands = new Map<string, { handler: Handler }>();
  return {
    registerCommand: vi.fn((name: string, cmd: { handler: Handler }) => {
      commands.set(name, cmd);
    }),
    on: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
    getAllTools: vi.fn().mockReturnValue([]),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    _commands: commands,
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
    codeReviewers: { variant1: { enabled: true, model: "x/1", thinking: "low" } },
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

function makeActiveTask(taskDir: string): ActiveTask {
  const stateDir = join(taskDir, "plans");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "1_synthesized.md"), "- [x] done\n", "utf-8");
  writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
  writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
  return {
    dir: taskDir,
    type: "implement",
    state: {
      phase: "implement",
      step: "user_gate",
      reviewCycle: null,
      reviewPass: 1,
      from: null,
      description: "Test",
      startedAt: new Date().toISOString(),
    },
    release: null,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewPass: 1,
    description: "Test",
  };
}

function makeCtx() {
  return {
    ui: {
      confirm: vi.fn(),
      select: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    abort: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn(),
  };
}

describe("pp:next user gate", () => {
  it("routes pp:next to shared user gate dialog", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveTask(taskDir);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(runUserGateDialog).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("User wants to continue. Run /pp:next when ready to advance.", "info");
  });

  it("returns error when no active task", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    orchestrator.cwd = makeTempDir();
    orchestrator.config = makeConfig() as any;
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No active task.", "error");
    expect(runUserGateDialog).not.toHaveBeenCalled();
  });

  it("passes standard summary text to user gate dialog", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveTask(taskDir);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(runUserGateDialog).toHaveBeenCalledWith(orchestrator, ctx, "Choose next action");
  });
});
