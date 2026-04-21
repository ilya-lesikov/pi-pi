import { describe, it, expect } from "vitest";
import { NU_ERROR_HINTS, augmentNuOutput } from "../src/nu.js";
import type { NuExecuteResult } from "../src/nu.js";

function makeResult(partial: Partial<NuExecuteResult>): NuExecuteResult {
  return {
    output: "",
    exitCode: 0,
    timedOut: false,
    ...partial,
  };
}

describe("NU_ERROR_HINTS", () => {
  it("maps at least the plugin-not-found needles for gstat, query, and formats", () => {
    const keys = Object.keys(NU_ERROR_HINTS);
    expect(keys.some((k) => k.includes("gstat"))).toBe(true);
    expect(keys.some((k) => k.includes("query"))).toBe(true);
    expect(keys.some((k) => k.includes("formats") || k.includes("from ini"))).toBe(true);
    // Every mapped hint is a non-empty string.
    for (const [needle, hint] of Object.entries(NU_ERROR_HINTS)) {
      expect(typeof needle).toBe("string");
      expect(needle.length).toBeGreaterThan(0);
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});

describe("augmentNuOutput", () => {
  it("appends [nu-hint] line when exitCode !== 0 and a needle matches", () => {
    for (const [needle, hint] of Object.entries(NU_ERROR_HINTS)) {
      const output = `some prior error text\n${needle}\ntrailing`;
      const augmented = augmentNuOutput(makeResult({ output, exitCode: 1 }));
      expect(augmented.startsWith(output)).toBe(true);
      expect(augmented).toContain(`\n\n[nu-hint] ${hint}`);
    }
  });

  it("appends [nu-hint] line when timedOut is true (exitCode: null) and a needle matches", () => {
    const [needle, hint] = Object.entries(NU_ERROR_HINTS)[0]!;
    const output = `timeout prelude\n${needle}`;
    const augmented = augmentNuOutput(
      makeResult({ output, exitCode: null, timedOut: true }),
    );
    expect(augmented).toContain(`\n\n[nu-hint] ${hint}`);
  });

  it("returns output unchanged when exitCode === 0 and timedOut === false, even if a needle is present", () => {
    for (const [needle] of Object.entries(NU_ERROR_HINTS)) {
      const output = `ok output mentioning ${needle} incidentally`;
      const augmented = augmentNuOutput(
        makeResult({ output, exitCode: 0, timedOut: false }),
      );
      expect(augmented).toBe(output);
    }
  });

  it("returns output unchanged when exitCode !== 0 but no needle matches", () => {
    const output = "some unrelated nu error: type mismatch in closure\n";
    const augmented = augmentNuOutput(makeResult({ output, exitCode: 1 }));
    expect(augmented).toBe(output);
  });
});
