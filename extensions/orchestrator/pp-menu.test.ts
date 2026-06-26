import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { getDefaultConfig, GLOBAL_CONFIG_PATH, parseDuration } from "./config.js";
import * as configModule from "./config.js";
import * as flantInfra from "./flant-infra.js";
import { formatDuration, formatSourceTags, getConfigSourceInfo } from "./pp-menu.js";

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
