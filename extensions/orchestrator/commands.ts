import { execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { minimatch } from "minimatch";
import type { AfterEditCommand, AfterImplementCommand } from "./config.js";

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

export function runAfterEdit(file: string, commands: AfterEditCommand[], timeout: number, cwd: string): CommandResult[] {
  const results: CommandResult[] = [];

  for (const cmd of commands) {
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

export function runAfterImplement(commands: AfterImplementCommand[], timeout: number, cwd: string): CommandResult[] {
  const results: CommandResult[] = [];

  for (const cmd of commands) {
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

function loadRepoConfig(repoPath: string): Record<string, any> | null {
  const configPath = join(repoPath, ".pp", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export function loadRepoAfterEditCommands(repoPath: string): AfterEditCommand[] | null {
  const raw = loadRepoConfig(repoPath);
  if (!raw) return null;
  const commands = raw?.commands?.afterEdit;
  if (!Array.isArray(commands)) return null;

  const valid: AfterEditCommand[] = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    const run = (cmd as any).run;
    if (typeof run !== "string" || run.length === 0) continue;
    const globRaw = (cmd as any).glob;
    const glob = Array.isArray(globRaw) ? globRaw.filter((g): g is string => typeof g === "string") : [];
    valid.push({ run, glob });
  }
  return valid;
}

export function loadRepoAfterImplementCommands(repoPath: string): AfterImplementCommand[] | null {
  const raw = loadRepoConfig(repoPath);
  if (!raw) return null;
  const commands = raw?.commands?.afterImplement;
  if (!Array.isArray(commands)) return null;

  const valid: AfterImplementCommand[] = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    const run = (cmd as any).run;
    if (typeof run !== "string" || run.length === 0) continue;
    valid.push({ run });
  }
  return valid;
}

export function autoCommit(files: string[], message: string, cwd: string): { ok: boolean; commitHash?: string; error?: string } {
  if (files.length === 0) return { ok: true };

  const cleanMessage = message.trim().slice(0, 72) || "checkpoint";

  try {
    execFileSync("git", ["add", "--", ...files], { cwd, encoding: "utf-8", stdio: "pipe" });
    const output =     execFileSync("git", ["commit", "-m", cleanMessage], { cwd, encoding: "utf-8", stdio: "pipe" });
    const hashMatch = output.match(/\[[\w-]+ (?:\([^)]+\) )?([a-f0-9]+)\]/);
    return { ok: true, commitHash: hashMatch?.[1] };
  } catch (err: any) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}
