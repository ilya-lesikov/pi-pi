import { describe, expect, it } from "vitest";
import { brainstormSystemPrompt } from "./brainstorm.js";

describe("brainstormSystemPrompt", () => {
  it("debug prompt body is pure procedure (no completion/menu restatements)", () => {
    const prompt = brainstormSystemPrompt("debug", "fix a bug", "/tmp/task", "/tmp");
    expect(prompt).toContain("DEBUG PHASE");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("/pp");
  });

  it("brainstorm prompt body is pure procedure (no completion/menu restatements)", () => {
    const prompt = brainstormSystemPrompt("brainstorm", "explore ideas", "/tmp/task", "/tmp");
    expect(prompt).toContain("conversation");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("/pp");
  });
});
