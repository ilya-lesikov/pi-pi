import { describe, expect, it } from "vitest";
import { brainstormSystemPrompt } from "./brainstorm.js";

describe("brainstormSystemPrompt", () => {
  it("debug prompt recommends /pp:done, not /pp:next", () => {
    const prompt = brainstormSystemPrompt("debug", "fix a bug", "/tmp/task");
    expect(prompt).toContain("/pp:done");
    expect(prompt).not.toContain("/pp:next");
  });

  it("brainstorm prompt recommends /pp:done", () => {
    const prompt = brainstormSystemPrompt("brainstorm", "explore ideas", "/tmp/task");
    expect(prompt).toContain("/pp:done");
  });
});
