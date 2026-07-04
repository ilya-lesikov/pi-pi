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
