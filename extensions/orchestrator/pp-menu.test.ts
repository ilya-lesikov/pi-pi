import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, parseDuration } from "./config.js";
import * as configModule from "./config.js";
import * as flantInfra from "./flant-infra.js";
import { formatDuration, formatSourceTags, getConfigSourceInfo, pickMaxReviewPasses } from "./pp-menu.js";

afterEach(() => {
  vi.restoreAllMocks();
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
