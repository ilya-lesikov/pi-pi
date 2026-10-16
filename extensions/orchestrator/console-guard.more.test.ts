import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installConsoleGuard } from "./console-guard.js";

const INSTALLED_KEY = Symbol.for("pi-pi:console-guard-installed");

const logged: string[] = [];

vi.mock("./log.js", () => ({
  getLogger: () => ({
    debug: (_fields: any, message: string) => logged.push(message),
    info: (_fields: any, message: string) => logged.push(message),
    warn: (_fields: any, message: string) => logged.push(message),
    error: (_fields: any, message: string) => logged.push(message),
  }),
}));

describe("console guard rendering", () => {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };

  beforeEach(() => {
    logged.length = 0;
    (globalThis as any)[INSTALLED_KEY] = undefined;
    installConsoleGuard();
  });

  afterEach(() => {
    Object.assign(console, original);
    (globalThis as any)[INSTALLED_KEY] = undefined;
  });

  it("logs an error with its stack, and objects as JSON", () => {
    const error = new Error("kaput");
    console.error("failed:", error, { code: 7 });
    expect(logged[0]).toBe(`failed: ${error.stack} {"code":7}`);
  });

  it("falls back to the message of an error without a stack", () => {
    const error = new Error("no stack");
    error.stack = undefined;
    console.warn(error);
    expect(logged[0]).toBe("no stack");
  });

  it("still logs a value JSON cannot serialize", () => {
    const cyclic: any = { name: "loop" };
    cyclic.self = cyclic;
    console.log("state", cyclic, 10n);
    expect(logged[0]).toBe("state [object Object] 10");
  });

  it("logs the pierre prefix with a theme name it does not own", () => {
    console.error("SharedHighlight.registerCustomTheme: theme name already registered", "my-theme");
    expect(logged).toHaveLength(1);
  });
});
