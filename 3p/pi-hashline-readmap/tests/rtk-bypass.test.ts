import { describe, it, expect, vi } from "vitest";
import { filterBashOutput } from "../src/rtk/bash-filter.ts";
import * as linterModule from "../src/rtk/linter.ts";

describe("PI_RTK_BYPASS=1 bypass", () => {
  it("skips compression routing and returns stripAnsi(raw) exactly for output that would otherwise be compressed", () => {
    const linterSpy = vi.spyOn(linterModule, "aggregateLinterOutput").mockReturnValue("compressed linter output");
    const raw = "\x1b[31msrc/app.ts:1:1 error boom\x1b[0m\n";
    const stripped = "src/app.ts:1:1 error boom\n";

    const result = filterBashOutput("PI_RTK_BYPASS=1 eslint .", raw);

    expect(result.output).toBe(stripped);
    expect(linterSpy).not.toHaveBeenCalled();

    linterSpy.mockRestore();
  });

  it("tags info.bypassedBy === 'env-var', info.technique === 'none', and correct byte counts", () => {
    const raw = "hello world\n";
    const result = filterBashOutput("PI_RTK_BYPASS=1 echo hello", raw);
    expect(result.info.bypassedBy).toBe("env-var");
    expect(result.info.technique).toBe("none");
    expect(result.info.originalBytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(result.info.outputBytes).toBe(Buffer.byteLength("hello world\n", "utf8"));
    expect(result.info.compressionRatio).toBe(1);
  });
});


describe("PI_RTK_BYPASS non-matching variants", () => {
  it.each([
    "PI_RTK_BYPASS=0 npm test",
    "PI_RTK_BYPASSED=1 npm test",
    "FOO_PI_RTK_BYPASS=1 npm test",
  ])("%s does not bypass", (command) => {
    const result = filterBashOutput(command, "\x1b[31mX\x1b[0m\n");
    expect(result.info.bypassedBy).toBeUndefined();
    expect(result.info.technique).toBe("test-output");
  });
});

describe("PI_RTK_BYPASS=1 with anti-pattern hint", () => {
  it("still appends the cat hint under bypass", () => {
    const result = filterBashOutput("PI_RTK_BYPASS=1 cat README.md", "line1\nline2\n");
    expect(result.output).toBe("line1\nline2\n\n\n[Hint: Prefer the read tool for file contents.]");
    expect(result.info.bypassedBy).toBe("env-var");
    expect(result.info.technique).toBe("none");
  });
});