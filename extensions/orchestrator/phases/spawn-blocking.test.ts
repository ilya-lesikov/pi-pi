import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

let resolveWait: (() => void) | null = null;
let waitStarted = false;

vi.mock("../agents/registry.js", () => ({
  registerAgentDefinitions: vi.fn(),
  unregisterAgentDefinitions: vi.fn(),
  spawnViaRpc: vi.fn(async () => ({ id: `agent-${Math.random().toString(36).slice(2)}` })),
  waitForCompletion: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        waitStarted = true;
        resolveWait = resolve;
      }),
  ),
}));

import { spawnPlanners } from "./planning.js";
import { getDefaultConfig } from "../config.js";

const tempDirs: string[] = [];

function makeTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-spawn-block-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "USER_REQUEST.md"), "# User Request\n\n## Problem\n\nx\n\n## Constraints\n\n- y\n");
  writeFileSync(join(dir, "RESEARCH.md"), "## Affected Code\n\nx\n\n## Architecture Context\n\nx\n\n## Constraints & Edge Cases\n\nx\n\n## Open Questions\n\nx\n");
  mkdirSync(join(dir, "plans"), { recursive: true });
  return dir;
}

function makePi(): any {
  return { sendMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } };
}

afterEach(() => {
  resolveWait = null;
  waitStarted = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("spawn blocks until completion (review-cycle invariant)", () => {
  it("spawnPlanners does not resolve until waitForCompletion resolves", async () => {
    const taskDir = makeTaskDir();
    const config = getDefaultConfig();
    const variants = { only: { model: "anthropic/claude-test", enabled: true } } as any;

    const promise = spawnPlanners(makePi(), taskDir, taskDir, "1", config, variants);

    let settled = false;
    promise.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitStarted).toBe(true));
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWait!();
    await promise;
    expect(settled).toBe(true);
  });
});
