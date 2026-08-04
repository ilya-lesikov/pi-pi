import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyPlanVariants, isPlanComplete, isPlanStub, PLAN_STUB_CONTENT } from "./plan-files.js";

const VALID_PLAN = [
  "# Plan",
  "",
  "## Scope",
  "Do the thing.",
  "",
  "## Checklist",
  "",
  "- [ ] Thing is done — Done when: the test passes",
  "",
].join("\n");

function makePlansDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-plan-files-"));
  const plansDir = join(dir, "plans");
  mkdirSync(plansDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(plansDir, name), content);
  }
  return plansDir;
}

describe("isPlanStub", () => {
  it("recognizes the stub marker alone, case-insensitively and whitespace-tolerantly", () => {
    expect(isPlanStub(PLAN_STUB_CONTENT)).toBe(true);
    expect(isPlanStub("PLAN_STATUS: INCOMPLETE\n")).toBe(true);
    expect(isPlanStub("  plan_status :  incomplete  \n")).toBe(true);
  });

  it("rejects anything that carries real plan content", () => {
    expect(isPlanStub(VALID_PLAN)).toBe(false);
    expect(isPlanStub(`${VALID_PLAN}\nPLAN_STATUS: INCOMPLETE`)).toBe(false);
    expect(isPlanStub("")).toBe(false);
  });
});

describe("isPlanComplete", () => {
  it("treats an explicit COMPLETE marker as complete", () => {
    expect(isPlanComplete(`${VALID_PLAN}\nPLAN_STATUS: COMPLETE\n`)).toBe(true);
    expect(isPlanComplete(`${VALID_PLAN}\nplan_status:complete\n`)).toBe(true);
  });

  it("treats an INCOMPLETE marker as incomplete even alongside real content", () => {
    expect(isPlanComplete(PLAN_STUB_CONTENT)).toBe(false);
    expect(isPlanComplete(`${VALID_PLAN}\nPLAN_STATUS: INCOMPLETE\n`)).toBe(false);
  });

  it("lets INCOMPLETE win when both markers are present", () => {
    expect(isPlanComplete(`PLAN_STATUS: INCOMPLETE\n${VALID_PLAN}\nPLAN_STATUS: COMPLETE`)).toBe(false);
  });

  it("falls back to structural validity for legacy marker-less plans", () => {
    expect(isPlanComplete(VALID_PLAN)).toBe(true);
    expect(isPlanComplete("# Plan\n\nnot really a plan\n")).toBe(false);
    expect(isPlanComplete("")).toBe(false);
  });
});

describe("classifyPlanVariants", () => {
  it("reports a stub-only variant as incomplete and offers no file to synthesis", () => {
    const plansDir = makePlansDir({ "100_fable.md": PLAN_STUB_CONTENT });
    const out = classifyPlanVariants(plansDir, ["fable", "gpt"]);
    expect(out.completeFiles).toEqual([]);
    expect(out.incompleteVariants).toEqual(["fable", "gpt"]);
  });

  it("counts a variant complete when ANY of its files is complete (stale stub beside a respawn)", () => {
    // A respawn writes a NEW timestamped file and leaves the earlier stub in
    // place; the variant is finished and only the COMPLETE file feeds synthesis.
    const plansDir = makePlansDir({
      "100_fable.md": PLAN_STUB_CONTENT,
      "200_fable.md": `${VALID_PLAN}\nPLAN_STATUS: COMPLETE\n`,
    });
    const out = classifyPlanVariants(plansDir, ["fable"]);
    expect(out.completeVariants.has("fable")).toBe(true);
    expect(out.incompleteVariants).toEqual([]);
    expect(out.completeFiles).toEqual([join(plansDir, "200_fable.md")]);
  });

  it("separates complete from incomplete variants in a mixed outcome", () => {
    const plansDir = makePlansDir({
      "100_fable.md": `${VALID_PLAN}\nPLAN_STATUS: COMPLETE\n`,
      "100_gpt.md": PLAN_STUB_CONTENT,
    });
    const out = classifyPlanVariants(plansDir, ["fable", "gpt"]);
    expect([...out.completeVariants]).toEqual(["fable"]);
    expect(out.incompleteVariants).toEqual(["gpt"]);
    expect(out.completeFiles).toEqual([join(plansDir, "100_fable.md")]);
  });

  it("ignores synthesized plans and review files", () => {
    const plansDir = makePlansDir({
      "100_synthesized.md": `${VALID_PLAN}\nPLAN_STATUS: COMPLETE\n`,
      "100_review_fable.md": `${VALID_PLAN}\nPLAN_STATUS: COMPLETE\n`,
    });
    const out = classifyPlanVariants(plansDir, ["fable"]);
    expect(out.completeFiles).toEqual([]);
    expect(out.incompleteVariants).toEqual(["fable"]);
  });

  it("handles a missing plans directory", () => {
    const out = classifyPlanVariants(join(tmpdir(), "pp-does-not-exist-xyz", "plans"), ["fable"]);
    expect(out.completeFiles).toEqual([]);
    expect(out.incompleteVariants).toEqual(["fable"]);
  });
});
