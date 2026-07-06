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

  it("brainstorm apply-feedback prompt permits artifact updates and steers to the compact tools", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "brainstorm", "autonomous");
    expect(prompt).toContain("artifacts/");
    expect(prompt).toContain("pp_write_state_file");
    // The no-new-sections rule for the two structured files is retained.
    expect(prompt).toContain("Do NOT add, rename, or remove sections in USER_REQUEST.md or RESEARCH.md");
  });

  it("autonomous plan feedback folds into a new synthesized plan, not a separate fix-plan file", () => {
    // Re-review and the transition read only the latest `*synthesized*` plan, so
    // plan-phase feedback must land there.
    const plan = reviewSystemPrompt("/tmp/task", 1, "plan", "autonomous");
    expect(plan).toContain("synthesized.md");
    expect(plan).not.toContain("do NOT modify the original synthesized plan");

    // The implement phase keeps the fix-plan/implement pattern (synthesized plan
    // is code guidance there, not the reviewed artifact).
    const impl = reviewSystemPrompt("/tmp/task", 1, "implement", "autonomous");
    expect(impl).toContain("Create a fix plan");
    expect(impl).toContain("Implement the fixes");
  });

  it("standalone review phase omits the fix-plan/implement/afterImplement tail", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "review", "guided");
    expect(prompt).toContain("REVIEW CYCLE");
    expect(prompt).toContain("standalone review");
    expect(prompt).not.toContain("Create a fix plan");
    expect(prompt).not.toContain("Implement the fixes");
    expect(prompt).not.toContain("Run afterImplement commands");
    expect(prompt).toContain("code-reviews/");
  });

  it("review phase markdown anchoring keeps findings in the review file only", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "review", "guided", "markdown");
    expect(prompt).toContain("markdown only");
    expect(prompt).not.toContain("AI_COMMENT:");
    expect(prompt).not.toContain("GitHub PR line comments");
  });

  it("review phase ai_comment anchoring instructs AI_COMMENT insertion, not fixes", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "review", "guided", "ai_comment");
    expect(prompt).toContain("AI_COMMENT:");
    expect(prompt).toContain("ANCHORS:");
    expect(prompt).not.toContain("GitHub PR line comments");
  });

  it("review phase ai_comment_pr anchoring covers both source markers and PR comments", () => {
    const prompt = reviewSystemPrompt("/tmp/task", 1, "review", "guided", "ai_comment_pr");
    expect(prompt).toContain("AI_COMMENT:");
    expect(prompt).toContain("GitHub PR line comments");
    expect(prompt).toContain("do NOT call `gh` yourself");
  });

  it("points each phase at the directory its reviewers actually write to", () => {
    // plan reviewers write to plan-reviews (planning.ts) and outputs load from
    // plan-reviews (context.ts); the prompt must match, not code-reviews.
    const plan = reviewSystemPrompt("/tmp/task", 1, "plan", "autonomous");
    expect(plan).toContain("plan-reviews/");
    expect(plan).not.toContain("code-reviews/");

    const impl = reviewSystemPrompt("/tmp/task", 1, "implement", "autonomous");
    expect(impl).toContain("code-reviews/");
    expect(impl).not.toContain("plan-reviews/");

    const brainstorm = reviewSystemPrompt("/tmp/task", 1, "brainstorm", "guided");
    expect(brainstorm).toContain("brainstorm-reviews/");
  });
});
