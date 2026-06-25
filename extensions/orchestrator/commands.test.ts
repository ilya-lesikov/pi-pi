import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoCommit,
  loadRepoAfterEditCommands,
  loadRepoAfterImplementCommands,
  runAfterEdit,
  runAfterImplement,
} from "./commands.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-pi-commands-"));
  tempDirs.push(cwd);

  execFileSync("git", ["init"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Pi Pi Tests"], { cwd, stdio: "pipe" });

  return cwd;
}

function makeDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-pi-commands-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("autoCommit", () => {
  it("returns ok when there are no files", () => {
    const cwd = makeRepo();

    const result = autoCommit([], "ignored", cwd);

    expect(result).toEqual({ ok: true });
  });

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

  it("commits renamed files when new path is provided", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "old.ts"), "export const oldValue = 1;\n", "utf-8");
    autoCommit(["old.ts"], "seed", cwd);

    execFileSync("git", ["mv", "old.ts", "new.ts"], { cwd, stdio: "pipe" });

    const result = autoCommit(["new.ts"], "rename old to new", cwd);

    expect(result.ok).toBe(true);
    const status = execFileSync("git", ["show", "--name-status", "--pretty="], { cwd, encoding: "utf-8", stdio: "pipe" });
    expect(status).toContain("R100\told.ts\tnew.ts");
  });

  it("returns error when commit fails", () => {
    const cwd = makeRepo();

    const result = autoCommit(["missing.ts"], "should fail", cwd);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("runAfterEdit", () => {
  it("runs commands only when glob matches", () => {
    const cwd = makeDir();
    const outFile = join(cwd, "out.txt");
    const commands = [
      { run: `node -e "require('fs').appendFileSync(process.argv[1], 'ts\\n')" ${JSON.stringify(outFile)}`, glob: ["**/*.ts"] },
      { run: `node -e "require('fs').appendFileSync(process.argv[1], 'js\\n')" ${JSON.stringify(outFile)}`, glob: ["**/*.js"] },
    ];

    const results = runAfterEdit("src/file.ts", commands, 5000, cwd);

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.command).toContain("appendFileSync");
    const out = execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(outFile)}, 'utf-8'))`], { encoding: "utf-8" });
    expect(out).toBe("ts\n");
  });

  it("substitutes file and dir variables", () => {
    const cwd = makeDir();
    const commands = [
      { run: "node -e \"process.stdout.write(process.argv.slice(1).join('|'))\" ${file} ${dir}", glob: ["**/*.ts"] },
    ];

    const results = runAfterEdit("src/nested/file.ts", commands, 5000, cwd);

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.output).toBe("src/nested/file.ts|src/nested");
  });

  it("returns failure result on timeout", () => {
    const cwd = makeDir();
    const commands = [{ run: "node -e \"setTimeout(() => {}, 200)\"", glob: ["**/*.ts"] }];

    const results = runAfterEdit("src/slow.ts", commands, 20, cwd);

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.output.length).toBeGreaterThan(0);
  });

  it("propagates stderr output on failure", () => {
    const cwd = makeDir();
    const commands = [{ run: "node -e \"process.stderr.write('boom'); process.exit(2)\"", glob: ["**/*.ts"] }];

    const results = runAfterEdit("src/fail.ts", commands, 5000, cwd);

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.output).toContain("boom");
  });

  it("returns mixed results when some commands fail", () => {
    const cwd = makeDir();
    const commands = [
      { run: "node -e \"process.stdout.write('ok1')\"", glob: ["**/*.ts"] },
      { run: "node -e \"process.stderr.write('nope'); process.exit(1)\"", glob: ["**/*.ts"] },
      { run: "node -e \"process.stdout.write('ok2')\"", glob: ["**/*.ts"] },
    ];

    const results = runAfterEdit("src/mixed.ts", commands, 5000, cwd);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]?.output).toContain("nope");
  });
});

describe("runAfterImplement", () => {
  it("runs commands and captures output", () => {
    const cwd = makeDir();

    const results = runAfterImplement([{ run: "node -e \"process.stdout.write('done')\"" }], 5000, cwd);

    expect(results).toEqual([{ ok: true, command: "node -e \"process.stdout.write('done')\"", output: "done" }]);
  });

  it("propagates failure output", () => {
    const cwd = makeDir();

    const results = runAfterImplement([{ run: "node -e \"process.stderr.write('broken'); process.exit(1)\"" }], 5000, cwd);

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.output).toContain("broken");
  });
});

describe("loadRepoAfterEditCommands", () => {
  it("loads commands from repo .pp/config.json", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(
      join(cwd, ".pp", "config.json"),
      JSON.stringify({ commands: { afterEdit: [{ run: "npm test", glob: ["**/*.ts"] }] } }),
      "utf-8",
    );

    const commands = loadRepoAfterEditCommands(cwd);

    expect(commands).toEqual([{ run: "npm test", glob: ["**/*.ts"] }]);
  });

  it("returns null when config is missing", () => {
    const cwd = makeDir();

    const commands = loadRepoAfterEditCommands(cwd);

    expect(commands).toBeNull();
  });

  it("filters invalid entries", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(
      join(cwd, ".pp", "config.json"),
      JSON.stringify({
        commands: {
          afterEdit: [
            null,
            { run: "" },
            { run: 1 },
            { run: "valid-one", glob: ["**/*.ts", 1, null] },
            { run: "valid-two" },
          ],
        },
      }),
      "utf-8",
    );

    const commands = loadRepoAfterEditCommands(cwd);

    expect(commands).toEqual([
      { run: "valid-one", glob: ["**/*.ts"] },
      { run: "valid-two", glob: [] },
    ]);
  });
});

describe("loadRepoAfterImplementCommands", () => {
  it("loads commands from repo .pp/config.json", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(
      join(cwd, ".pp", "config.json"),
      JSON.stringify({ commands: { afterImplement: [{ run: "npm run check" }] } }),
      "utf-8",
    );

    const commands = loadRepoAfterImplementCommands(cwd);

    expect(commands).toEqual([{ run: "npm run check" }]);
  });

  it("returns null when config is missing", () => {
    const cwd = makeDir();

    const commands = loadRepoAfterImplementCommands(cwd);

    expect(commands).toBeNull();
  });

  it("filters invalid entries", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(
      join(cwd, ".pp", "config.json"),
      JSON.stringify({
        commands: {
          afterImplement: [
            null,
            { run: "" },
            { run: 1 },
            { run: "valid" },
          ],
        },
      }),
      "utf-8",
    );

    const commands = loadRepoAfterImplementCommands(cwd);

    expect(commands).toEqual([{ run: "valid" }]);
  });
});
