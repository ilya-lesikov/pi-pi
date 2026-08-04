import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const captured: Array<{ type: string; options: any }> = [];

vi.mock("../agents/registry.js", () => ({
  registerAgentDefinitions: vi.fn(),
  spawnViaRpc: vi.fn(async (_pi: any, type: string, _prompt: string, options: any) => {
    captured.push({ type, options });
    return { id: `mock-${type}` };
  }),
  waitForCompletion: vi.fn(async () => {}),
}));

import { spawnPlanners } from "./planning.js";
import { getDefaultConfig } from "../config.js";

const VALID_PLAN = [
  "# Plan",
  "",
  "## Scope",
  "Do the thing.",
  "",
  "## Checklist",
  "",
  "- [ ] Thing is done — Done when: the test passes",
].join("\n");

afterEach(() => {
  captured.length = 0;
  vi.clearAllMocks();
});

// Runs the real spawnPlanners to capture the validateCompletion callback each
// planner is spawned with, then invokes it against files on disk.
async function plannerValidators(): Promise<{ taskDir: string; validate: (content?: string) => string | undefined }> {
  const taskDir = mkdtempSync(join(tmpdir(), "pp-planner-complete-"));
  writeFileSync(join(taskDir, "USER_REQUEST.md"), "# User Request\n\n## Problem\np\n\n## Constraints\nc\n");
  writeFileSync(join(taskDir, "RESEARCH.md"), "## Affected Code\n- x\n\n## Architecture Context\ny\n\n## Constraints & Edge Cases\nz\n");

  const config = getDefaultConfig();
  await spawnPlanners(
    {} as any,
    taskDir,
    taskDir,
    "task-1",
    config,
    (() => {}) as any,
    { fable: { model: "m", thinking: "high" } as any },
    [],
  );

  const entry = captured.find((c) => c.type.startsWith("planner_"));
  if (!entry) throw new Error("no planner spawned");
  // With no file written yet the callback reports the path it expects, which is
  // the timestamped output path chosen inside spawnPlanners.
  const missingMessage: string = entry.options.validateCompletion() ?? "";
  const outputPath = missingMessage.split(" ").at(-1)!;
  return {
    taskDir,
    validate: (content?: string) => {
      mkdirSync(join(taskDir, "plans"), { recursive: true });
      if (content !== undefined) writeFileSync(outputPath, content, "utf-8");
      return entry.options.validateCompletion();
    },
  };
}

describe("planner validateCompletion", () => {
  it("treats a stub-only finish as unfinished, without spraying raw structure errors", async () => {
    const { validate } = await plannerValidators();
    const message = validate("PLAN_STATUS: INCOMPLETE\n");
    // A stub means the planner never produced a plan: it must NOT pass...
    expect(message).toBeTruthy();
    // ...but the four validatePlan structure errors are noise here. The planner
    // needs to be told it did not finish, pointed at its output path.
    expect(message).not.toContain("Plan validation failed");
    expect(message).not.toContain("Missing");
    expect(message).toContain("without writing your plan");
    expect(message).toContain("plans/");
  });

  it("accepts a finished plan carrying the COMPLETE marker", async () => {
    const { validate } = await plannerValidators();
    expect(validate(`${VALID_PLAN}\n\nPLAN_STATUS: COMPLETE\n`)).toBeUndefined();
  });

  it("still reports structure errors for a malformed non-stub plan", async () => {
    const { validate } = await plannerValidators();
    const message = validate("# Plan\n\nnot a plan at all\n");
    expect(message).toContain("Plan validation failed");
  });
});
