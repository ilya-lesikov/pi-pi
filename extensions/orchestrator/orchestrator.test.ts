import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, deepReviewConfig, ensureGitignore, type ActiveTask } from "./orchestrator.js";

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
      from: null,
      description: "Task",
      startedAt: new Date().toISOString(),
    },
    release,
    taskId: "123",
    modifiedFiles: new Set(),
    reviewRound: 1,
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

describe("Orchestrator.taskIdFromDir", () => {
  it("extracts numeric prefix from directory basename", () => {
    const orchestrator = new Orchestrator(makePi());
    expect(orchestrator.taskIdFromDir("/tmp/.pp/state/implement/123456789012_add-feature")).toBe("123456789012");
  });
});

describe("deepReviewConfig", () => {
  it("upgrades reviewer thinking levels", () => {
    const config = {
      mainModel: {
        implement: { model: "a/impl", thinking: "high" },
        debug: { model: "a/debug", thinking: "high" },
        brainstorm: { model: "a/brain", thinking: "high" },
      },
      planners: {},
      planReviewers: {},
      codeReviewers: {
        low: { enabled: true, model: "x/1", thinking: "low" },
        medium: { enabled: true, model: "x/2", thinking: "medium" },
        high: { enabled: true, model: "x/3", thinking: "high" },
        other: { enabled: true, model: "x/4", thinking: "off" },
      },
      agents: {
        explore: { model: "x/e", thinking: "low" },
        librarian: { model: "x/l", thinking: "medium" },
        task: { model: "x/t", thinking: "medium" },
      },
      commands: { afterEdit: [], afterImplement: [] },
      timeouts: {
        afterEdit: 1,
        afterImplement: 1,
        agentSpawn: 1,
        agentReadyPing: 1,
        lockStale: 1,
        lockUpdate: 1,
      },
      autoCommit: true,
    };

    const upgraded = deepReviewConfig(config as any);

    expect(upgraded.codeReviewers.low.thinking).toBe("medium");
    expect(upgraded.codeReviewers.medium.thinking).toBe("high");
    expect(upgraded.codeReviewers.high.thinking).toBe("high");
    expect(upgraded.codeReviewers.other.thinking).toBe("high");
  });
});

describe("ensureGitignore", () => {
  it("creates .pp/.gitignore with required entries", () => {
    const cwd = makeTempDir();

    ensureGitignore(cwd);

    const gitignorePath = join(cwd, ".pp", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toBe("state/\nconfig.json\n");
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
