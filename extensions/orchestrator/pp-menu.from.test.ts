import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listCompletedFromTasks } from "./pp-menu.js";

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "pp-from-"));
}

function writeDoneTask(cwd: string, type: string, id: string, phase: string): string {
  const dir = join(cwd, ".pp", "state", type, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ phase, step: null, reviewCycle: null, reviewPass: 0, from: null, description: type, startedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  writeFileSync(join(dir, "USER_REQUEST.md"), "# User Request\ncontent\n", "utf-8");
  writeFileSync(join(dir, "RESEARCH.md"), "## Affected Code\ncontent\n", "utf-8");
  return dir;
}

describe("listCompletedFromTasks", () => {
  it("surfaces a legacy done debug task with artifacts", () => {
    const cwd = makeCwd();
    const debugDir = writeDoneTask(cwd, "debug", "abc123_legacy", "done");

    const results = listCompletedFromTasks(cwd);
    expect(results.map((t) => t.dir)).toContain(debugDir);
  });

  it("skips a legacy debug task that is not done", () => {
    const cwd = makeCwd();
    const debugDir = writeDoneTask(cwd, "debug", "abc123_active", "debug");

    const results = listCompletedFromTasks(cwd);
    expect(results.map((t) => t.dir)).not.toContain(debugDir);
  });

  it("skips a legacy debug task missing artifacts", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".pp", "state", "debug", "abc123_bare");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ phase: "done", step: null, reviewCycle: null, reviewPass: 0, from: null, description: "debug", startedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );

    const results = listCompletedFromTasks(cwd);
    expect(results.map((t) => t.dir)).not.toContain(dir);
  });

  it("surfaces done brainstorm tasks alongside legacy debug tasks", () => {
    const cwd = makeCwd();
    const brainstormDir = writeDoneTask(cwd, "brainstorm", "def456_idea", "done");
    const debugDir = writeDoneTask(cwd, "debug", "abc123_legacy", "done");

    const results = listCompletedFromTasks(cwd);
    const dirs = results.map((t) => t.dir);
    expect(dirs).toContain(brainstormDir);
    expect(dirs).toContain(debugDir);
  });
});
