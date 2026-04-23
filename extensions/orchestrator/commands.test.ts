import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { autoCommit } from "./commands.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-pi-commands-"));
  tempDirs.push(cwd);

  execFileSync("git", ["init"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Pi Pi Tests"], { cwd, stdio: "pipe" });

  return cwd;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("autoCommit", () => {
  it("falls back to checkpoint when message is empty", () => {
    const cwd = makeRepo();
    const file = "a.ts";
    writeFileSync(join(cwd, file), "export const a = 1;\n", "utf-8");

    const result = autoCommit([file], "  ", cwd);

    expect(result.ok).toBe(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(head).toMatch(/^[a-f0-9]+$/);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(subject).toBe("checkpoint");
  });

  it("uses message as-is for commit", () => {
    const cwd = makeRepo();
    const file = "b.ts";
    writeFileSync(join(cwd, file), "export const b = 1;\n", "utf-8");

    const result = autoCommit([file], "fix: resolve auth token expiry", cwd);

    expect(result.ok).toBe(true);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(subject).toBe("fix: resolve auth token expiry");
  });

  it("truncates long messages to 72 chars", () => {
    const cwd = makeRepo();
    const file = "c.ts";
    writeFileSync(join(cwd, file), "export const c = 1;\n", "utf-8");

    const longMsg = "a".repeat(100);
    const result = autoCommit([file], longMsg, cwd);

    expect(result.ok).toBe(true);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(subject).toBe("a".repeat(72));
  });

  it("commits files with spaces in names", () => {
    const cwd = makeRepo();
    const file = "file with spaces.ts";
    writeFileSync(join(cwd, file), "export const spaced = true;\n", "utf-8");

    const result = autoCommit([file], "spaced file", cwd);

    expect(result.ok).toBe(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(head).toMatch(/^[a-f0-9]+$/);
    const committedFiles = execFileSync("git", ["show", "--name-only", "--pretty="], { cwd, encoding: "utf-8", stdio: "pipe" });
    expect(committedFiles.split("\n")).toContain(file);
  });
});
