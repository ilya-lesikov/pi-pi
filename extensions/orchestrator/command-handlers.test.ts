import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommandHandlers } from "./command-handlers.js";
import { Orchestrator, type ActiveTask } from "./orchestrator.js";

vi.mock("./phases/review.js", () => ({
  spawnCodeReviewers: vi.fn().mockResolvedValue(undefined),
}));

import { spawnCodeReviewers } from "./phases/review.js";

type Handler = (args: string | undefined, ctx: any) => any;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-cmd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(spawnCodeReviewers).mockClear();
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
    injectAgentsMd: false,
    maxAutoReviewRounds: 3,
  };
}

function makeActiveReviewTask(taskDir: string, reviewRound = 1): ActiveTask {
  const stateDir = join(taskDir, "plans");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "1_synthesized.md"), "- [x] done\n", "utf-8");
  writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
  writeFileSync(join(taskDir, "RESEARCH.md"), "research", "utf-8");
  return {
    dir: taskDir,
    type: "implement",
    state: { phase: "review", from: null, description: "Test", startedAt: new Date().toISOString() },
    release: null,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewRound,
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

describe("pp:next review-round orchestration", () => {
  it("triggers a second review round when user declines approval and confirms new round", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveReviewTask(taskDir, 1);
    orchestrator.persistReviewRound = vi.fn();
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();
    ctx.ui.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(spawnCodeReviewers).toHaveBeenCalledOnce();
    expect(orchestrator.active!.reviewRound).toBe(2);
    expect(orchestrator.persistReviewRound).toHaveBeenCalledOnce();
    expect(orchestrator.active!.state.phase).toBe("review");
  });

  it("enforces maxAutoReviewRounds and falls back to manual review", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveReviewTask(taskDir, 4);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(false);

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(spawnCodeReviewers).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Auto-review round limit reached"),
      "warning",
    );
    expect(orchestrator.active!.state.phase).toBe("review");
  });

  it("increments reviewRound and persists state on new round", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveReviewTask(taskDir, 2);
    orchestrator.persistReviewRound = vi.fn();
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();
    ctx.ui.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(orchestrator.active!.reviewRound).toBe(3);
    expect(orchestrator.persistReviewRound).toHaveBeenCalledOnce();
  });

  it("falls back to manual review when user declines new round", async () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    const taskDir = makeTempDir();
    orchestrator.cwd = taskDir;
    orchestrator.config = makeConfig() as any;
    orchestrator.active = makeActiveReviewTask(taskDir, 1);
    registerCommandHandlers(orchestrator);

    const ctx = makeCtx();
    ctx.ui.confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const ppNext = pi._commands.get("pp:next");
    await ppNext!.handler(undefined, ctx);

    expect(spawnCodeReviewers).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Continue with manual review.", "info");
    expect(orchestrator.active!.state.phase).toBe("review");
  });
});
