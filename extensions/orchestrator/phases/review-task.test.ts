import { describe, it, expect } from "vitest";
import { reviewSystemPrompt } from "./review-task.js";

describe("review-task reviewSystemPrompt", () => {
  it("mandates writing an ANCHORS-bearing final_pass file via the generic write tool", () => {
    const prompt = reviewSystemPrompt("/tmp/task", "/tmp/cwd");
    expect(prompt).toContain("/tmp/task/code-reviews/<unix-epoch-seconds>_final_pass-1.md");
    expect(prompt).toContain("ANCHORS:");
    expect(prompt).toContain("<relative/path/from/repo/root>:<line> — <one-line finding>");
    expect(prompt).toContain("(none)");
    expect(prompt).toContain("GENERIC write tool");
  });

  it("still captures the structured USER_REQUEST.md / RESEARCH.md deliverables", () => {
    const prompt = reviewSystemPrompt("/tmp/task", "/tmp/cwd");
    expect(prompt).toContain("USER_REQUEST.md");
    expect(prompt).toContain("RESEARCH.md");
    expect(prompt).toContain("pp_write_state_file");
  });
});
