import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { collectReportFiles, writeReportBundle } from "./report.js";

describe("report bundle", () => {
  let cwd: string;
  let taskDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "report-"));
    // Task dir under .pp/state/<type>/<task>/
    taskDir = join(cwd, ".pp", "state", "implement", "abc_task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "USER_REQUEST.md"), "the request");
    writeFileSync(join(taskDir, "state.json"), "{}");
    mkdirSync(join(taskDir, "plans"), { recursive: true });
    writeFileSync(join(taskDir, "plans", "p.md"), "plan");
    // MAPPED per-task debug log at .pp/logs/<type>/<task>/debug.jsonl
    const logDir = join(cwd, ".pp", "logs", "implement", "abc_task");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "debug.jsonl"), '{"line":1}');
    // Session log
    writeFileSync(join(cwd, ".pp", "logs", "session-123.jsonl"), '{"s":1}');
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("collects task state files, the MAPPED debug log, and session logs", () => {
    const files = collectReportFiles(cwd, taskDir);
    const archivePaths = files.map((f) => f.archivePath);
    // Task state files.
    expect(archivePaths).toContain(join("task-state", "USER_REQUEST.md"));
    expect(archivePaths).toContain(join("task-state", "state.json"));
    expect(archivePaths).toContain(join("task-state", "plans", "p.md"));
    // The mapped per-task debug log (NOT <taskDir>/logs).
    expect(archivePaths).toContain(join("task-logs", "debug.jsonl"));
    // Session logs.
    expect(archivePaths).toContain(join("session-logs", "session-123.jsonl"));
  });

  it("includes traces when present", () => {
    const tracesDir = join(cwd, ".pp", "logs", "traces", "sess1");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(join(tracesDir, "main.jsonl"), '{"t":1}');
    const archivePaths = collectReportFiles(cwd, taskDir).map((f) => f.archivePath);
    expect(archivePaths).toContain(join("traces", "sess1", "main.jsonl"));
  });

  it("omits traces without crashing when absent", () => {
    const archivePaths = collectReportFiles(cwd, taskDir).map((f) => f.archivePath);
    expect(archivePaths.some((p) => p.startsWith("traces" + sep))).toBe(false);
  });

  it("handles the no-task case (bundles session logs only, plus note later)", () => {
    const files = collectReportFiles(cwd, null);
    const archivePaths = files.map((f) => f.archivePath);
    expect(archivePaths).toContain(join("session-logs", "session-123.jsonl"));
    expect(archivePaths.some((p) => p.startsWith("task-state"))).toBe(false);
    expect(archivePaths.some((p) => p.startsWith("task-logs"))).toBe(false);
  });

  it("writes the bundle with note.md and every captured file under .pp/reports/", () => {
    const files = collectReportFiles(cwd, taskDir);
    const { reportDir, captured } = writeReportBundle(cwd, "my feedback note", files);
    expect(existsSync(reportDir)).toBe(true);
    expect(reportDir).toContain(join(".pp", "reports"));
    // note.md written with the user's text.
    expect(readFileSync(join(reportDir, "note.md"), "utf-8")).toContain("my feedback note");
    expect(captured).toContain("note.md");
    // Captured files physically present in the bundle.
    expect(existsSync(join(reportDir, "task-state", "USER_REQUEST.md"))).toBe(true);
    expect(existsSync(join(reportDir, "task-logs", "debug.jsonl"))).toBe(true);
    expect(existsSync(join(reportDir, "session-logs", "session-123.jsonl"))).toBe(true);
  });
});
