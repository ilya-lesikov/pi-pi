import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, ensureGitignore, type ActiveTask } from "./orchestrator.js";
import { getDefaultConfig, resolvePreset } from "./config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-orchestrator-test-"));
  tempDirs.push(dir);
  return dir;
}

function makePi(overrides: Record<string, unknown> = {}): any {
  return {
    getAllTools: vi.fn().mockReturnValue([]),
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
    sendMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    sendUserMessage: vi.fn(),
    ...overrides,
  };
}

function makeActiveTask(release: (() => Promise<void>) | null): ActiveTask {
  return {
    dir: "/tmp/task",
    type: "implement",
    state: {
      phase: "brainstorm",
      step: "llm_work",
      reviewCycle: null,
      reviewPass: 0,
      from: null,
      description: "Task",
      startedAt: new Date().toISOString(),
    },
    release,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewPass: 0,
    description: "Task",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Orchestrator.truncateResult", () => {
  it("returns empty string for empty input", () => {
    const orchestrator = new Orchestrator(makePi());
    expect(orchestrator.truncateResult("   \n\t  ")).toBe("");
  });

  it("returns trimmed short input unchanged", () => {
    const orchestrator = new Orchestrator(makePi());
    expect(orchestrator.truncateResult("\nhello\nworld\n")).toBe("hello\nworld");
  });

  it("truncates output longer than 20 lines", () => {
    const orchestrator = new Orchestrator(makePi());
    const input = Array.from({ length: 21 }, (_, i) => `line-${i + 1}`).join("\n");

    const expected = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n") + "\n…(truncated)";
    expect(orchestrator.truncateResult(input)).toBe(expected);
  });

  it("truncates output longer than 2000 chars", () => {
    const orchestrator = new Orchestrator(makePi());
    const input = "x".repeat(2050);
    const result = orchestrator.truncateResult(input);

    expect(result).toBe("x".repeat(2000) + "\n…(truncated)");
  });
});

describe("Orchestrator.safeSendUserMessage", () => {
  it("notifies the user once after exhausting retries, not during them", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const pi = makePi({
      sendUserMessage: vi.fn(() => {
        throw new Error("not ready");
      }),
    });
    const orchestrator = new Orchestrator(pi);
    orchestrator.lastCtx = { ui: { notify } };

    orchestrator.safeSendUserMessage("[PI-PI] Entered plan phase. Begin working.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe("error");
    vi.useRealTimers();
  });

  it("queues as a follow-up so it never throws 'Agent is already processing'", () => {
    // Regression: during an autonomous phase transition pp_phase_complete is
    // still in-flight when the post-compaction 'Begin working' message is sent.
    // Without deliverAs the runtime throws and the implement phase never starts.
    const sendUserMessage = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage }));

    orchestrator.safeSendUserMessage("[PI-PI] Entered implement phase. Begin working.");

    expect(sendUserMessage).toHaveBeenCalledWith(
      "[PI-PI] Entered implement phase. Begin working.",
      { deliverAs: "followUp" },
    );
  });
});

describe("Orchestrator.cancelPendingRetry", () => {
  it("clears the pending timer, disarms the ESC interrupt, and resets the counter", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    const unsub = vi.fn();
    orchestrator.errorRetryCount = 3;
    orchestrator.pendingRetryEscUnsub = unsub;
    orchestrator.pendingRetryTimer = setTimeout(() => send("fired"), 1000) as any;

    orchestrator.cancelPendingRetry();

    expect(orchestrator.pendingRetryTimer).toBeNull();
    expect(orchestrator.pendingRetryEscUnsub).toBeNull();
    expect(orchestrator.errorRetryCount).toBe(0);
    expect(unsub).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("Orchestrator.armRetryEscInterrupt", () => {
  function makeCtxWithTerminal() {
    let handler: ((data: string) => any) | null = null;
    const notify = vi.fn();
    const ctx = {
      ui: {
        notify,
        onTerminalInput: (h: (data: string) => any) => {
          handler = h;
          return () => { handler = null; };
        },
      },
    };
    return { ctx, notify, feed: (data: string) => handler?.(data) };
  }

  it("cancels the pending retry on a bare ESC only", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    const { ctx, notify, feed } = makeCtxWithTerminal();
    orchestrator.pendingRetryTimer = setTimeout(() => {}, 10000) as any;
    orchestrator.armRetryEscInterrupt(ctx as any);

    // Arrow key (ESC-prefixed sequence) must NOT cancel and must NOT be consumed.
    const arrow = feed("\x1b[A");
    expect(arrow).toBeUndefined();
    expect(orchestrator.pendingRetryTimer).not.toBeNull();

    // Bare ESC cancels and consumes.
    const esc = feed("\x1b");
    expect(esc).toEqual({ consume: true });
    expect(orchestrator.pendingRetryTimer).toBeNull();
    expect(notify).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("is a no-op when no retry timer is armed", () => {
    const orchestrator = new Orchestrator(makePi());
    const { ctx, feed } = makeCtxWithTerminal();
    orchestrator.armRetryEscInterrupt(ctx as any);
    expect(feed("\x1b")).toBeUndefined();
  });
});

describe("Orchestrator.sendUserMessageWhenIdle", () => {
  it("sends immediately when idle", () => {
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 7;
    orchestrator.lastCtx = { isIdle: () => true };

    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 7);
    expect(send).toHaveBeenCalledWith("[PI-PI] go", { deliverAs: "followUp" });
  });

  it("defers while busy, then sends once idle", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 1;
    let idle = false;
    orchestrator.lastCtx = { isIdle: () => idle };

    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledWith("[PI-PI] go", { deliverAs: "followUp" });
    vi.useRealTimers();
  });

  it("drops (does not send) when the task token changes", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 1;
    orchestrator.lastCtx = { isIdle: () => false };

    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 1);
    orchestrator.activeTaskToken = 2; // task switched
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("Orchestrator.switchModel thinking level", () => {
  function makeCtx() {
    return {
      modelRegistry: {
        getAvailable: () => [{ provider: "anthropic", id: "claude-test-model" }],
      },
    } as any;
  }

  it("honors xhigh on the main agent (no downgrade)", async () => {
    const pi = makePi({ setModel: vi.fn().mockResolvedValue(true) });
    const orchestrator = new Orchestrator(pi);
    const ok = await orchestrator.switchModel(makeCtx(), "anthropic/claude-test-model", "xhigh");
    expect(ok).toBe(true);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("xhigh");
  });

  it("honors minimal on the main agent", async () => {
    const pi = makePi({ setModel: vi.fn().mockResolvedValue(true) });
    const orchestrator = new Orchestrator(pi);
    await orchestrator.switchModel(makeCtx(), "anthropic/claude-test-model", "minimal");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("minimal");
  });

  it("falls back to high for an invalid thinking level", async () => {
    const pi = makePi({ setModel: vi.fn().mockResolvedValue(true) });
    const orchestrator = new Orchestrator(pi);
    await orchestrator.switchModel(makeCtx(), "anthropic/claude-test-model", "bogus");
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });
});

describe("Orchestrator.taskIdFromDir", () => {
  it("extracts numeric prefix from directory basename", () => {
    const orchestrator = new Orchestrator(makePi());
    expect(orchestrator.taskIdFromDir("/tmp/.pp/state/implement/123456789012_add-feature")).toBe("123456789012");
  });
});

describe("resolvePreset", () => {
  it("resolves deep reviewer preset", () => {
    const config = getDefaultConfig();
    config.agents.subagents.presetGroups.planReviewers = {
      default: "regular",
      presets: {
        regular: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/p1", thinking: "low" },
          },
        },
        deep: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/p1", thinking: "xhigh" },
          },
        },
      },
    };
    config.agents.subagents.presetGroups.brainstormReviewers = {
      default: "regular",
      presets: {
        regular: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/b1", thinking: "low" },
          },
        },
        deep: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/b1", thinking: "xhigh" },
          },
        },
      },
    };
    config.agents.subagents.presetGroups.codeReviewers = {
      default: "regular",
      presets: {
        regular: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/1", thinking: "low" },
            medium: { enabled: true, model: "x/2", thinking: "medium" },
            high: { enabled: true, model: "x/3", thinking: "high" },
            other: { enabled: true, model: "x/4", thinking: "off" },
          },
        },
        deep: {
          enabled: true,
          agents: {
            low: { enabled: true, model: "x/1", thinking: "xhigh" },
            medium: { enabled: true, model: "x/2", thinking: "xhigh" },
            high: { enabled: true, model: "x/3", thinking: "xhigh" },
            other: { enabled: true, model: "x/4", thinking: "xhigh" },
          },
        },
      },
    };
    config.commands.afterEdit = {};
    config.commands.afterImplement = {};

    const upgraded = resolvePreset(config as any, "codeReviewers", "deep");

    expect(upgraded.low.thinking).toBe("xhigh");
    expect(upgraded.medium.thinking).toBe("xhigh");
    expect(upgraded.high.thinking).toBe("xhigh");
    expect(upgraded.other.thinking).toBe("xhigh");
  });
});

describe("ensureGitignore", () => {
  it("creates .pp/.gitignore with required entries", () => {
    const cwd = makeTempDir();

    ensureGitignore(cwd);

    const gitignorePath = join(cwd, ".pp", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toBe("state/\nconfig.json\nlogs/\n");
  });

  it("adds missing entries and does not duplicate existing ones", () => {
    const cwd = makeTempDir();
    const gitignorePath = join(cwd, ".pp", ".gitignore");

    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(gitignorePath, "state/\n", "utf-8");

    ensureGitignore(cwd);
    ensureGitignore(cwd);

    const lines = readFileSync(gitignorePath, "utf-8").trim().split("\n");
    expect(lines.filter((line) => line === "state/")).toHaveLength(1);
    expect(lines.filter((line) => line === "config.json")).toHaveLength(1);
  });
});

describe("Orchestrator.checkForConflictingExtensions", () => {
  it("detects duplicate bundled tools", () => {
    const pi = makePi({
      getAllTools: vi.fn().mockReturnValue([
        { name: "Agent" },
        { name: "Agent" },
        { name: "TaskCreate" },
        { name: "TaskCreate" },
        { name: "CustomTool" },
      ]),
    });
    const orchestrator = new Orchestrator(pi);

    expect(orchestrator.checkForConflictingExtensions().sort()).toEqual(["Agent", "TaskCreate"]);
  });

  it("returns empty array when no duplicates exist", () => {
    const pi = makePi({
      getAllTools: vi.fn().mockReturnValue([
        { name: "Agent" },
        { name: "TaskCreate" },
        { name: "CustomTool" },
      ]),
    });
    const orchestrator = new Orchestrator(pi);

    expect(orchestrator.checkForConflictingExtensions()).toEqual([]);
  });
});

describe("Orchestrator.abortAllSubagents", () => {
  it("emits stop events for all spawned subagents and clears the set", () => {
    const emit = vi.fn();
    const orchestrator = new Orchestrator(makePi({ events: { emit, on: vi.fn() } }));
    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.spawnedAgentIds.add("agent-2");

    orchestrator.abortAllSubagents();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      "subagents:rpc:stop",
      expect.objectContaining({ agentId: "agent-1", requestId: expect.any(String) }),
    );
    expect(emit).toHaveBeenCalledWith(
      "subagents:rpc:stop",
      expect.objectContaining({ agentId: "agent-2", requestId: expect.any(String) }),
    );
    expect(orchestrator.spawnedAgentIds.size).toBe(0);
  });
});

describe("Orchestrator.cleanupActive", () => {
  it("releases active lock and sets active to null", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const orchestrator = new Orchestrator(makePi());
    orchestrator.active = makeActiveTask(release);

    await orchestrator.cleanupActive();

    expect(release).toHaveBeenCalledTimes(1);
    expect(orchestrator.active).toBeNull();
  });
  it("does nothing when active task is null", async () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.active = null;

    await expect(orchestrator.cleanupActive()).resolves.toBeUndefined();
    expect(orchestrator.active).toBeNull();
  });
});

describe("Orchestrator.getPlanStartState", () => {
  function makePlannerConfig() {
    const config = getDefaultConfig();
    config.general.autoCommit = false;
    config.general.loadExtraRepoConfigs = true;
    config.general.logLevel = "info";
    config.agents.subagents.presetGroups.planners = {
      default: "regular",
      presets: {
        regular: {
          enabled: true,
          agents: {
            alpha: { enabled: true, model: "x/a", thinking: "low" },
            beta: { enabled: true, model: "x/b", thinking: "low" },
          },
        },
      },
    };
    config.commands.afterEdit = {};
    config.commands.afterImplement = {};
    config.performance.commands.afterEdit = 1;
    config.performance.commands.afterImplement = 1;
    config.performance.internals.subagentStale = 1;
    config.performance.internals.taskLockStale = 1;
    config.performance.internals.taskLockRefresh = 1;
    return config as any;
  }

  it("returns synthesize when all enabled planner variants have outputs", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), "# Plan\n", "utf-8");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_beta.md`), "# Plan\n", "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "synthesize", shouldSpawnPlanners: false });
  });

  it("returns await_planners when required planner outputs are missing", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), "# Plan\n", "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "await_planners", shouldSpawnPlanners: true });
  });

  it("returns synthesize when synthesized plan already exists", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_synthesized.md`), "# Plan\n", "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "synthesize", shouldSpawnPlanners: false });
  });
});
