import { describe, expect, it } from "vitest";
import { brainstormSystemPrompt } from "./brainstorm.js";

describe("brainstormSystemPrompt", () => {
  it("debug prompt uses pp_phase_complete", () => {
    const prompt = brainstormSystemPrompt("debug", "fix a bug", "/tmp/task");
    expect(prompt).toContain("pp_phase_complete");
    expect(prompt).not.toContain("/pp:next");
  });

  it("brainstorm prompt uses pp_phase_complete", () => {
    const prompt = brainstormSystemPrompt("brainstorm", "explore ideas", "/tmp/task");
    expect(prompt).toContain("pp_phase_complete");
  });
});
