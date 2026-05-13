import { describe, expect, it } from "vitest";
import { validatePlan, validateUserRequest } from "./validate-artifacts.js";

describe("validateUserRequest", () => {
  it("rejects placeholder distillation and constraints content", () => {
    const content = `# User Request
TBD

## Problem
Real problem statement.

## Constraints
-
`;

    const result = validateUserRequest(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      "Distillation is missing between # User Request and the first ## section. Expected 1-3 non-empty sentences.",
    );
    expect(result.errors).toContain("Section ## Constraints is empty. Expected non-empty constraints.");
  });
});

describe("validatePlan", () => {
  it("ignores checkbox items outside Checklist section", () => {
    const content = `# Plan

## Scope
Ship minimal fix.

## Checklist
- [ ] Implement fix — Done when: tests pass

## Blockers
- [ ] external dependency not resolved
`;

    const result = validatePlan(content);
    expect(result.ok).toBe(true);
  });

  it("accepts multiline Done when continuation", () => {
    const content = `# Plan

## Scope
Ship minimal fix.

## Checklist
- [ ] Implement fix
  Done when: tests pass and docs updated
`;

    const result = validatePlan(content);
    expect(result.ok).toBe(true);
  });

  it("accepts section names with trailing colon or inline text", () => {
    const content = `# Plan

## Scope: Handle panics gracefully
Ship minimal fix.

## Checklist:
- [ ] Implement fix — Done when: tests pass
`;

    const result = validatePlan(content);
    expect(result.ok).toBe(true);
  });

  it("rejects placeholder scope", () => {
    const content = `# Plan

## Scope
...

## Checklist
- [ ] Implement fix — Done when: tests pass
`;

    const result = validatePlan(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Section ## Scope is empty. Expected 2-4 lines summarizing scope and constraints.");
  });
});
