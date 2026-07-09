import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { planningSystemPrompt, spawnPlanReviewers } from "./planning.js";
import { getDefaultConfig } from "../config.js";

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

describe("spawnPlanReviewers missing prerequisites", () => {
  async function run(setup: (dir: string) => void) {
    const taskDir = mkdtempSync(join(tmpdir(), "pi-pi-plan-spawn-"));
    setup(taskDir);
    const sent: any[] = [];
    const send = ((msg: any, _mode: any) => { sent.push(msg); }) as any;
    try {
      const result = await spawnPlanReviewers(
        {} as any,
        taskDir,
        taskDir,
        "task-id",
        getDefaultConfig(),
        1,
        send,
      );
      return { result, sent };
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  }

  it("emits a displayed error when USER_REQUEST/RESEARCH are missing", async () => {
    const { result, sent } = await run(() => {});
    expect(result.spawned).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("pp-plan-reviews-error");
    expect(sent[0].display).toBe(true);
  });

  it("emits a displayed error when the synthesized plan is missing", async () => {
    const { result, sent } = await run((dir) => {
      writeFileSync(join(dir, "USER_REQUEST.md"), "# User Request\n", "utf-8");
      writeFileSync(join(dir, "RESEARCH.md"), "## Affected Code\n", "utf-8");
    });
    expect(result.spawned).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("pp-plan-reviews-error");
    expect(sent[0].content).toContain("no synthesized plan");
  });
});
