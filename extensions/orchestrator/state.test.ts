import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import { createTask, getActiveTask, listTasks, loadTask, saveTask, taskAge, taskName, validateFromPath, type TaskState } from "./state.js";

const tempDirs: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createTask", () => {
  it("creates implement task directory and initial state", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Build New Feature");
    const state = loadTask(taskDir);

    expect(taskDir).toContain(join(cwd, ".pp", "state", "implement"));
    expect(state.phase).toBe("brainstorm");
    expect(state.from).toBeNull();
    expect(state.description).toBe("Build New Feature");
    expect(new Date(state.startedAt).toString()).not.toBe("Invalid Date");

    const raw = readFileSync(join(taskDir, "state.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("uses diagnosing as initial phase for debug", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "debug", "Fix timeout issue");
    expect(loadTask(taskDir).phase).toBe("diagnosing");
  });

  it("uses active as initial phase for brainstorm", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "brainstorm", "Explore ideas");
    expect(loadTask(taskDir).phase).toBe("active");
  });
});

describe("loadTask", () => {
  it("reads and parses state.json", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Readable state");
    const state = loadTask(taskDir);
    expect(state.description).toBe("Readable state");
  });

  it("throws descriptive error on corrupt json", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Corrupt me");
    writeFileSync(join(taskDir, "state.json"), "{ this-is-not-json", "utf-8");

    expect(() => loadTask(taskDir)).toThrowError(/Failed to parse .*state\.json:/);
  });
});

describe("saveTask", () => {
  it("writes state.json correctly", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Initial");
    const state: TaskState = {
      phase: "review",
      from: "implement/some-task",
      description: "Updated",
      startedAt: "2026-04-20T00:00:00.000Z",
      reviewRound: 2,
    };

    saveTask(taskDir, state);

    const loaded = loadTask(taskDir);
    expect(loaded).toEqual(state);
  });
});

describe("listTasks", () => {
  it("lists only non-done tasks and respects type filter", () => {
    const cwd = makeCwd();
    const implementTask = createTask(cwd, "implement", "Implement feature");
    const debugTask = createTask(cwd, "debug", "Debug crash");
    const brainstormTask = createTask(cwd, "brainstorm", "Idea storm");

    const doneState = loadTask(debugTask);
    doneState.phase = "done";
    saveTask(debugTask, doneState);

    const all = listTasks(cwd);
    const allDirs = all.map((t) => t.dir);
    expect(allDirs).toContain(implementTask);
    expect(allDirs).toContain(brainstormTask);
    expect(allDirs).not.toContain(debugTask);

    const brainstormOnly = listTasks(cwd, "brainstorm");
    expect(brainstormOnly).toHaveLength(1);
    expect(brainstormOnly[0].dir).toBe(brainstormTask);
    expect(brainstormOnly[0].type).toBe("brainstorm");
  });

  it("skips corrupt task entries", () => {
    const cwd = makeCwd();
    createTask(cwd, "implement", "Healthy task");
    const corrupt = createTask(cwd, "implement", "Broken task");
    writeFileSync(join(corrupt, "state.json"), "{ nope", "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tasks = listTasks(cwd, "implement");

    expect(tasks).toHaveLength(1);
    expect(tasks[0].state.description).toBe("Healthy task");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("validateFromPath", () => {
  it("rejects paths containing dot-dot", () => {
    const cwd = makeCwd();
    expect(validateFromPath(cwd, "implement/../x")).toEqual({
      ok: false,
      reason: "Path must not contain '..'",
    });
  });

  it("rejects escaping .pp/state", () => {
    const cwd = makeCwd();
    const result = validateFromPath(cwd, "/tmp");
    expect(result).toEqual({
      ok: false,
      reason: "Path escapes .pp/state/ directory",
    });
  });

  it("rejects missing source directories", () => {
    const cwd = makeCwd();
    expect(validateFromPath(cwd, "implement/missing")).toEqual({
      ok: false,
      reason: "Source task not found: implement/missing",
    });
  });

  it("rejects directories without state.json", () => {
    const cwd = makeCwd();
    const relative = "implement/no-state";
    mkdirSync(join(cwd, ".pp", "state", relative), { recursive: true });

    expect(validateFromPath(cwd, relative)).toEqual({
      ok: false,
      reason: "No state.json found at implement/no-state — not a valid task directory",
    });
  });

  it("accepts valid task directories", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Valid source");
    const relative = taskDir.replace(join(cwd, ".pp", "state") + "/", "");

    expect(validateFromPath(cwd, relative)).toEqual({ ok: true, dir: taskDir });
  });

  it("allows fromPath resolving to state root and then fails state.json validation", () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".pp", "state"), { recursive: true });

    expect(validateFromPath(cwd, ".")).toEqual({
      ok: false,
      reason: "No state.json found at . — not a valid task directory",
    });
  });
});

describe("taskName", () => {
  it("returns description from state.json", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "My readable task name");
    expect(taskName(taskDir)).toBe("My readable task name");
  });

  it("falls back to parsed directory name", () => {
    const cwd = makeCwd();
    const taskDir = join(cwd, ".pp", "state", "implement", "123456789012_my-fallback-name");
    mkdirSync(taskDir, { recursive: true });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(taskName(taskDir)).toBe("my fallback name");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("taskAge", () => {
  it("formats minutes", () => {
    const state: TaskState = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    expect(taskAge(state)).toBe("5m");
  });

  it("formats hours", () => {
    const state: TaskState = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };
    expect(taskAge(state)).toBe("3h");
  });

  it("formats days", () => {
    const state: TaskState = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(taskAge(state)).toBe("2d");
  });

  it("returns '?' for empty startedAt", () => {
    const state: TaskState = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: "",
    };
    expect(taskAge(state)).toBe("?");
  });

  it("returns '?' for non-date startedAt", () => {
    const state: TaskState = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: "not-a-date",
    };
    expect(taskAge(state)).toBe("?");
  });

  it("returns '?' for undefined startedAt", () => {
    const state = {
      phase: "brainstorm",
      from: null,
      description: "x",
      startedAt: undefined,
    } as any;
    expect(taskAge(state)).toBe("?");
  });
});

describe("getActiveTask", () => {
  it("returns single unlocked task for restoration", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Abandoned task");
    const checkSpy = vi.spyOn(lockfile, "checkSync").mockReturnValue(false);

    const result = getActiveTask(cwd);

    expect(checkSpy).toHaveBeenCalledWith(join(taskDir, "state.json"), { stale: 600000 });
    expect(result?.dir).toBe(taskDir);
  });

  it("returns null when task is locked by another process", () => {
    const cwd = makeCwd();
    createTask(cwd, "implement", "Active elsewhere");
    vi.spyOn(lockfile, "checkSync").mockReturnValue(true);

    expect(getActiveTask(cwd)).toBeNull();
  });

  it("returns null when multiple unlocked tasks exist (ambiguous)", () => {
    const cwd = makeCwd();
    createTask(cwd, "implement", "First abandoned");
    createTask(cwd, "debug", "Second abandoned");
    vi.spyOn(lockfile, "checkSync").mockReturnValue(false);

    expect(getActiveTask(cwd)).toBeNull();
  });

  it("returns the single unlocked task when others are locked", () => {
    const cwd = makeCwd();
    const lockedTask = createTask(cwd, "implement", "Locked by other");
    const unlockedTask = createTask(cwd, "debug", "Abandoned");

    vi.spyOn(lockfile, "checkSync").mockImplementation((path: string, _options?: { stale?: number }) => {
      if (path === join(lockedTask, "state.json")) return true;
      return false;
    });

    const result = getActiveTask(cwd);
    expect(result?.dir).toBe(unlockedTask);
  });

  it("uses custom lockStale for stale detection", () => {
    const cwd = makeCwd();
    const taskDir = createTask(cwd, "implement", "Stale test");
    const checkSpy = vi.spyOn(lockfile, "checkSync").mockReturnValue(false);

    getActiveTask(cwd, 1234);

    expect(checkSpy).toHaveBeenCalledWith(join(taskDir, "state.json"), { stale: 1234 });
  });
});
