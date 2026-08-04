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

  it("surfaces legacy brainstorm tasks alongside legacy debug tasks", () => {
    const cwd = makeCwd();
    const brainstormDir = writeDoneTask(cwd, "brainstorm", "def456_idea", "done");
    const debugDir = writeDoneTask(cwd, "debug", "abc123_legacy", "done");

    const results = listCompletedFromTasks(cwd);
    const dirs = results.map((t) => t.dir);
    expect(dirs).toContain(brainstormDir);
    expect(dirs).toContain(debugDir);
  });
});

// The brainstorm TASK type was removed; .pp/state/brainstorm is now a read-only
// archive read via raw JSON.parse. Unlike the debug archive it carries NO phase
// filter: a legacy brainstorm task can never be resumed again, so requiring
// phase === "done" would permanently strand artifacts from one the user simply
// never formally completed.
describe("listCompletedFromTasks legacy brainstorm archive", () => {
  it("offers an UNFINISHED legacy brainstorm task that has both artifacts", () => {
    const cwd = makeCwd();
    const dir = writeDoneTask(cwd, "brainstorm", "abc123_unfinished", "brainstorm");

    const results = listCompletedFromTasks(cwd);
    expect(results.map((t) => t.dir)).toContain(dir);
  });

  it("surfaces legacy brainstorm entries under the supported implement type", () => {
    const cwd = makeCwd();
    const dir = writeDoneTask(cwd, "brainstorm", "abc123_typed", "brainstorm");

    const entry = listCompletedFromTasks(cwd).find((t) => t.dir === dir);
    expect(entry?.type).toBe("implement");
  });

  it("skips a legacy brainstorm task missing USER_REQUEST.md", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".pp", "state", "brainstorm", "abc123_no_ur");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ phase: "brainstorm", description: "brainstorm", startedAt: new Date().toISOString() }), "utf-8");
    writeFileSync(join(dir, "RESEARCH.md"), "## Affected Code\ncontent\n", "utf-8");

    expect(listCompletedFromTasks(cwd).map((t) => t.dir)).not.toContain(dir);
  });

  it("skips a legacy brainstorm task missing RESEARCH.md", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".pp", "state", "brainstorm", "abc123_no_res");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ phase: "brainstorm", description: "brainstorm", startedAt: new Date().toISOString() }), "utf-8");
    writeFileSync(join(dir, "USER_REQUEST.md"), "# User Request\ncontent\n", "utf-8");

    expect(listCompletedFromTasks(cwd).map((t) => t.dir)).not.toContain(dir);
  });

  it("skips a legacy brainstorm dir whose state.json is malformed or not an object", () => {
    const cwd = makeCwd();
    for (const [id, body] of [["abc123_bad", "{ not json"], ["abc123_prim", "42"], ["abc123_arr", "[]"]] as const) {
      const dir = join(cwd, ".pp", "state", "brainstorm", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), body, "utf-8");
      writeFileSync(join(dir, "USER_REQUEST.md"), "# User Request\ncontent\n", "utf-8");
      writeFileSync(join(dir, "RESEARCH.md"), "## Affected Code\ncontent\n", "utf-8");
    }

    expect(listCompletedFromTasks(cwd)).toHaveLength(0);
  });

  it("still excludes an UNFINISHED review task (review stays resumable, so done-only)", () => {
    const cwd = makeCwd();
    const reviewDir = writeDoneTask(cwd, "review", "abc123_active_review", "review");

    expect(listCompletedFromTasks(cwd).map((t) => t.dir)).not.toContain(reviewDir);
  });

  it("orders mixed legacy and live sources newest-first by startedAt", () => {
    const cwd = makeCwd();
    const older = join(cwd, ".pp", "state", "brainstorm", "abc123_older");
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, "state.json"), JSON.stringify({ phase: "brainstorm", description: "brainstorm", startedAt: "2020-01-01T00:00:00.000Z" }), "utf-8");
    writeFileSync(join(older, "USER_REQUEST.md"), "# User Request\ncontent\n", "utf-8");
    writeFileSync(join(older, "RESEARCH.md"), "## Affected Code\ncontent\n", "utf-8");

    const newer = join(cwd, ".pp", "state", "review", "abc123_newer");
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, "state.json"), JSON.stringify({ phase: "done", description: "review", startedAt: "2030-01-01T00:00:00.000Z" }), "utf-8");
    writeFileSync(join(newer, "USER_REQUEST.md"), "# User Request\ncontent\n", "utf-8");
    writeFileSync(join(newer, "RESEARCH.md"), "## Affected Code\ncontent\n", "utf-8");

    const dirs = listCompletedFromTasks(cwd).map((t) => t.dir);
    expect(dirs).toEqual([newer, older]);
  });
});
