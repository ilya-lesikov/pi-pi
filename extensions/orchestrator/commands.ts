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
    if (cmd.enabled === false || typeof cmd.run !== "string" || cmd.run.length === 0) continue;
    const globs = cmd.globs ?? [];
    const matches = globs.length === 0 || globs.some((glob) => minimatch(file, glob, { matchBase: true }));
    if (!matches) continue;
    const command = substituteVars(cmd.run, file);
    try {
      const output = execSync(command, { cwd, encoding: "utf-8", timeout, stdio: "pipe" });
      results.push({ ok: true, command, output: output.trim() });
    } catch (err: any) {
      // Formatters and linters routinely report the actionable part of a failure
      // on stdout, so reporting stderr alone leaves the agent nothing to act on.
      const streams = [err.stdout?.toString().trim(), err.stderr?.toString().trim()].filter(Boolean);
      results.push({ ok: false, command, output: streams.join("\n") || err.message || "unknown error" });
    }
  }
  return results;
}
