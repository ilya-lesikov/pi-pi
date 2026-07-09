import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { brainstormSystemPrompt, spawnBrainstormReviewers } from "./brainstorm.js";
import { getDefaultConfig } from "../config.js";

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
