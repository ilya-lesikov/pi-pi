import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, parseDuration } from "./config.js";
import * as configModule from "./config.js";
import * as flantInfra from "./flant-infra.js";
import { formatDuration, formatSourceTags, getConfigSourceInfo, pickMaxReviewPasses, publishGuard, publishFileCommentsBanner, publishPrCommentsBanner, showActiveTaskMenu, showUsage } from "./pp-menu.js";
import { createUsageTracker } from "./usage-tracker.js";

// Drives showActiveTaskMenu's submenu navigation by scripting selectOption answers.
const askQueue: string[] = [];
const askQuestions: string[] = [];
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  isCancel: (r: any) => r?.__cancel === true,
  askUser: vi.fn(async (_ctx: any, opts: any) => {
    askQuestions.push(opts.question);
    const next = askQueue.shift();
    if (next === undefined || next === "__ESC__") return { __cancel: true, reason: "user" };
    return { kind: "selection", selections: [next] };
  }),
}));

// Scripts per-repo Plannotator outcomes for the #3a interleaved cursor tests.
const plannotatorResults: Array<{ approved: boolean; feedback?: string; error?: string }> = [];
const plannotatorOpenCwds: string[] = [];
vi.mock("./plannotator.js", () => ({
  cancelPendingPlannotatorWait: () => {},
  openPlannotator: vi.fn(async (_pi: any, _action: string, payload: any) => {
    plannotatorOpenCwds.push(payload?.cwd);
    return { opened: true, reviewId: "rev" };
  }),
  waitForPlannotatorResult: vi.fn(async () => plannotatorResults.shift() ?? { approved: true }),
}));

const USAGE_TRACKER_SYMBOL = Symbol.for("pi-pi:usage-tracker");

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any)[USAGE_TRACKER_SYMBOL];
});

function renderUsage(tracker: ReturnType<typeof createUsageTracker>): string {
  (globalThis as any)[USAGE_TRACKER_SYMBOL] = tracker;
  let captured = "";
  showUsage({ ui: { notify: (text: string) => { captured = text; } } });
  return captured;
}

describe("showUsage subscription rendering", () => {
  it("labels subscription model and agent rows and excludes their dollars", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 100, 50, 0, 0, 0.4, false);
    tracker.recordTurn("sub/claude-opus-4-6", "pp-flant-anthropic-sub", 200, 100, 0, 0, 9.9, false);
    tracker.recordSubagentCompletion({ input: 30, output: 10 } as any, 5.0, {
      description: "Explore", agentType: "explore", modelId: "sub/claude-haiku-4-5",
    });

    const out = renderUsage(tracker);

    expect(out).toContain("sub/claude-opus-4-6:");
    expect(out).toContain("subscription");
    expect(out).toContain("explore");
    expect(out).toContain("$0.40");
    expect(out).not.toContain("$9.90");
    expect(out).not.toContain("$5.00");
    expect(out).toContain("Cost: $0.40");
  });

  it("shows the four-bucket input breakdown and processed-input totals", () => {
    const tracker = createUsageTracker();
    // uncached 84, output 27k, cacheRead 1000, cacheWrite 200 on a sub model.
    tracker.recordTurn("sub/claude-opus-4-8", "pp-flant-anthropic-sub", 84, 27000, 1000, 200, 0, true);
    // A cache-using subagent, to exercise the inline By-agent breakdown.
    tracker.recordSubagentCompletion({ input: 10, output: 500, cacheRead: 300, cacheWrite: 90 } as any, 0, {
      description: "Explore", agentType: "explore", modelId: "sub/claude-haiku-4-5",
    });

    const out = renderUsage(tracker);

    // Total "Input" is the processed input across main + subagent:
    // main 84+1000+200=1284, subagent 10+300+90=400 → 1684 → "1.7k".
    expect(out).toContain("Input: 1.7k tokens");
    expect(out).toContain("uncached:    94");    // 84 + 10
    expect(out).toContain("cache read:  1.3k");  // 1000 + 300
    expect(out).toContain("cache write: 290");   // 200 + 90
    expect(out).toContain("Output: 28k tokens"); // 27000 + 500
    // Hit rate = 1300 / 1684 = 77% (rounded).
    expect(out).toContain("⚡77% hit rate");
    // Cost is always shown, even at $0.00 for subscription sessions.
    expect(out).toContain("Cost: $0.00");
    // Per-model row is a one-liner: processed input (↑1.3k) with an inline
    // uncached / cache read / cache write breakdown.
    expect(out).toContain("sub/claude-opus-4-8: ↑1.3k (u84 r1.0k w200)");
    // By-agent row carries the same inline breakdown (400 processed = 10+300+90).
    expect(out).toContain("explore: ↑400 (u10 r300 w90)");
  });

  it("does not inflate paid model share when a subscription model is present", () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("openai/gpt-5", "openai", 100, 0, 0, 0, 0.5, false);
    tracker.recordTurn("sub/claude-opus-4-6", "pp-flant-anthropic-sub", 100, 0, 0, 0, 2.0, false);

    const out = renderUsage(tracker);

    expect(out).toContain("openai/gpt-5:");
    expect(out).toContain("$0.50");
    expect(out).not.toContain("$0.25");
  });
});

describe("settings helpers", () => {
  it("formatDuration renders compact human-readable values", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(300000)).toBe("5m");
    expect(formatDuration(3600000)).toBe("1h");
  });

  it("parseDuration accepts units and raw milliseconds", () => {
    expect(parseDuration("30s")).toBe(30000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("1500")).toBe(1500);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("bad")).toBeNull();
  });

  it("formatSourceTags combines matching source tags", () => {
    const tags = formatSourceTags("info", {
      activeValue: "info",
      defaultValue: "debug",
      flantValue: "info",
      globalValue: "warn",
      projectValue: "info",
      source: "project",
    });
    expect(tags).toBe("(active, flant, project)");
  });

  it("getConfigSourceInfo resolves project-over-global-over-flant-over-default", () => {
    const cwd = "/tmp/pp-menu-test";
    const projectPath = join(cwd, ".pp", "config.json");

    vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
      if (path === GLOBAL_CONFIG_PATH) return { general: { autoCommit: true } };
      if (path === projectPath) return { general: { autoCommit: false } };
      return {};
    });
    vi.spyOn(flantInfra, "getFlantGeneratedConfig").mockReturnValue({ general: { autoCommit: true } } as any);

    const orchestrator = {
      cwd,
      config: {
        ...getDefaultConfig(),
        general: {
          ...getDefaultConfig().general,
          autoCommit: false,
        },
      },
    } as any;

    const info = getConfigSourceInfo(orchestrator, ["general", "autoCommit"]);
    expect(info.source).toBe("project");
    expect(info.activeValue).toBe(false);
    expect(info.defaultValue).toBe(true);
    expect(info.flantValue).toBe(true);
    expect(info.globalValue).toBe(true);
    expect(info.projectValue).toBe(false);
  });

  it("getConfigSourceInfo reports flant source when only flant overrides default", () => {
    const cwd = "/tmp/pp-menu-test-flant";
    const projectPath = join(cwd, ".pp", "config.json");

    vi.spyOn(configModule, "readRawConfig").mockImplementation((path: string) => {
      if (path === GLOBAL_CONFIG_PATH) return {};
      if (path === projectPath) return {};
      return {};
    });
    vi.spyOn(flantInfra, "getFlantGeneratedConfig").mockReturnValue({ general: { autoCommit: false } } as any);

    const orchestrator = {
      cwd,
      config: {
        ...getDefaultConfig(),
        general: {
          ...getDefaultConfig().general,
          autoCommit: false,
        },
      },
    } as any;

    const info = getConfigSourceInfo(orchestrator, ["general", "autoCommit"]);
    expect(info.source).toBe("flant");
    expect(info.defaultValue).toBe(true);
    expect(info.flantValue).toBe(false);
    expect(info.globalValue).toBeUndefined();
    expect(info.projectValue).toBeUndefined();
  });
});

describe("pickMaxReviewPasses", () => {
  function makeInputCtx(responses: (string | undefined)[]) {
    let i = 0;
    return {
      ui: {
        input: vi.fn(async () => responses[i++]),
        notify: vi.fn(),
      },
    } as any;
  }

  it('returns 999 for "-" (unlimited)', async () => {
    const ctx = makeInputCtx(["-"]);
    expect(await pickMaxReviewPasses(ctx, 3)).toBe(999);
  });

  it("returns the entered positive integer", async () => {
    const ctx = makeInputCtx(["5"]);
    expect(await pickMaxReviewPasses(ctx, 3)).toBe(5);
  });

  it("re-prompts on non-integer junk then accepts a valid integer", async () => {
    const ctx = makeInputCtx(["3abc", "1.5", "4"]);
    expect(await pickMaxReviewPasses(ctx, 3)).toBe(4);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("returns null when input is cancelled or empty", async () => {
    expect(await pickMaxReviewPasses(makeInputCtx([undefined]), 3)).toBeNull();
    expect(await pickMaxReviewPasses(makeInputCtx([""]), 3)).toBeNull();
  });
});

describe("publishGuard", () => {
  let taskDir: string;

  afterEach(() => {
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
  });

  function makeTask(): string {
    taskDir = mkdtempSync(join(tmpdir(), "pp-guard-"));
    return taskDir;
  }

  it("blocks publishing when no review has run (no code-reviews dir)", () => {
    const dir = makeTask();
    const msg = publishGuard(dir);
    expect(msg).toBeTruthy();
    expect(msg).toContain("review pass");
  });

  it("blocks publishing when a final_pass file exists but carries no ANCHORS block", () => {
    const dir = makeTask();
    mkdirSync(join(dir, "code-reviews"));
    writeFileSync(join(dir, "code-reviews", "20260101-000000_final_pass-1.md"), "# Findings\n\nSome prose without anchors.\n");
    expect(publishGuard(dir)).toBeTruthy();
  });

  it("allows publishing when the latest final_pass file has an ANCHORS block", () => {
    const dir = makeTask();
    mkdirSync(join(dir, "code-reviews"));
    writeFileSync(join(dir, "code-reviews", "20260101-000000_final_pass-1.md"), "ANCHORS:\nsrc/a.ts:10 — bug\n");
    expect(publishGuard(dir)).toBeUndefined();
  });

  it("resolves the newest final_pass file by name and honors its ANCHORS block", () => {
    const dir = makeTask();
    mkdirSync(join(dir, "code-reviews"));
    writeFileSync(join(dir, "code-reviews", "20260101-000000_final_pass-1.md"), "ANCHORS:\nsrc/a.ts:10 — bug\n");
    writeFileSync(join(dir, "code-reviews", "20260102-000000_final_pass-2.md"), "# Findings\n\nno anchors here\n");
    expect(publishGuard(dir)).toBeTruthy();
  });
});

describe("publish banners", () => {
  it("PR banner posts one bundled COMMENT review per repo, pre-validated against the diff", () => {
    const banner = publishPrCommentsBanner("/tmp/task");
    expect(banner).toContain("pulls/<number>/reviews");
    expect(banner).toContain("event=COMMENT");
    expect(banner).not.toContain("event=APPROVE");
    expect(banner).toContain("never APPROVE or REQUEST_CHANGES");
    expect(banner).toContain("PRE-VALIDATE");
    expect(banner).toContain("all-or-nothing");
    expect(banner).toContain("Findings not anchorable to the diff:");
    expect(banner).toContain("(generated by pi-pi)");
  });

  it("PR banner idempotency matches on path+line+footer+body", () => {
    const banner = publishPrCommentsBanner("/tmp/task");
    expect(banner).toContain("footer, AND body text all match");
    expect(banner).toContain("Two distinct findings on the same line are NOT duplicates");
  });

  it("both banners carry the privacy instruction", () => {
    for (const banner of [publishPrCommentsBanner("/tmp/task"), publishFileCommentsBanner("/tmp/task")]) {
      expect(banner).toContain("PRIVACY:");
      expect(banner).toContain("the ticket");
      expect(banner).toContain("self-contained");
    }
  });
});

describe("showActiveTaskMenu Publish/Next Back navigation (#6)", () => {
  let taskDir: string;

  afterEach(() => {
    askQueue.length = 0;
    askQuestions.length = 0;
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
  });

  function makeReviewOrchestrator(): any {
    taskDir = mkdtempSync(join(tmpdir(), "pp-nav-"));
    return {
      active: {
        type: "review",
        dir: taskDir,
        state: { phase: "review", step: "llm_work", mode: "guided" },
      },
      transitionController: {
        isRunning: () => false,
        abortMainAgent: () => {},
      },
      cancelPendingRetry: () => {},
      abortAllSubagents: () => {},
    };
  }

  const ctx = { ui: { notify: () => {} }, waitForIdle: async () => {}, abort: () => {} };

  it("Publish 'Back' re-renders the Next submenu instead of the top-level menu", async () => {
    const orchestrator = makeReviewOrchestrator();
    // /pp -> Next -> Publish -> Back (should return to Next) -> Back (to top-level) -> Back (exit).
    askQueue.push("Next", "Publish", "Back", "Back", "Back");
    const result = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(result).toBe("");
    // After Publish's Back we must see the "Next" submenu rendered again before the
    // top-level menu reappears: questions = [top, Next, Publish, Next(again), top].
    const nextRenders = askQuestions.filter((q) => q === "Next").length;
    expect(nextRenders).toBe(2);
    expect(askQuestions[askQuestions.length - 1]).toContain("/pp");
  });

  it("Next 'Back' returns straight to the top-level menu", async () => {
    const orchestrator = makeReviewOrchestrator();
    askQueue.push("Next", "Back", "Back");
    const result = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(result).toBe("");
    expect(askQuestions.filter((q) => q === "Next").length).toBe(1);
    // Top-level rendered twice (initial + after Next's Back), Next once.
    expect(askQuestions.filter((q) => q.startsWith("/pp")).length).toBe(2);
  });

  it("Review submenu 'Editor review' Back returns to Review, not the top-level menu (#3d)", async () => {
    const orchestrator = makeReviewOrchestrator();
    // /pp -> Review -> Review on my own -> Editor review Back (should return to
    // Review) -> Review Back (to top-level) -> top-level Back (exit).
    askQueue.push("Review", "Review on my own", "Back", "Back", "Back");
    const result = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(result).toBe("");
    // Review submenu rendered twice (initial + after the Editor-review Back).
    expect(askQuestions.filter((q) => q === "Review").length).toBe(2);
    // Top-level rendered twice (initial + after Review's explicit Back).
    expect(askQuestions.filter((q) => q.startsWith("/pp")).length).toBe(2);
  });

  it("resumes the per-repo Plannotator cursor and interleaves fixes (#3a)", async () => {
    const orchestrator = makeReviewOrchestrator();
    orchestrator.active.type = "implement";
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.repos = [
      { path: "/repo/a", isRoot: true },
      { path: "/repo/b", isRoot: false },
    ];
    orchestrator.active.state.plannotatorCursor = { repoPaths: ["/repo/a", "/repo/b"], index: 0 };
    orchestrator.pi = { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
    orchestrator.config = getDefaultConfig();

    // First repo: choose a diff scope, Plannotator returns NEEDS_CHANGES → the
    // menu exits with a work instruction and the cursor advances to repo b.
    plannotatorResults.push({ approved: false, feedback: "fix the thing" });
    askQueue.push("Uncommitted changes");
    const first = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(first).toContain("Plannotator requested changes");
    expect(first).toContain("fix the thing");
    expect(orchestrator.active.state.plannotatorCursor).toEqual({ repoPaths: ["/repo/a", "/repo/b"], index: 1 });

    // Next /pp resumes at repo b; APPROVED → cursor is cleared and the loop ends,
    // falling through to the normal menu (top-level Back exits).
    plannotatorResults.push({ approved: true });
    askQueue.push("Uncommitted changes", "Back");
    const second = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(second).toBe("");
    expect(orchestrator.active.state.plannotatorCursor).toBeUndefined();
  });

  function makeCursorOrchestrator(): any {
    const orchestrator = makeReviewOrchestrator();
    orchestrator.active.type = "implement";
    orchestrator.active.state.phase = "implement";
    orchestrator.active.state.repos = [{ path: "/repo/a", isRoot: true }, { path: "/repo/b", isRoot: false }];
    orchestrator.active.state.plannotatorCursor = { repoPaths: ["/repo/a", "/repo/b"], index: 0 };
    orchestrator.pi = { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
    orchestrator.config = getDefaultConfig();
    return orchestrator;
  }

  it("Plannotator error + Retry leaves the cursor on the same repo (#3, error retention)", async () => {
    const orchestrator = makeCursorOrchestrator();
    plannotatorOpenCwds.length = 0;
    // Repo a errors; user chooses Retry → cursor stays at index 0. Then a second
    // attempt on repo a approves, advancing to b, which approves and clears.
    plannotatorResults.push({ approved: false, error: "boom" });
    plannotatorResults.push({ approved: true });
    plannotatorResults.push({ approved: true });
    askQueue.push("Uncommitted changes", "Retry", "Uncommitted changes", "Uncommitted changes", "Back");
    const result = await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(result).toBe("");
    // Retry re-opened repo a (opened twice) before advancing to b; none dropped.
    expect(plannotatorOpenCwds).toEqual(["/repo/a", "/repo/a", "/repo/b"]);
    // Both repos ultimately reviewed and the cursor cleared (none silently dropped).
    expect(orchestrator.active.state.plannotatorCursor).toBeUndefined();
  });

  it("Plannotator error + Skip advances the cursor past the failed repo (#3)", async () => {
    const orchestrator = makeCursorOrchestrator();
    plannotatorOpenCwds.length = 0;
    // Repo a errors; Skip advances to repo b, which approves and clears the cursor.
    plannotatorResults.push({ approved: false, error: "boom" });
    plannotatorResults.push({ approved: true });
    askQueue.push("Uncommitted changes", "Skip this repo", "Uncommitted changes", "Back");
    await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    // Skip moved on to repo b (each repo opened exactly once — a not retried, b reached).
    expect(plannotatorOpenCwds).toEqual(["/repo/a", "/repo/b"]);
    expect(orchestrator.active.state.plannotatorCursor).toBeUndefined();
  });

  it("Plannotator error + Done stops and clears the cursor (#3)", async () => {
    const orchestrator = makeCursorOrchestrator();
    plannotatorResults.push({ approved: false, error: "boom" });
    askQueue.push("Uncommitted changes", "Done (stop reviewing)");
    await showActiveTaskMenu(orchestrator, ctx, "/pp", "tool");
    expect(orchestrator.active.state.plannotatorCursor).toBeUndefined();
  });

  it("blocks a second review while one is already running (#3b)", async () => {
    const orchestrator = makeReviewOrchestrator();
    orchestrator.active.state.reviewCycle = { kind: "auto", step: "await_reviewers", pass: 1 };
    // isRunning() true so the top-level "Review" option is offered.
    orchestrator.transitionController.isRunning = () => true;
    let notified = "";
    const notifyCtx = { ui: { notify: (t: string) => { notified = t; } }, waitForIdle: async () => {}, abort: () => {} };
    // Pick Review (blocked → notify + back to top-level menu), then Back to exit.
    askQueue.push("Review", "Back");
    const result = await showActiveTaskMenu(orchestrator, notifyCtx, "/pp", "tool");
    expect(result).toBe("");
    expect(notified).toBe("A review is already running");
    // The live cycle is untouched (not finalized/nulled) and the top-level menu
    // re-rendered rather than /pp exiting.
    expect(orchestrator.active.state.reviewCycle).toEqual({ kind: "auto", step: "await_reviewers", pass: 1 });
    expect(askQuestions.filter((q) => q.startsWith("/pp")).length).toBe(2);
  });
});
