import { describe, it, expect } from "vitest";
import { planningSystemPrompt } from "./planning.js";

describe("planningSystemPrompt self-complete directive", () => {
  it("guided synthesis instructs the agent to call pp_phase_complete when synthesis is complete", () => {
    const prompt = planningSystemPrompt("/tmp/task", "guided");
    expect(prompt).toContain("pp_phase_complete");
    expect(prompt).toContain("Do NOT instead ask the user to run /pp manually");
  });

  it("autonomous synthesis does not add the guided self-complete directive", () => {
    const prompt = planningSystemPrompt("/tmp/task", "autonomous");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("Do NOT instead ask the user to run /pp manually");
  });
});
