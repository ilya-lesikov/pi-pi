import { execSync } from "child_process";
import { dirname } from "path";
import { minimatch } from "minimatch";
import type { AfterEditCommandConfig } from "./config.js";

export interface CommandResult {
  ok: boolean;
  command: string;
  output: string;
}

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function substituteVars(command: string, file: string): string {
  return command
    .replace(/\$\{file\}/g, shellEscape(file))
    .replace(/\$\{dir\}/g, shellEscape(dirname(file)));
}

export function runAfterEdit(
  file: string,
  commands: Record<string, AfterEditCommandConfig>,
  timeout: number,
  cwd: string,
): CommandResult[] {
  const results: CommandResult[] = [];
  for (const cmd of Object.values(commands)) {
    if (cmd.enabled === false) continue;
    const globs = cmd.globs ?? [];
    const matches = globs.length === 0 || globs.some((glob) => minimatch(file, glob, { matchBase: true }));
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
