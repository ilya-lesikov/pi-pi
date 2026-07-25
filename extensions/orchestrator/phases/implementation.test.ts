import { describe, it, expect } from "vitest";
import { implementationSystemPrompt } from "./implementation.js";

describe("implementationSystemPrompt self-complete directive", () => {
  it("instructs the agent to call pp_phase_complete when the implement phase is complete", () => {
    const prompt = implementationSystemPrompt("/tmp/task", "/tmp");
    expect(prompt).toContain("pp_phase_complete");
    expect(prompt).toContain("Do NOT instead ask the user to run /pp manually");
    expect(prompt).not.toContain("do NOT wait for the user");
  });
});

describe("implement-phase verification gate + conditional test-first", () => {
  const prompt = implementationSystemPrompt("/tmp/task", "/tmp");

  it("gates completion claims on fresh evidence with an explicit not-applicable path", () => {
    expect(prompt).toContain("Verification gate");
    expect(prompt).toMatch(/fresh tool output|proving evidence/i);
    expect(prompt).toContain("not applicable");
  });

  it("states the gate as behavior, not a language-specific phrase list", () => {
    expect(prompt).toMatch(/in any language|holds in any language/i);
  });

  it("adopts conditional test-first, not universal TDD or delete-untested-code", () => {
    expect(prompt).toContain("Test-first policy");
    expect(prompt).toMatch(/FAILING test first/);
    expect(prompt).toContain("There is no rule to delete untested code");
    expect(prompt).not.toMatch(/NO PRODUCTION CODE/i);
    expect(prompt).toMatch(/not feasible|infeasible/);
  });
});
