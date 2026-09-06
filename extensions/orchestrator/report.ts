import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Local-only feedback bundle: a user-typed note plus session logs and traces,
// written under <cwd>/.pp/reports/report-<ts>/. ZERO network egress.

export interface ReportFile {
  path: string;
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
  for (const entry of entries) {
    const full = join(dir, String(entry.name));
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function collectReportFiles(cwd: string): ReportFile[] {
  const files: ReportFile[] = [];
  const seen = new Set<string>();
  const add = (abs: string, archivePath: string) => {
    if (seen.has(abs) || !existsSync(abs)) return;
    try { if (!statSync(abs).isFile()) return; } catch { return; }
    seen.add(abs);
    files.push({ path: abs, archivePath });
  };

  const logsDir = join(cwd, ".pp", "logs");
  if (existsSync(logsDir)) {
    let names: string[] = [];
    try { names = readdirSync(logsDir); } catch {}
    for (const name of names) {
      if (name.startsWith("session-") && name.endsWith(".jsonl")) add(join(logsDir, name), join("session-logs", name));
    }
  }

  const tracesDir = join(logsDir, "traces");
  if (existsSync(tracesDir)) {
    for (const file of walkFiles(tracesDir)) add(file, join("traces", relative(tracesDir, file)));
  }

  return files;
}

export interface WrittenReport {
  reportDir: string;
  captured: string[];
}

export function writeReportBundle(cwd: string, note: string, files: ReportFile[]): WrittenReport {
  const reportDir = join(cwd, ".pp", "reports", `report-${Date.now()}`);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "note.md"), `# pi-pi Report\n\n${note}\n`, "utf-8");
  const captured: string[] = ["note.md"];
  for (const file of files) {
    const dest = join(reportDir, file.archivePath);
    mkdirSync(dest.slice(0, dest.lastIndexOf(sep)), { recursive: true });
    try {
      writeFileSync(dest, readFileSync(file.path));
      captured.push(file.archivePath);
    } catch {}
  }
  return { reportDir, captured };
}
