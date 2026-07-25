import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { brainstormSystemPrompt, spawnBrainstormReviewers } from "./brainstorm.js";
import { getDefaultConfig } from "../config.js";

describe("brainstormSystemPrompt", () => {
  it("brainstorm prompt body is pure procedure (no completion/menu restatements)", () => {
    const prompt = brainstormSystemPrompt("brainstorm", "explore ideas", "/tmp/task", "/tmp");
    expect(prompt).toContain("conversation");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("/pp");
  });

  it("conversation branch uses the Socratic one-at-a-time-with-second-push clarify policy", () => {
    const prompt = brainstormSystemPrompt("brainstorm", "explore ideas", "/tmp/task", "/tmp");
    expect(prompt).toContain("CLARIFY ONE AT A TIME");
    expect(prompt).toContain("push once more");
    expect(prompt).not.toContain("batch them into one focused round");
  });

  it("task branch also carries the Socratic clarify policy and degrades to recorded assumptions when autonomous", () => {
    const prompt = brainstormSystemPrompt("task", "do the thing", "/tmp/task", "/tmp");
    expect(prompt).toContain("CLARIFY ONE AT A TIME");
    expect(prompt).toContain("artifacts/ASSUMPTIONS.md");
  });

  it("both branches state anti-sycophancy as a behavior, with the quoted phrase adjacent to an example marker", () => {
    for (const t of ["brainstorm", "task"] as const) {
      const prompt = brainstormSystemPrompt(t, "x", "/tmp/task", "/tmp");
      expect(prompt).toContain("take a position");
      expect(prompt).toMatch(/what evidence would change|what would change it/i);
      // The quoted anti-pattern phrase must sit right after an explicit example
      // marker on the same line — a stray "e.g." elsewhere in the prompt must not
      // satisfy this.
      expect(prompt).toMatch(/(illustrative anti-patterns|Examples of the anti-pattern)[^\n]{0,60}'that could work'/);
    }
  });
});

describe("spawnBrainstormReviewers missing prerequisites", () => {
  it("emits a displayed error and spawns nothing when artifacts are missing", async () => {
    const taskDir = mkdtempSync(join(tmpdir(), "pi-pi-brainstorm-spawn-"));
    try {
      const sent: any[] = [];
      const send = ((msg: any, _mode: any) => { sent.push(msg); }) as any;
      const result = await spawnBrainstormReviewers(
        {} as any,
        taskDir,
        taskDir,
        "task-id",
        getDefaultConfig(),
        1,
        send,
      );
      expect(result.spawned).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].customType).toBe("pp-brainstorm-reviews-error");
      expect(sent[0].display).toBe(true);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });
});
