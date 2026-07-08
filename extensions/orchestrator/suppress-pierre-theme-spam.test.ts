import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suppressPierreThemeSpam } from "./suppress-pierre-theme-spam.js";

const INSTALLED_KEY = Symbol.for("pi-pi:pierre-theme-spam-suppressed");
const DUP = "SharedHighlight.registerCustomTheme: theme name already registered";

describe("suppressPierreThemeSpam", () => {
  let original: typeof console.error;

  beforeEach(() => {
    original = console.error;
    (globalThis as any)[INSTALLED_KEY] = undefined;
  });

  afterEach(() => {
    console.error = original;
    (globalThis as any)[INSTALLED_KEY] = undefined;
  });

  it("drops the benign duplicate-theme error for each known pierre theme", () => {
    const spy = vi.fn();
    console.error = spy;
    suppressPierreThemeSpam();

    for (const name of ["pierre-dark", "pierre-dark-soft", "pierre-light", "pierre-light-soft"]) {
      console.error(DUP, name);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes through unrelated console.error calls untouched", () => {
    const spy = vi.fn();
    console.error = spy;
    suppressPierreThemeSpam();

    console.error("something else entirely");
    console.error(DUP, "some-other-theme"); // same prefix, unknown theme → not ours
    console.error("real error", new Error("boom"));

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, "something else entirely");
    expect(spy).toHaveBeenNthCalledWith(2, DUP, "some-other-theme");
  });

  it("installs the filter only once (idempotent, no wrapper stacking)", () => {
    const spy = vi.fn();
    console.error = spy;
    suppressPierreThemeSpam();
    const afterFirst = console.error;
    suppressPierreThemeSpam();
    expect(console.error).toBe(afterFirst);

    console.error("passthrough");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
