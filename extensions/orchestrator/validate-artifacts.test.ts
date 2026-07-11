import { describe, expect, it } from "vitest";
import { validateArtifact, validatePlan, validateResearch, validateUserRequest } from "./validate-artifacts.js";

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

  it("accepts a Pattern constraints section", () => {
    const content = `# Plan

## Scope
Add a new annotation.

## Checklist
- [ ] Add annotation — Done when: tests pass

## Pattern constraints
- Mirror deletePolicies: one typed slice, kebab-case values.

## Blockers
- none
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

describe("validateResearch", () => {
  it("accepts valid research content", () => {
    const content = `## Affected Code
src/main.ts:run — entry point

## Architecture Context
- Main flow calls run and dispatches handlers

## Constraints & Edge Cases
- MUST: Keep behavior backward compatible
- RISK: Regression in startup path

## Open Questions
Need confirmation about deprecated flag
`;

    const result = validateResearch(content);

    expect(result.ok).toBe(true);
  });

  it("fails when required sections are missing", () => {
    const content = `## Affected Code
src/main.ts:run — entry point

## Constraints & Edge Cases
- MUST: Keep behavior backward compatible
`;

    const result = validateResearch(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("Missing required section: ## Architecture Context"))).toBe(true);
  });

  it("fails when affected code section is empty", () => {
    const content = `## Affected Code
...

## Architecture Context
- Main flow calls run and dispatches handlers

## Constraints & Edge Cases
- MUST: Keep behavior backward compatible
`;

    const result = validateResearch(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Section ## Affected Code is empty. Expected non-empty content.");
  });
});

describe("validateArtifact", () => {
  it("accepts valid artifact with top-level title", () => {
    const content = `# Risk Analysis

- First risk
- Second risk
`;

    const result = validateArtifact(content);

    expect(result.ok).toBe(true);
  });

  it("fails when top-level title heading is missing", () => {
    const content = `## Risk Analysis

- First risk
`;

    const result = validateArtifact(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("Expected a top-level heading"))).toBe(true);
  });
});
