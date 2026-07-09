import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const openOutcome = { value: "not-handled" as "opened" | "timeout" | "not-handled" };
vi.mock("./plannotator.js", () => ({
  cancelPendingPlannotatorWait: () => {},
  waitForPlannotatorResult: vi.fn(async () => ({ approved: true })),
  openPlannotator: vi.fn(async () => ({
    opened: false,
    reviewId: null,
    outcome: openOutcome.value,
  })),
}));

import { enterReviewCycle } from "./event-handlers.js";
import { getDefaultConfig } from "./config.js";

const tempDirs: string[] = [];
function makeTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-plan-open-"));
  tempDirs.push(dir);
  return dir;
}

function makeOrchestrator(): any {
  const dir = makeTaskDir();
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans", "1_synthesized.md"), "# Plan\n\n## Scope\nx\n\n## Checklist\n- [ ] a — Done when: b\n", "utf-8");
  return {
    active: {
      dir,
      type: "implement",
      state: { phase: "plan", step: "llm_work", reviewCycle: null, reviewPass: 0 },
    },
    pi: {},
    config: getDefaultConfig(),
    cwd: dir,
  };
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("enterReviewCycle plan-phase Plannotator open failure", () => {
  const ctx = { ui: { setWorkingMessage: () => {}, notify: () => {} } };

  it("timeout failure ends with the 'Choose another option.' sentinel so the menu loops back", async () => {
    openOutcome.value = "timeout";
    const orchestrator = makeOrchestrator();
    const msg = await enterReviewCycle(orchestrator, ctx, "plannotator");
    expect(msg).toContain("did not respond within 30s");
    // handleReviewResult (pp-menu.ts) matches the exact "Choose another option."
    // sentinel to keep the inline Review menu open for retry/another method.
    expect(msg).toContain("Choose another option.");
  });

  it("not-handled failure ends with the same sentinel and a distinct diagnosis", async () => {
    openOutcome.value = "not-handled";
    const orchestrator = makeOrchestrator();
    const msg = await enterReviewCycle(orchestrator, ctx, "plannotator");
    expect(msg).toContain("no handler responded");
    expect(msg).toContain("Choose another option.");
  });
});
