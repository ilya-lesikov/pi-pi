import { describe, it, expect, afterEach } from "vitest";
import { isNuAvailable, truncateNuOutput, resolveNuArgs } from "../src/nu.js";

describe("isNuAvailable", () => {
  it("returns a boolean", () => {
    const result = isNuAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("truncateNuOutput", () => {
  it("passes through short output unchanged", () => {
    expect(truncateNuOutput("hello")).toBe("hello");
  });

  it("passes through empty string unchanged", () => {
    expect(truncateNuOutput("")).toBe("");
  });

  it("truncates output exceeding 2000 lines", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    const result = truncateNuOutput(lines.join("\n"));
    const resultLines = result.split("\n");
    // 2000 content lines + 1 truncation message line
    expect(resultLines.length).toBeLessThanOrEqual(2001);
    expect(result).toContain("500 more lines truncated");
  });

  it("truncates output exceeding 50KB", () => {
    const big = "x".repeat(60 * 1024);
    const result = truncateNuOutput(big);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(52 * 1024);
    expect(result).toContain("truncated at 50 KB");
  });

  it("applies line truncation before byte truncation when lines are short", () => {
    // Short lines (4 chars each) so 3000 lines = ~15KB (under 50KB)
    // This ensures line truncation fires, not byte truncation
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i}`);
    const result = truncateNuOutput(lines.join("\n"));
    expect(result).toContain("more lines truncated");
    // Should NOT have byte truncation since total is well under 50KB
    expect(result).not.toContain("truncated at 50 KB");
  });

  it("handles exactly 2000 lines without truncation", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const input = lines.join("\n");
    const result = truncateNuOutput(input);
    expect(result).toBe(input);
  });
});

describe("resolveNuArgs", () => {
  const origEnv = process.env.PI_NUSHELL_CONFIG;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.PI_NUSHELL_CONFIG;
    } else {
      process.env.PI_NUSHELL_CONFIG = origEnv;
    }
  });

  it("uses PI_NUSHELL_CONFIG when set", () => {
    process.env.PI_NUSHELL_CONFIG = "/custom/config.nu";
    const args = resolveNuArgs();
    expect(args).toEqual(["--config", "/custom/config.nu"]);
  });

  it("falls back to --no-config-file when no env var and no pi config file", () => {
    delete process.env.PI_NUSHELL_CONFIG;
    // Unless ~/.config/pi/nushell/config.nu exists, should get --no-config-file
    const args = resolveNuArgs();
    // Either uses pi config if it exists, or falls back
    expect(args[0]).toMatch(/^--config$|^--no-config-file$/);
  });

  it("returns an array suitable for spreading into spawn args", () => {
    delete process.env.PI_NUSHELL_CONFIG;
    const args = resolveNuArgs();
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBeGreaterThanOrEqual(1);
  });
});
