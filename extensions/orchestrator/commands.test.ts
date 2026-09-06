import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAfterEdit } from "./commands.js";

describe("runAfterEdit", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pp-commands-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runs matching commands with ${file} substitution and reports success", () => {
    const results = runAfterEdit("src/app.ts", { echo: { run: "echo edited ${file}", globs: ["*.ts"] } }, 5000, cwd);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toBe("edited src/app.ts");
  });

  it("skips non-matching globs and disabled commands", () => {
    const results = runAfterEdit("src/app.py", {
      ts: { run: "echo ts", globs: ["*.ts"] },
      off: { run: "echo off", globs: ["*.py"], enabled: false },
      all: { run: "echo all" },
    }, 5000, cwd);
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe("all");
  });

  it("captures failures without throwing", () => {
    const results = runAfterEdit("a.ts", { bad: { run: "exit 3", globs: ["*.ts"] } }, 5000, cwd);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });

  it("escapes shell metacharacters in the file path", () => {
    const results = runAfterEdit("a b'; echo pwned;'.ts", { echo: { run: "echo ${file}" } }, 5000, cwd);
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toBe("a b'; echo pwned;'.ts");
  });
});
