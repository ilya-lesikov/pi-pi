import { describe, it, expect } from "vitest";
import { isLinterCommand, aggregateLinterOutput } from "../src/rtk/linter.js";

describe("isLinterCommand", () => {
  it("matches eslint", () => {
    expect(isLinterCommand("npx eslint src/")).toBe(true);
  });

  it("matches prettier", () => {
    expect(isLinterCommand("prettier --check .")).toBe(true);
  });

  it("matches ruff", () => {
    expect(isLinterCommand("ruff check .")).toBe(true);
  });

  it("matches clippy", () => {
    expect(isLinterCommand("cargo clippy")).toBe(true);
  });

  it("matches mypy", () => {
    expect(isLinterCommand("mypy src/")).toBe(true);
  });

  it("matches flake8", () => {
    expect(isLinterCommand("flake8 .")).toBe(true);
  });

  it("matches black", () => {
    expect(isLinterCommand("black --check .")).toBe(true);
  });

  it("matches golangci-lint", () => {
    expect(isLinterCommand("golangci-lint run")).toBe(true);
  });

  it("matches pylint", () => {
    expect(isLinterCommand("pylint src/")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLinterCommand("ESLint src/")).toBe(true);
  });

  it("rejects npm test", () => {
    expect(isLinterCommand("npm test")).toBe(false);
  });

  it("rejects cargo build", () => {
    expect(isLinterCommand("cargo build")).toBe(false);
  });

  it("rejects git status", () => {
    expect(isLinterCommand("git status")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isLinterCommand(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isLinterCommand(null)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isLinterCommand("")).toBe(false);
  });
});

describe("aggregateLinterOutput", () => {
  it("returns null for non-linter commands", () => {
    expect(aggregateLinterOutput("some output", "npm test")).toBeNull();
  });

  it("reports no issues for empty parseable output", () => {
    const result = aggregateLinterOutput("", "eslint src/");
    expect(result).toContain("No issues found");
  });

  it("aggregates eslint error output", () => {
    const output = [
      "src/foo.ts:10:5: Missing semicolon [semi]",
      "src/foo.ts:20:3: Unexpected var [no-var]",
      "src/bar.ts:5:1: Missing return [consistent-return]",
    ].join("\n");

    const result = aggregateLinterOutput(output, "eslint src/");
    expect(result).not.toBeNull();
    expect(result).toContain("ESLint");
    expect(result).toContain("3 errors");
    expect(result).toContain("2 files");
  });

  it("aggregates ruff output", () => {
    const output = [
      "src/main.py:10:5: E501 Line too long [E501]",
      "src/main.py:20:1: F401 Unused import [F401]",
    ].join("\n");

    const result = aggregateLinterOutput(output, "ruff check .");
    expect(result).not.toBeNull();
    expect(result).toContain("Ruff");
    expect(result).toContain("errors");
  });

  it("aggregates clippy output", () => {
    const output = "error: unused variable at src/main.rs:10:5";
    const result = aggregateLinterOutput(output, "cargo clippy");
    expect(result).not.toBeNull();
    expect(result).toContain("Clippy");
  });

  it("shows top rules breakdown", () => {
    const output = [
      "src/a.ts:1:1: msg [semi]",
      "src/a.ts:2:1: msg [semi]",
      "src/a.ts:3:1: msg [no-var]",
    ].join("\n");

    const result = aggregateLinterOutput(output, "eslint .");
    expect(result).not.toBeNull();
    expect(result).toContain("semi");
    expect(result).toContain("2x");
  });

  it("shows top files breakdown", () => {
    const output = [
      "src/a.ts:1:1: msg [rule1]",
      "src/a.ts:2:1: msg [rule1]",
      "src/b.ts:1:1: msg [rule1]",
    ].join("\n");

    const result = aggregateLinterOutput(output, "eslint .");
    expect(result).not.toBeNull();
    expect(result).toContain("src/a.ts");
    expect(result).toContain("2 issues");
  });

  it("returns null for undefined command", () => {
    expect(aggregateLinterOutput("output", undefined)).toBeNull();
  });
});
