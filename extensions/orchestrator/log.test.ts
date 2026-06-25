import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskDestination, flushLogs, getLogger, initSessionLogger, removeTaskDestination, resetLogger, setLogLevel } from "./log.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-log-test-"));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function sessionLogPath(ppDir: string): string {
  const logsDir = join(ppDir, "logs");
  const entries = existsSync(logsDir)
    ? readdirSync(logsDir).filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
    : [];
  if (entries.length === 0) return "";
  return join(logsDir, entries.sort()[entries.length - 1]);
}

afterEach(async () => {
  flushLogs();
  resetLogger();
  await delay(50);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("log", () => {
  it("getLogger returns silent logger before init", async () => {
    await (async () => {
      const module = await import("./log.js");
      expect(module.getLogger().level).toBe("silent");
    })();
  });

  it("initSessionLogger creates session log file in .pp/logs", () => {
    const ppDir = makeTempDir();
    initSessionLogger(ppDir, "info");

    const logPath = sessionLogPath(ppDir);
    expect(logPath).not.toBe("");
    expect(existsSync(logPath)).toBe(true);
  });

  it("initSessionLogger writes JSONL to session file", async () => {
    const ppDir = makeTempDir();
    initSessionLogger(ppDir, "debug");
    const logPath = sessionLogPath(ppDir);

    getLogger().info({ s: "test" }, "hello-session");
    flushLogs();
    await delay(30);

    expect(readText(logPath)).toContain("hello-session");
  });

  it("addTaskDestination creates debug.jsonl in task dir", async () => {
    const ppDir = makeTempDir();
    const taskDir = join(ppDir, "task");
    initSessionLogger(ppDir, "info");

    addTaskDestination(taskDir);
    getLogger().info({ s: "test" }, "touch-task-log");
    flushLogs();
    await delay(30);

    expect(existsSync(join(taskDir, "debug.jsonl"))).toBe(true);
  });

  it("addTaskDestination logs to both session and task files", async () => {
    const ppDir = makeTempDir();
    const taskDir = join(ppDir, "task");
    initSessionLogger(ppDir, "debug");
    const sessionPath = sessionLogPath(ppDir);
    addTaskDestination(taskDir);

    getLogger().info({ s: "test" }, "both-destinations");
    flushLogs();
    await delay(100);

    expect(readText(sessionPath)).toContain("both-destinations");
    expect(readText(join(taskDir, "debug.jsonl"))).toContain("both-destinations");
  });

  it("removeTaskDestination stops writing to task file", async () => {
    const ppDir = makeTempDir();
    const taskDir = join(ppDir, "task");
    initSessionLogger(ppDir, "debug");
    addTaskDestination(taskDir);

    getLogger().info({ s: "test" }, "before-remove");
    flushLogs();
    await delay(30);
    const before = readText(join(taskDir, "debug.jsonl"));

    removeTaskDestination();
    getLogger().info({ s: "test" }, "after-remove");
    flushLogs();
    await delay(30);
    const after = readText(join(taskDir, "debug.jsonl"));

    expect(before).toContain("before-remove");
    expect(after).not.toContain("after-remove");
  });

  it("setLogLevel changes effective log level", async () => {
    const ppDir = makeTempDir();
    initSessionLogger(ppDir, "info");
    const path = sessionLogPath(ppDir);

    getLogger().debug({ s: "test" }, "debug-before");
    getLogger().info({ s: "test" }, "info-before");
    flushLogs();
    await delay(30);
    const before = readText(path);

    setLogLevel("debug");
    getLogger().debug({ s: "test" }, "debug-after");
    flushLogs();
    await delay(30);
    const after = readText(path);

    expect(before).toContain("info-before");
    expect(before).not.toContain("debug-before");
    expect(after).toContain("debug-after");
  });

  it("setLogLevel ignores invalid levels", () => {
    const ppDir = makeTempDir();
    initSessionLogger(ppDir, "info");

    setLogLevel("invalid" as any);

    expect(getLogger().level).toBe("info");
  });

  it("cleanOldSessionLogs deletes files older than max age", () => {
    const ppDir = makeTempDir();
    const logsDir = join(ppDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const oldFile = join(logsDir, "session-old.jsonl");
    writeFileSync(oldFile, "{}\n", "utf-8");
    const oldTime = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    initSessionLogger(ppDir, "info");

    expect(existsSync(oldFile)).toBe(false);
  });

  it("cleanOldSessionLogs keeps recent files", () => {
    const ppDir = makeTempDir();
    const logsDir = join(ppDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const recentFile = join(logsDir, "session-recent.jsonl");
    writeFileSync(recentFile, "{}\n", "utf-8");
    const recentTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(recentFile, recentTime, recentTime);

    initSessionLogger(ppDir, "info");

    expect(existsSync(recentFile)).toBe(true);
  });

  it("initSessionLogger falls back to silent on unwritable path", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x", "utf-8");

    initSessionLogger(filePath, "debug");

    expect(getLogger().level).toBe("silent");
  });

  it("flushLogs does not crash when no streams", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x", "utf-8");
    initSessionLogger(filePath, "info");

    expect(() => flushLogs()).not.toThrow();
  });
});
