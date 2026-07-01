import { describe, it, expect } from "vitest";
import { reviewSystemPrompt } from "./review.js";

describe("reviewSystemPrompt apply_feedback wording", () => {
  it("autonomous plan/implement mandates re-calling pp_phase_complete and does not tell the agent to wait for the user", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "plan", "autonomous");
    expect(prompt).toContain("pp_phase_complete");
    expect(prompt).not.toContain("Present the synthesis to the user");
    expect(prompt).not.toContain("A new review pass will begin");
  });

  it("guided plan/implement keeps the user-facing synthesis behavior", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "plan", "guided");
    expect(prompt).toContain("Present the synthesis to the user");
    expect(prompt).not.toContain("Call pp_phase_complete again to finalize");
  });

  it("brainstorm prompt is unaffected by mode (never instructs pp_phase_complete)", () => {
    const auto = reviewSystemPrompt("/tmp/task", 1, "brainstorm", "autonomous");
    const guided = reviewSystemPrompt("/tmp/task", 1, "brainstorm", "guided");
    expect(auto).toBe(guided);
    expect(auto).toContain("BRAINSTORM REVIEW CYCLE");
    expect(auto).not.toContain("pp_phase_complete");
  });
});
