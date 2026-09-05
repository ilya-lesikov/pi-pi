import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, ensureGitignore, type ActiveTask } from "./orchestrator.js";
import { getDefaultConfig, resolvePreset } from "./config.js";
import { resetAcpStateCache } from "./acp.js";

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

describe("Orchestrator.deliverReviewReady (item 9: no editor leak on /pp close)", () => {
  function setup() {
    const sendUserMessage = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage }));
    orchestrator.active = makeActiveTask(null);
    // isIdle true so sendUserMessageWhenIdle delivers synchronously.
    orchestrator.lastCtx = { isIdle: () => true };
    return { orchestrator, sendUserMessage };
  }

  it("does NOT queue the banner while a menu/ask dialogue is live (nothing to leak on ESC)", () => {
    const { orchestrator, sendUserMessage } = setup();
    orchestrator.interactivePromptOpen = true;
    orchestrator.deliverReviewReady("[PI-PI] Review cycle is ready for apply_feedback.");
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.pendingReviewReady).toContain("ready for apply_feedback");
  });

  it("delivers exactly once as a fresh turn when the dialogue closes, then never re-fires", () => {
    const { orchestrator, sendUserMessage } = setup();
    orchestrator.interactivePromptOpen = true;
    orchestrator.deliverReviewReady("[PI-PI] Review cycle is ready for apply_feedback.");
    orchestrator.interactivePromptOpen = false;
    orchestrator.flushPendingReviewReady();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingReviewReady).toBeNull();
    // A second flush (e.g. a later idle) must not re-send.
    orchestrator.flushPendingReviewReady();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers immediately when no dialogue is open", () => {
    const { orchestrator, sendUserMessage } = setup();
    orchestrator.interactivePromptOpen = false;
    orchestrator.deliverReviewReady("[PI-PI] Review cycle is ready for apply_feedback.");
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.pendingReviewReady).toBeNull();
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
    // A retry backoff runs while the session is idle; consuming ESC is only
    // correct there (see the streaming case below).
    orchestrator.lastCtx = { isIdle: () => true };
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

  it("does NOT consume ESC while the session is streaming, so the host can abort the tool call", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    const { ctx, feed } = makeCtxWithTerminal();
    // Streaming: the editor's onEscape is the only path to agent.abort() ->
    // killProcessTree. Consuming here strands the running tool.
    orchestrator.lastCtx = { isIdle: () => false };
    orchestrator.pendingRetryTimer = setTimeout(() => {}, 10000) as any;
    orchestrator.armRetryEscInterrupt(ctx as any);

    expect(feed("\x1b")).toBeUndefined();
    expect(orchestrator.pendingRetryTimer).toBeNull();
    vi.useRealTimers();
  });

  it("prefers the arm-time ctx and fails OPEN when it reports streaming", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    let handler: ((data: string) => any) | null = null;
    const notify = vi.fn();
    // The ctx that owns this listener says a turn is streaming...
    const ctx = {
      isIdle: () => false,
      ui: { notify, onTerminalInput: (h: (d: string) => any) => { handler = h; return () => {}; } },
    };
    // ...while a newer, unrelated ctx claims idle. The owning ctx must win.
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.pendingRetryTimer = setTimeout(() => {}, 10000) as any;
    orchestrator.armRetryEscInterrupt(ctx as any);

    expect(handler!("\x1b")).toBeUndefined();
    expect(orchestrator.pendingRetryTimer).toBeNull();
    vi.useRealTimers();
  });

  it("fails OPEN and does not consume when idle state is unknown", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    const { ctx, feed } = makeCtxWithTerminal();
    orchestrator.lastCtx = null;
    orchestrator.pendingRetryTimer = setTimeout(() => {}, 10000) as any;
    orchestrator.armRetryEscInterrupt(ctx as any);

    expect(feed("\x1b")).toBeUndefined();
    vi.useRealTimers();
  });

  it("still consumes ESC during a genuine idle retry backoff", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    const { ctx, notify, feed } = makeCtxWithTerminal();
    orchestrator.lastCtx = { isIdle: () => true };
    orchestrator.pendingRetryTimer = setTimeout(() => {}, 10000) as any;
    orchestrator.armRetryEscInterrupt(ctx as any);

    expect(feed("\x1b")).toEqual({ consume: true });
    expect(orchestrator.pendingRetryTimer).toBeNull();
    expect(notify).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores an idle-delivery poll: ESC arms only for a real retry backoff", () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(makePi());
    const { ctx, feed } = makeCtxWithTerminal();
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 3;
    orchestrator.lastCtx = { isIdle: () => false };
    orchestrator.armRetryEscInterrupt(ctx as any);

    // An idle-delivery poll must not look like a retry backoff to the ESC guard.
    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 3);
    expect(orchestrator.idlePollTimer).not.toBeNull();
    expect(orchestrator.pendingRetryTimer).toBeNull();
    expect(feed("\x1b")).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("task reset clears manual-compaction state", () => {
  it("a pending builtin selection cannot leak into the next task", () => {
    const orchestrator = new Orchestrator(makePi());
    // A manual builtin compact was requested, then the task was aborted/replaced
    // before the hook or the compact() callbacks ran.
    orchestrator.manualCompactionUseBuiltin = true;
    orchestrator.manualCompactionPending = true;

    orchestrator.resetTaskScopedState();

    // Otherwise the next task's first AUTOMATIC compaction silently falls
    // through to the host summarizer, and its menu entry refuses to run.
    expect(orchestrator.manualCompactionUseBuiltin).toBe(false);
    expect(orchestrator.manualCompactionPending).toBe(false);
  });

  it("orphans in-flight manual-compaction callbacks so they cannot clear a later request", () => {
    const orchestrator = new Orchestrator(makePi());
    const idBefore = orchestrator.manualCompactionRequestId;
    orchestrator.manualCompactionPending = true;

    orchestrator.resetTaskScopedState();

    // A delayed onComplete/onError from the reset task must no longer match.
    expect(orchestrator.manualCompactionRequestId).not.toBe(idBefore);
  });
});

describe("idle-delivery poll timer separation", () => {
  it("cancelPendingRetry clears the idle poll WITHOUT resetting the error-retry budget", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 5;
    orchestrator.lastCtx = { isIdle: () => false };
    orchestrator.errorRetryCount = 3;
    orchestrator.errorRetryFirstAt = 1000;
    orchestrator.errorNudgeHalted = true;

    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 5);
    expect(orchestrator.idlePollTimer).not.toBeNull();

    orchestrator.cancelIdlePoll();

    expect(orchestrator.idlePollTimer).toBeNull();
    // Cancelling a delivery poll must not hand the error path a fresh budget.
    expect(orchestrator.errorRetryCount).toBe(3);
    expect(orchestrator.errorRetryFirstAt).toBe(1000);
    expect(orchestrator.errorNudgeHalted).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancelPendingRetry clears BOTH timers so no orphan poll survives an abort", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const orchestrator = new Orchestrator(makePi({ sendUserMessage: send }));
    orchestrator.active = makeActiveTask(null);
    orchestrator.activeTaskToken = 5;
    orchestrator.lastCtx = { isIdle: () => false };
    orchestrator.sendUserMessageWhenIdle("[PI-PI] go", 5);
    orchestrator.pendingRetryTimer = setTimeout(() => send("retry"), 1000) as any;

    orchestrator.cancelPendingRetry();

    expect(orchestrator.pendingRetryTimer).toBeNull();
    expect(orchestrator.idlePollTimer).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
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

describe("Orchestrator.applySubagentConcurrency", () => {
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");

  afterEach(() => {
    delete (globalThis as any)[MANAGER_KEY];
  });

  it("applies the configured limit to the manager handle", () => {
    const setMaxConcurrent = vi.fn();
    (globalThis as any)[MANAGER_KEY] = { setMaxConcurrent };
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = getDefaultConfig() as any;
    orchestrator.config.agents.maxConcurrentSubagents = 7;

    orchestrator.applySubagentConcurrency();

    expect(setMaxConcurrent).toHaveBeenCalledWith(7);
  });

  it("no-ops when the manager handle is absent", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = getDefaultConfig() as any;

    expect(() => orchestrator.applySubagentConcurrency()).not.toThrow();
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

  it("restores the subscription model when a rate-limit fallback had switched it", async () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.active = makeActiveTask(null);
    orchestrator.lastCtx = { ui: { notify: vi.fn() } };
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackMainPriorSpec = "pp-flant-anthropic-sub/sub/claude-opus-5";
    const switchModel = vi.spyOn(orchestrator, "switchModel").mockResolvedValue(true);

    await orchestrator.cleanupActive();

    expect(switchModel).toHaveBeenCalledWith(
      orchestrator.lastCtx,
      "pp-flant-anthropic-sub/sub/claude-opus-5",
      expect.any(String),
    );
  });

  it("leaves the model alone when no fallback had switched it", async () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.active = makeActiveTask(null);
    orchestrator.lastCtx = { ui: { notify: vi.fn() } };
    const switchModel = vi.spyOn(orchestrator, "switchModel").mockResolvedValue(true);

    await orchestrator.cleanupActive();

    expect(switchModel).not.toHaveBeenCalled();
  });

  it("does not restore a subagent-origin fallback that never moved the main model", async () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.active = makeActiveTask(null);
    orchestrator.lastCtx = { ui: { notify: vi.fn() } };
    orchestrator.subFallbackActive = true;
    orchestrator.subFallbackMainPriorSpec = null;
    const switchModel = vi.spyOn(orchestrator, "switchModel").mockResolvedValue(true);

    await orchestrator.cleanupActive();

    expect(switchModel).not.toHaveBeenCalled();
  });
});

describe("Orchestrator ACP state publishing", () => {
  afterEach(() => {
    delete process.env.PI_ACP;
    resetAcpStateCache();
  });

  function setup(): { orchestrator: Orchestrator; appendEntry: ReturnType<typeof vi.fn> } {
    resetAcpStateCache();
    const appendEntry = vi.fn();
    const orchestrator = new Orchestrator(makePi({ appendEntry }));
    orchestrator.active = makeActiveTask(null);
    return { orchestrator, appendEntry };
  }

  it("publishes on every open/close of an interactive prompt under ACP", () => {
    process.env.PI_ACP = "1";
    const { orchestrator, appendEntry } = setup();
    orchestrator.interactivePromptOpen = true;
    orchestrator.interactivePromptOpen = false;
    expect(appendEntry.mock.calls.map((c) => c[1].status)).toEqual(["waiting", "running"]);
  });

  it("does not re-publish when the prompt flag is set to its current value", () => {
    process.env.PI_ACP = "1";
    const { orchestrator, appendEntry } = setup();
    orchestrator.interactivePromptOpen = true;
    orchestrator.interactivePromptOpen = true;
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it("publishes from updateStatus under ACP", () => {
    process.env.PI_ACP = "1";
    const { orchestrator, appendEntry } = setup();
    orchestrator.updateStatus({ ui: { setStatus: () => {} } } as any);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry.mock.calls[0][1]).toMatchObject({ phase: "brainstorm", status: "running" });
  });

  it("publishes the idle state once the active task is cleaned up", async () => {
    process.env.PI_ACP = "1";
    const { orchestrator, appendEntry } = setup();
    orchestrator.updateStatus({ ui: { setStatus: () => {} } } as any);
    await orchestrator.cleanupActive();
    expect(appendEntry.mock.calls.map((c) => c[1].status)).toEqual([
      "running",
      "idle",
    ]);
    expect(appendEntry.mock.calls[1][1]).not.toHaveProperty("phases");
  });

  it("publishes nothing outside ACP, and still toggles the prompt flag", () => {
    const { orchestrator, appendEntry } = setup();
    orchestrator.interactivePromptOpen = true;
    orchestrator.updateStatus({ ui: { setStatus: () => {} } } as any);
    expect(orchestrator.interactivePromptOpen).toBe(true);
    expect(appendEntry).not.toHaveBeenCalled();
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

  const COMPLETE_PLAN = [
    "# Plan",
    "",
    "## Scope",
    "Do the thing.",
    "",
    "## Checklist",
    "",
    "- [ ] Thing is done — Done when: the test passes",
    "",
    "PLAN_STATUS: COMPLETE",
    "",
  ].join("\n");

  it("returns synthesize when all enabled planner variants have outputs", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), COMPLETE_PLAN, "utf-8");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_beta.md`), COMPLETE_PLAN, "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "synthesize", shouldSpawnPlanners: false });
  });

  it("returns await_planners when required planner outputs are missing", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), COMPLETE_PLAN, "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "await_planners", shouldSpawnPlanners: true });
  });

  it("returns await_planners when a variant wrote only its INCOMPLETE stub", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), COMPLETE_PLAN, "utf-8");
    // beta died after writing its stub: the file exists but is not a plan, so
    // synthesizing now would synthesize over nothing.
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_beta.md`), "PLAN_STATUS: INCOMPLETE\n", "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "await_planners", shouldSpawnPlanners: true });
  });

  it("returns synthesize when a stale stub sits beside a completed respawn", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "100_alpha.md"), COMPLETE_PLAN, "utf-8");
    // A respawn writes a NEW timestamped file and leaves the old stub behind, so
    // a variant is complete when ANY of its files is complete.
    writeFileSync(join(plansDir, "100_beta.md"), "PLAN_STATUS: INCOMPLETE\n", "utf-8");
    writeFileSync(join(plansDir, "200_beta.md"), COMPLETE_PLAN, "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "synthesize", shouldSpawnPlanners: false });
  });

  it("treats a legacy marker-less plan as complete so historical tasks still resume", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = makePlannerConfig();
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    const legacy = COMPLETE_PLAN.replace("\nPLAN_STATUS: COMPLETE\n", "");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_alpha.md`), legacy, "utf-8");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_beta.md`), legacy, "utf-8");

    const state = orchestrator.getPlanStartState(taskDir, "regular");

    expect(state).toEqual({ step: "synthesize", shouldSpawnPlanners: false });
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
