import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { canTransition, nextPhase, phasePipeline, validateExitCriteria } from "./machine.js";

const tempDirs: string[] = [];

const VALID_USER_REQUEST = `# User Request
Fix the auth bug.

## Problem
Auth tokens expire incorrectly.

## Constraints
Must be backward compatible.
`;

const VALID_RESEARCH = `## Affected Code
src/auth.ts:validateToken — validates JWT tokens

## Architecture Context
- Auth middleware calls validateToken on every request

## Constraints & Edge Cases
- MUST: Existing tokens must remain valid
- RISK: Token refresh flow may break
`;

function makeValidPlan(checklist: string[]): string {
  return `# Plan

## Scope
Fix token validation in auth middleware. Does not change token format.

## Checklist
${checklist.join("\n")}
`;
}

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
    expect(canTransition("debug", "debug", "plan")).toBe(true);
    expect(canTransition("debug", "debug", "done")).toBe(false);
    expect(canTransition("debug", "done", "debug")).toBe(false);
  });

  it("handles brainstorm transitions", () => {
    expect(canTransition("brainstorm", "brainstorm", "plan")).toBe(true);
    expect(canTransition("brainstorm", "brainstorm", "done")).toBe(false);
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
    expect(nextPhase("debug", "debug")).toBe("plan");
    expect(nextPhase("debug", "done")).toBeNull();
  });

  it("returns brainstorm next phase and terminal null", () => {
    expect(nextPhase("brainstorm", "brainstorm")).toBe("plan");
    expect(nextPhase("brainstorm", "done")).toBeNull();
  });
});

describe("phasePipeline", () => {
  it("returns implement pipeline", () => {
    expect(phasePipeline("implement")).toEqual(["brainstorm", "plan", "implement", "done"]);
  });

  it("returns debug pipeline", () => {
    expect(phasePipeline("debug")).toEqual(["debug", "plan", "implement", "done"]);
  });

  it("returns brainstorm pipeline", () => {
    expect(phasePipeline("brainstorm")).toEqual(["brainstorm", "plan", "implement", "done"]);
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
    writeFileSync(join(emptyResearch, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(emptyResearch, "RESEARCH.md"), "\n  \n", "utf-8");
    expect(validateExitCriteria(emptyResearch, "implement", "brainstorm")).toEqual({
      ok: false,
      reason: "RESEARCH.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
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
    writeFileSync(
      join(pass, "plans", "synthesized-plan.md"),
      makeValidPlan(["- [ ] P1. Fix token expiry check — Done when: expired tokens are rejected consistently"]),
      "utf-8",
    );
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
      makeValidPlan([
        "- [ ] P1. First item — Done when: first item remains unchecked",
        "- [ ] P2. Second item — Done when: second item remains unchecked",
        "- [x] P3. Completed item — Done when: completed item is checked",
      ]),
      "utf-8",
    );
    expect(validateExitCriteria(unchecked, "implement", "implement")).toEqual({
      ok: false,
      reason: "2 plan items still unchecked",
    });

    const checked = makeTempDir();
    mkdirSync(join(checked, "plans"), { recursive: true });
    writeFileSync(
      join(checked, "plans", "synthesized-plan.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: all checklist items are checked"]),
      "utf-8",
    );
    expect(validateExitCriteria(checked, "implement", "implement")).toEqual({ ok: true });
  });

  it("picks the numerically latest synthesized plan for implement validation", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(
      join(dir, "plans", "2_synthesized.md"),
      makeValidPlan(["- [x] P1. Older checked item — Done when: old plan stays checked"]),
      "utf-8",
    );
    writeFileSync(
      join(dir, "plans", "11_synthesized.md"),
      makeValidPlan(["- [ ] P1. Latest unchecked item — Done when: latest plan has an unchecked item"]),
      "utf-8",
    );
    expect(validateExitCriteria(dir, "implement", "implement")).toEqual({
      ok: false,
      reason: "1 plan items still unchecked",
    });
  });

  it("passes implement validation when the numerically latest plan is fully checked", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(
      join(dir, "plans", "2_synthesized.md"),
      makeValidPlan(["- [ ] P1. Older unchecked item — Done when: old plan keeps one unchecked item"]),
      "utf-8",
    );
    writeFileSync(
      join(dir, "plans", "11_synthesized.md"),
      makeValidPlan(["- [x] P1. Latest checked item — Done when: latest plan is fully checked"]),
      "utf-8",
    );
    expect(validateExitCriteria(dir, "implement", "implement")).toEqual({ ok: true });
  });

  it("counts unchecked items only within checklist section", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(
      join(dir, "plans", "synthesized-plan.md"),
      `# Plan

## Scope
Fix bug.

## Checklist
- [x] Main task — Done when: implemented

## Blockers
- [ ] waiting on external team
`,
      "utf-8",
    );
    expect(validateExitCriteria(dir, "implement", "implement")).toEqual({ ok: true });
  });

  it("handles brainstorm phase for brainstorm task — always passes", () => {
    const dir = makeTempDir();
    expect(validateExitCriteria(dir, "brainstorm", "brainstorm")).toEqual({ ok: true });
  });

  it("validates brainstorm phase for implement task — requires artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "implement", "brainstorm")).toEqual({
      ok: false,
      reason: "USER_REQUEST.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expect(validateExitCriteria(pass, "implement", "brainstorm")).toEqual({ ok: true });
  });

  it("validates debug artifacts", () => {
    const missing = makeTempDir();
    expect(validateExitCriteria(missing, "debug", "debug")).toEqual({
      ok: false,
      reason: "USER_REQUEST.md does not exist or is empty",
    });

    const pass = makeTempDir();
    writeFileSync(join(pass, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(pass, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
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
