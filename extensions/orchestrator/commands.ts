import { execSync, execFileSync } from "child_process";
import { dirname } from "path";
import { minimatch } from "minimatch";
import type { PiPiConfig, AfterEditCommand } from "./config.js";

interface CommandResult {
  ok: boolean;
  command: string;
  output: string;
}

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function substituteVars(command: string, file?: string): string {
  let result = command;
  if (file) {
    result = result.replace(/\$\{file\}/g, shellEscape(file));
    result = result.replace(/\$\{dir\}/g, shellEscape(dirname(file)));
  }
  return result;
}

export function runAfterEdit(file: string, config: PiPiConfig, cwd: string): CommandResult[] {
  const results: CommandResult[] = [];
  const timeout = config.timeouts.afterEdit;

  for (const cmd of config.commands.afterEdit) {
    const matches = !cmd.glob || cmd.glob.length === 0 || cmd.glob.some((g) => minimatch(file, g, { matchBase: true }));
    if (!matches) continue;

    const command = substituteVars(cmd.run, file);
    try {
      const output = execSync(command, { cwd, encoding: "utf-8", timeout, stdio: "pipe" });
      results.push({ ok: true, command, output: output.trim() });
    } catch (err: any) {
      results.push({ ok: false, command, output: err.stderr?.toString() || err.message || "unknown error" });
    }
  }

  return results;
}

export function runAfterImplement(config: PiPiConfig, cwd: string): CommandResult[] {
  const results: CommandResult[] = [];
  const timeout = config.timeouts.afterImplement;

  for (const cmd of config.commands.afterImplement) {
    const command = substituteVars(cmd.run);
    try {
      const output = execSync(command, { cwd, encoding: "utf-8", timeout, stdio: "pipe" });
      results.push({ ok: true, command, output: output.trim() });
    } catch (err: any) {
      results.push({ ok: false, command, output: err.stderr?.toString() || err.message || "unknown error" });
    }
  }

  return results;
}

export function autoCommit(files: string[], checkpointText: string, cwd: string): { ok: boolean; commitHash?: string; error?: string } {
  if (files.length === 0) return { ok: true };

  const message = checkpointText
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^\s*-\s*\[.\]\s*/, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
    .replace(/^./, (c) => c.toLowerCase()) || "checkpoint";

  try {
    execFileSync("git", ["add", "--", ...files], { cwd, encoding: "utf-8", stdio: "pipe" });
    const output = execFileSync("git", ["commit", "-m", message], { cwd, encoding: "utf-8", stdio: "pipe" });
    const hashMatch = output.match(/\[[\w-]+ (?:\([^)]+\) )?([a-f0-9]+)\]/);
    return { ok: true, commitHash: hashMatch?.[1] };
  } catch (err: any) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}
