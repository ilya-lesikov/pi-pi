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
    expect(canTransition("implement", "brainstorm", "plan")).toBe(true);
    expect(canTransition("implement", "plan", "implement")).toBe(true);
    expect(canTransition("implement", "implement", "done")).toBe(true);

    expect(canTransition("implement", "brainstorm", "done")).toBe(false);
    expect(canTransition("implement", "plan", "done")).toBe(false);
    expect(canTransition("implement", "done", "implement")).toBe(false);
  });

  it("handles debug transitions", () => {
    expect(canTransition("debug", "debug", "done")).toBe(true);
    expect(canTransition("debug", "debug", "plan")).toBe(false);
    expect(canTransition("debug", "done", "debug")).toBe(false);
  });

  it("handles brainstorm transitions", () => {
    expect(canTransition("brainstorm", "brainstorm", "done")).toBe(true);
    expect(canTransition("brainstorm", "brainstorm", "plan")).toBe(false);
    expect(canTransition("brainstorm", "done", "brainstorm")).toBe(false);
  });
});

describe("nextPhase", () => {
  it("returns implement next phase and terminal null", () => {
    expect(nextPhase("implement", "brainstorm")).toBe("plan");
    expect(nextPhase("implement", "plan")).toBe("implement");
    expect(nextPhase("implement", "implement")).toBe("done");
    expect(nextPhase("implement", "done")).toBeNull();
  });

  it("returns debug next phase and terminal null", () => {
    expect(nextPhase("debug", "debug")).toBe("done");
    expect(nextPhase("debug", "done")).toBeNull();
  });

  it("returns brainstorm next phase and terminal null", () => {
    expect(nextPhase("brainstorm", "brainstorm")).toBe("done");
    expect(nextPhase("brainstorm", "done")).toBeNull();
  });
});

describe("phasePipeline", () => {
  it("returns implement pipeline", () => {
    expect(phasePipeline("implement")).toEqual(["brainstorm", "plan", "implement", "done"]);
  });

  it("returns debug pipeline", () => {
    expect(phasePipeline("debug")).toEqual(["debug", "done"]);
  });

  it("returns brainstorm pipeline", () => {
    expect(phasePipeline("brainstorm")).toEqual(["brainstorm", "done"]);
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

  it("validates plan artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "plan")).toEqual({
      ok: false,
      reason: "No synthesized plan found in plans/",
    });

    const noSynth = makeTempDir();
    mkdirSync(join(noSynth, "plans"), { recursive: true });
    writeFileSync(join(noSynth, "plans", "draft.md"), "draft", "utf-8");
    expect(validateExitCriteria(noSynth, "implement", "plan")).toEqual({
      ok: false,
      reason: "No synthesized plan found in plans/",
    });

    const pass = makeTempDir();
    mkdirSync(join(pass, "plans"), { recursive: true });
    writeFileSync(join(pass, "plans", "synthesized-plan.md"), "content", "utf-8");
    expect(validateExitCriteria(pass, "implement", "plan")).toEqual({ ok: true });
  });

  it("validates implement checkboxes", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "implement")).toEqual({
      ok: false,
      reason: "No synthesized plan found",
    });

    const noSynth = makeTempDir();
    mkdirSync(join(noSynth, "plans"), { recursive: true });
    writeFileSync(join(noSynth, "plans", "plan.md"), "content", "utf-8");
    expect(validateExitCriteria(noSynth, "implement", "implement")).toEqual({
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
    expect(validateExitCriteria(unchecked, "implement", "implement")).toEqual({
      ok: false,
      reason: "2 plan items still unchecked",
    });

    const checked = makeTempDir();
    mkdirSync(join(checked, "plans"), { recursive: true });
    writeFileSync(join(checked, "plans", "synthesized-plan.md"), "- [x] done\n", "utf-8");
    expect(validateExitCriteria(checked, "implement", "implement")).toEqual({ ok: true });
  });

  it("picks the numerically latest synthesized plan for implement validation", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans", "2_synthesized.md"), "- [x] all done\n", "utf-8");
    writeFileSync(join(dir, "plans", "11_synthesized.md"), "- [ ] not done\n", "utf-8");
    expect(validateExitCriteria(dir, "implement", "implement")).toEqual({
      ok: false,
      reason: "1 plan items still unchecked",
    });
  });

  it("passes implement validation when the numerically latest plan is fully checked", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans", "2_synthesized.md"), "- [ ] old unchecked\n", "utf-8");
    writeFileSync(join(dir, "plans", "11_synthesized.md"), "- [x] all done\n", "utf-8");
    expect(validateExitCriteria(dir, "implement", "implement")).toEqual({ ok: true });
  });

  it("handles brainstorm phase for brainstorm task", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(dir, "RESEARCH.md"), "research", "utf-8");
    expect(validateExitCriteria(dir, "brainstorm", "brainstorm")).toEqual({ ok: true });
  });

  it("validates debug artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "debug", "debug")).toEqual({
      ok: false,
      reason: "USER_REQUEST.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), "research", "utf-8");
    expect(validateExitCriteria(pass, "debug", "debug")).toEqual({ ok: true });
  });

  it("returns unknown phase error for done", () => {
    const dir = makeTempDir();
    expect(validateExitCriteria(dir, "implement", "done")).toEqual({
      ok: false,
      reason: "Unknown phase: done",
    });
  });
});
