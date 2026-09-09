import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installConsoleGuard } from "./console-guard.js";

const INSTALLED_KEY = Symbol.for("pi-pi:console-guard-installed");
const DUP = "SharedHighlight.registerCustomTheme: theme name already registered";

const logged: Array<{ level: string; fields: any; message: string }> = [];

vi.mock("./log.js", () => ({
  getLogger: () => ({
    debug: (fields: any, message: string) => logged.push({ level: "debug", fields, message }),
    info: (fields: any, message: string) => logged.push({ level: "info", fields, message }),
    warn: (fields: any, message: string) => logged.push({ level: "warn", fields, message }),
    error: (fields: any, message: string) => logged.push({ level: "error", fields, message }),
  }),
}));

describe("installConsoleGuard", () => {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };

  beforeEach(() => {
    logged.length = 0;
    (globalThis as any)[INSTALLED_KEY] = undefined;
  });

  afterEach(() => {
    Object.assign(console, original);
    (globalThis as any)[INSTALLED_KEY] = undefined;
  });

  // Anything reaching the terminal behind pi-tui's back desynchronizes the
  // cursor it renders every later frame relative to.
  it("writes console output to the log instead of the terminal", () => {
    const spy = vi.fn();
    console.warn = spy;
    installConsoleGuard();

    console.warn("[pi-subagents] Failed to start scheduler:", new Error("boom"));

    expect(spy).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("warn");
    expect(logged[0].message).toContain("Failed to start scheduler");
    expect(logged[0].message).toContain("boom");
  });

  it("maps each console method to a log level", () => {
    installConsoleGuard();
    console.log("a");
    console.info("b");
    console.warn("c");
    console.error("d");
    console.debug("e");
    console.trace("f");

    expect(logged.map((entry) => entry.level)).toEqual(["info", "info", "warn", "error", "debug", "debug"]);
  });

  it("drops the benign duplicate-theme error rather than logging it", () => {
    installConsoleGuard();
    for (const name of ["pierre-dark", "pierre-dark-soft", "pierre-light", "pierre-light-soft"]) {
      console.error(DUP, name);
    }
    expect(logged).toHaveLength(0);

    console.error(DUP, "some-other-theme");
    expect(logged).toHaveLength(1);
  });

  it("installs once, so a re-evaluated module cannot stack wrappers", () => {
    installConsoleGuard();
    const afterFirst = console.error;
    installConsoleGuard();

    expect(console.error).toBe(afterFirst);
    console.error("once");
    expect(logged).toHaveLength(1);
  });

  it("survives a logger that cannot write, rather than falling back to the screen", () => {
    const spy = vi.fn();
    console.error = spy;
    installConsoleGuard();
    logged.push = () => { throw new Error("log closed"); };

    expect(() => console.error("boom")).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
