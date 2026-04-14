import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { canTransition, nextPhase, phasePipeline, validateExitCriteria } from "./machine.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-machine-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("canTransition", () => {
  it("handles implement transitions", () => {
    expect(canTransition("implement", "brainstorm", "planning")).toBe(true);
    expect(canTransition("implement", "planning", "implementation")).toBe(true);
    expect(canTransition("implement", "implementation", "review")).toBe(true);
    expect(canTransition("implement", "review", "done")).toBe(true);

    expect(canTransition("implement", "brainstorm", "done")).toBe(false);
    expect(canTransition("implement", "planning", "review")).toBe(false);
    expect(canTransition("implement", "done", "review")).toBe(false);
  });

  it("handles debug transitions", () => {
    expect(canTransition("debug", "diagnosing", "done")).toBe(true);
    expect(canTransition("debug", "diagnosing", "review")).toBe(false);
    expect(canTransition("debug", "done", "diagnosing")).toBe(false);
  });

  it("handles brainstorm transitions", () => {
    expect(canTransition("brainstorm", "active", "done")).toBe(true);
    expect(canTransition("brainstorm", "active", "planning")).toBe(false);
    expect(canTransition("brainstorm", "done", "active")).toBe(false);
  });
});

describe("nextPhase", () => {
  it("returns implement next phase and terminal null", () => {
    expect(nextPhase("implement", "brainstorm")).toBe("planning");
    expect(nextPhase("implement", "planning")).toBe("implementation");
    expect(nextPhase("implement", "implementation")).toBe("review");
    expect(nextPhase("implement", "review")).toBe("done");
    expect(nextPhase("implement", "done")).toBeNull();
  });

  it("returns debug next phase and terminal null", () => {
    expect(nextPhase("debug", "diagnosing")).toBe("done");
    expect(nextPhase("debug", "done")).toBeNull();
  });

  it("returns brainstorm next phase and terminal null", () => {
    expect(nextPhase("brainstorm", "active")).toBe("done");
    expect(nextPhase("brainstorm", "done")).toBeNull();
  });
});

describe("phasePipeline", () => {
  it("returns implement pipeline", () => {
    expect(phasePipeline("implement")).toEqual(["brainstorm", "planning", "implementation", "review", "done"]);
  });

  it("returns debug pipeline", () => {
    expect(phasePipeline("debug")).toEqual(["diagnosing", "done"]);
  });

  it("returns brainstorm pipeline", () => {
    expect(phasePipeline("brainstorm")).toEqual(["active", "done"]);
  });
});

describe("validateExitCriteria", () => {
  it("validates brainstorm artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "brainstorm")).toEqual({
      ok: false,
      reason: "USER_REQUEST.md does not exist or is empty",
    });

    const emptyResearch = makeTempDir();
    writeFileSync(join(emptyResearch, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(emptyResearch, "RESEARCH.md"), "\n  \n", "utf-8");
    expect(validateExitCriteria(emptyResearch, "implement", "brainstorm")).toEqual({
      ok: false,
      reason: "RESEARCH.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), "research", "utf-8");
    expect(validateExitCriteria(pass, "implement", "brainstorm")).toEqual({ ok: true });
  });

  it("validates planning artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "planning")).toEqual({
      ok: false,
      reason: "No plans directory found",
    });

    const noSynth = makeTempDir();
    mkdirSync(join(noSynth, "plans"), { recursive: true });
    writeFileSync(join(noSynth, "plans", "draft.md"), "draft", "utf-8");
    expect(validateExitCriteria(noSynth, "implement", "planning")).toEqual({
      ok: false,
      reason: "No synthesized plan found in plans/",
    });

    const pass = makeTempDir();
    mkdirSync(join(pass, "plans"), { recursive: true });
    writeFileSync(join(pass, "plans", "synthesized-plan.md"), "content", "utf-8");
    expect(validateExitCriteria(pass, "implement", "planning")).toEqual({ ok: true });
  });

  it("validates implementation checkboxes", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "implementation")).toEqual({
      ok: false,
      reason: "No plans directory found",
    });

    const noSynth = makeTempDir();
    mkdirSync(join(noSynth, "plans"), { recursive: true });
    writeFileSync(join(noSynth, "plans", "plan.md"), "content", "utf-8");
    expect(validateExitCriteria(noSynth, "implement", "implementation")).toEqual({
      ok: false,
      reason: "No synthesized plan found",
    });

    const unchecked = makeTempDir();
    mkdirSync(join(unchecked, "plans"), { recursive: true });
    writeFileSync(
      join(unchecked, "plans", "2026-04-20_synthesized.md"),
      "- [ ] first\n- [ ] second\n- [x] done\n",
      "utf-8",
    );
    expect(validateExitCriteria(unchecked, "implement", "implementation")).toEqual({
      ok: false,
      reason: "2 plan items still unchecked",
    });

    const checked = makeTempDir();
    mkdirSync(join(checked, "plans"), { recursive: true });
    writeFileSync(join(checked, "plans", "synthesized-plan.md"), "- [x] done\n", "utf-8");
    expect(validateExitCriteria(checked, "implement", "implementation")).toEqual({ ok: true });
  });

  it("handles review and active phases", () => {
    const dir = makeTempDir();
    expect(validateExitCriteria(dir, "implement", "review")).toEqual({ ok: true });
    expect(validateExitCriteria(dir, "brainstorm", "active")).toEqual({ ok: true });
  });

  it("validates diagnosing artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "debug", "diagnosing")).toEqual({
      ok: false,
      reason: "USER_REQUEST.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), "research", "utf-8");
    expect(validateExitCriteria(pass, "debug", "diagnosing")).toEqual({ ok: true });
  });

  it("returns unknown phase error for done", () => {
    const dir = makeTempDir();
    expect(validateExitCriteria(dir, "implement", "done")).toEqual({
      ok: false,
      reason: "Unknown phase: done",
    });
  });
});
