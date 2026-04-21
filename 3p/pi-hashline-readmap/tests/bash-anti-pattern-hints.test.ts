import { describe, it, expect } from "vitest";
import { filterBashOutput } from "../src/rtk/bash-filter.js";

describe("bash anti-pattern hints", () => {
  it("adds a cat hint", () => {
    expect(filterBashOutput("cat src/read.ts", "file body").output).toContain("Prefer the read tool");
  });

  it("adds grep and rg hints", () => {
    expect(filterBashOutput("grep -n hashline src/read.ts", "grep body").output).toContain("Prefer the grep tool");
    expect(filterBashOutput("rg hashline src", "rg body").output).toContain("Prefer the grep tool");
  });

  it("adds a sed inspection hint", () => {
    expect(filterBashOutput("sed -n '1,20p' src/read.ts", "sed body").output).toContain(
      "Prefer the read tool for file inspection and the edit tool for changes.",
    );
  });

  it("adds a find repo-discovery hint", () => {
    expect(filterBashOutput("find src -name '*.ts'", "src/read.ts").output).toContain(
      "Prefer the dedicated file-search tools for repository discovery.",
    );
  });

  it("appends the cat hint without replacing the shaped output", () => {
    const out = filterBashOutput("cat src/read.ts", "file body").output;
    expect(out).toContain("file body");
    expect(out).toContain("Prefer the read tool");
  });

  it("leaves unrelated commands unchanged", () => {
    expect(filterBashOutput("echo hello", "hello").output).toBe("hello");
  });
});
