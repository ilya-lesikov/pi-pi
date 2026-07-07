import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, parseDuration } from "./config.js";
import * as configModule from "./config.js";
import * as flantInfra from "./flant-infra.js";
import { formatDuration, formatSourceTags, getConfigSourceInfo, pickMaxReviewPasses, publishGuard, publishFileCommentsBanner, publishPrCommentsBanner, showUsage } from "./pp-menu.js";
import { createUsageTracker } from "./usage-tracker.js";

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
