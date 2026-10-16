import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskDestination, flushLogs, getLogger, initSessionLogger, removeTaskDestination, resetLogger, setLogLevel, taskLogsDir } from "./log.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-log-more-"));
  dirs.push(dir);
  return dir;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(path: string, text: string): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
    if (content.includes(text) || Date.now() > deadline) return content;
    await delay(10);
  }
}

afterEach(async () => {
  flushLogs();
  resetLogger();
  await delay(30);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("taskLogsDir", () => {
  it("re-roots a .pp/state task dir under .pp/logs, using the last state segment", () => {
    expect(taskLogsDir("/r/.pp/state/x/.pp/state/impl/t1")).toBe("/r/.pp/state/x/.pp/logs/impl/t1");
  });

  it("leaves a dir outside .pp/state unchanged", () => {
    expect(taskLogsDir("/r/elsewhere/t1")).toBe("/r/elsewhere/t1");
  });
});

describe("logger lifecycle", () => {
  it("does nothing for a task destination before a session logger exists", () => {
    const dir = join(tempDir(), ".pp", "state", "t");
    addTaskDestination(dir);
    expect(existsSync(join(tempDir(), ".pp", "logs"))).toBe(false);
    expect(getLogger().level).toBe("silent");
  });

  it("re-initializing switches to a fresh session file and drops the task destination", async () => {
    const ppDir = join(tempDir(), ".pp");
    initSessionLogger(ppDir, "info");
    addTaskDestination(join(ppDir, "state", "impl", "t1"));
    const taskFile = join(ppDir, "logs", "impl", "t1", "debug.jsonl");
    await delay(5);
    initSessionLogger(ppDir, "info");
    getLogger().info("after-reinit");
    flushLogs();
    const sessions = readdirSync(join(ppDir, "logs")).filter((f) => f.startsWith("session-")).sort();
    expect(sessions).toHaveLength(2);
    expect(await waitFor(join(ppDir, "logs", sessions[1]), "after-reinit")).toContain("after-reinit");
    expect(existsSync(taskFile) ? readFileSync(taskFile, "utf-8") : "").not.toContain("after-reinit");
  });

  it("applies a level change to the task destination too", async () => {
    const ppDir = join(tempDir(), ".pp");
    initSessionLogger(ppDir, "info");
    addTaskDestination(join(ppDir, "state", "impl", "t1"));
    setLogLevel("debug");
    getLogger().debug("debug-to-task");
    flushLogs();
    expect(await waitFor(join(ppDir, "logs", "impl", "t1", "debug.jsonl"), "debug-to-task")).toContain("debug-to-task");
  });

  it("keeps logging to the session when the task dir cannot be created", async () => {
    const ppDir = join(tempDir(), ".pp");
    initSessionLogger(ppDir, "info");
    // A file where the task's logs directory should go.
    mkdirSync(join(ppDir, "logs"), { recursive: true });
    writeFileSync(join(ppDir, "logs", "impl"), "");
    addTaskDestination(join(ppDir, "state", "impl", "t1"));
    removeTaskDestination();
    getLogger().info("still-session");
    flushLogs();
    const session = readdirSync(join(ppDir, "logs")).find((f) => f.startsWith("session-"))!;
    expect(await waitFor(join(ppDir, "logs", session), "still-session")).toContain("still-session");
  });

  it("prunes only old session logs, never other files", () => {
    const ppDir = join(tempDir(), ".pp");
    const logs = join(ppDir, "logs");
    mkdirSync(logs, { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const name of ["session-old.jsonl", "notes.jsonl", "session-old.txt"]) {
      writeFileSync(join(logs, name), "");
      utimesSync(join(logs, name), old, old);
    }
    initSessionLogger(ppDir, "info");
    const remaining = readdirSync(logs);
    expect(remaining).not.toContain("session-old.jsonl");
    expect(remaining).toEqual(expect.arrayContaining(["notes.jsonl", "session-old.txt"]));
  });
});
