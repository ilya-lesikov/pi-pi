import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, parseDuration } from "./config.js";
import * as configModule from "./config.js";
import * as flantInfra from "./flant-infra.js";
import { formatDuration, formatSourceTags, getConfigSourceInfo, pickMaxReviewPasses, showUsage } from "./pp-menu.js";
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
