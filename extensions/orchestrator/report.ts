import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { taskLogsDir } from "./log.js";

// Local-only "Report" feedback bundle (item 13). Collects a user-typed note plus
// the current/most-recent task's state files, the MAPPED per-task debug log,
// session logs, and traces (when present) into <cwd>/.pp/reports/report-<ts>/.
// ZERO network egress — everything is written to the project's own .pp dir.

export interface ReportFile {
  /** Absolute source path. */
  path: string;
  /** Relative path inside the report bundle. */
  archivePath: string;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, String(e.name));
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * Enumerate every file the report should bundle for a given cwd and (optional)
 * task dir. Deterministic, side-effect-free — the menu handler shows this list
 * to the user before writing.
 */
export function collectReportFiles(cwd: string, taskDir: string | null): ReportFile[] {
  const files: ReportFile[] = [];
  const seen = new Set<string>();
  const add = (abs: string, archivePath: string) => {
    if (!existsSync(abs)) return;
    try { if (!statSync(abs).isFile()) return; } catch { return; }
    const key = abs;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ path: abs, archivePath });
  };

  const ppDir = join(cwd, ".pp");

  // 1. Task state files + artifacts (the whole task dir under .pp/state/...).
  if (taskDir && existsSync(taskDir)) {
    for (const f of walkFiles(taskDir)) {
      add(f, join("task-state", relative(taskDir, f)));
    }
    // 2. The MAPPED per-task debug log: taskLogsDir(taskDir)/debug.jsonl under
    //    .pp/logs/<type>/<task>/ (NOT <taskDir>/logs).
    const logDir = taskLogsDir(taskDir);
    const debugLog = join(logDir, "debug.jsonl");
    add(debugLog, join("task-logs", "debug.jsonl"));
  }

  // 3. Session logs: .pp/logs/session-*.jsonl.
  const logsDir = join(ppDir, "logs");
  if (existsSync(logsDir)) {
    for (const name of safeReaddir(logsDir)) {
      if (name.startsWith("session-") && name.endsWith(".jsonl")) {
        add(join(logsDir, name), join("session-logs", name));
      }
    }
  }

  // 4. Traces, when present: .pp/logs/traces/**.
  const tracesDir = join(ppDir, "logs", "traces");
  if (existsSync(tracesDir)) {
    for (const f of walkFiles(tracesDir)) {
      add(f, join("traces", relative(tracesDir, f)));
    }
  }

  return files;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface WrittenReport {
  reportDir: string;
  captured: string[]; // archive-relative paths actually written
}

/**
 * Write the report bundle: the user note plus every collected file, copied under
 * a fresh <cwd>/.pp/reports/report-<unixms>/ directory. Returns the dir and the
 * list of captured archive paths. No network access.
 */
export function writeReportBundle(cwd: string, note: string, files: ReportFile[]): WrittenReport {
  const reportsRoot = join(cwd, ".pp", "reports");
  const reportDir = join(reportsRoot, `report-${Date.now()}`);
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, "note.md"), `# pi-pi Report\n\n${note}\n`, "utf-8");
  const captured: string[] = ["note.md"];

  for (const f of files) {
    const dest = join(reportDir, f.archivePath);
    mkdirSync(dest.slice(0, dest.lastIndexOf(sep)), { recursive: true });
    try {
      writeFileSync(dest, readFileSync(f.path));
      captured.push(f.archivePath);
    } catch {
      // Skip unreadable files rather than failing the whole bundle.
    }
  }

  return { reportDir, captured };
}
