import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectReportFiles, writeReportBundle } from "./report.js";

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-report-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(cwd: string): void {
  const logs = join(cwd, ".pp", "logs");
  mkdirSync(join(logs, "traces", "task-1"), { recursive: true });
  writeFileSync(join(logs, "session-a.jsonl"), "{\"a\":1}\n");
  writeFileSync(join(logs, "other.jsonl"), "not a session log");
  writeFileSync(join(logs, "session-b.txt"), "wrong suffix");
  mkdirSync(join(logs, "session-dir.jsonl"));
  writeFileSync(join(logs, "traces", "root.json"), "{}");
  writeFileSync(join(logs, "traces", "task-1", "w.json"), "{\"w\":1}");
}

describe("collectReportFiles", () => {
  it("returns nothing for a project with no logs", () => {
    expect(collectReportFiles(project())).toEqual([]);
  });

  it("collects session logs and every trace, mapped into the bundle layout", () => {
    const cwd = project();
    seed(cwd);
    const logs = join(cwd, ".pp", "logs");
    const files = collectReportFiles(cwd);
    expect(files).toHaveLength(3);
    expect(files).toEqual(expect.arrayContaining([
      { path: join(logs, "session-a.jsonl"), archivePath: join("session-logs", "session-a.jsonl") },
      { path: join(logs, "traces", "root.json"), archivePath: join("traces", "root.json") },
      { path: join(logs, "traces", "task-1", "w.json"), archivePath: join("traces", "task-1", "w.json") },
    ]));
  });
});

describe("writeReportBundle", () => {
  it("writes the note and copies every collected file under .pp/reports", () => {
    const cwd = project();
    seed(cwd);
    const written = writeReportBundle(cwd, "it broke", collectReportFiles(cwd));
    expect(written.reportDir.startsWith(join(cwd, ".pp", "reports", "report-"))).toBe(true);
    expect(readFileSync(join(written.reportDir, "note.md"), "utf-8")).toBe("# pi-pi Report\n\nit broke\n");
    expect(readFileSync(join(written.reportDir, "traces", "task-1", "w.json"), "utf-8")).toBe("{\"w\":1}");
    expect(readFileSync(join(written.reportDir, "session-logs", "session-a.jsonl"), "utf-8")).toBe("{\"a\":1}\n");
    expect(written.captured.sort()).toEqual(
      ["note.md", join("session-logs", "session-a.jsonl"), join("traces", "root.json"), join("traces", "task-1", "w.json")].sort(),
    );
  });

  it("skips a file that vanished after collection without failing the bundle", () => {
    const cwd = project();
    const written = writeReportBundle(cwd, "note", [{ path: join(cwd, "gone.jsonl"), archivePath: join("session-logs", "gone.jsonl") }]);
    expect(written.captured).toEqual(["note.md"]);
    expect(existsSync(join(written.reportDir, "session-logs", "gone.jsonl"))).toBe(false);
  });
});
