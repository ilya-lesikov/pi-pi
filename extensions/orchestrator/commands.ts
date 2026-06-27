import { execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { minimatch } from "minimatch";
import type { AfterEditCommandConfig, AfterImplementCommandConfig } from "./config.js";

interface CommandResult {
  ok: boolean;
  command: string;
  output: string;
}

function isEnabled(command: { enabled?: boolean }): boolean {
  return command.enabled !== false;
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

export function runAfterEdit(
  file: string,
  commands: Record<string, AfterEditCommandConfig>,
  timeout: number,
  cwd: string,
): CommandResult[] {
  const results: CommandResult[] = [];

  for (const cmd of Object.values(commands)) {
    if (!isEnabled(cmd)) continue;
    const globs = cmd.globs ?? [];
    const matches = globs.length === 0 || globs.some((g) => minimatch(file, g, { matchBase: true }));
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

// Executes shell commands from config via execSync. For the root repo these come
// from the user's own .pp/config.json; for sub-repos they are loaded only when
// general.loadExtraRepoConfigs is explicitly enabled (off by default), so running
// them is a deliberate, opt-in trust decision in the same security domain as the
// repos the user registered.
export function runAfterImplement(
  commands: Record<string, AfterImplementCommandConfig>,
  timeout: number,
  cwd: string,
): CommandResult[] {
  const results: CommandResult[] = [];

  for (const cmd of Object.values(commands)) {
    if (!isEnabled(cmd)) continue;
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

export function loadRepoAfterEditCommands(repoPath: string): Record<string, AfterEditCommandConfig> | null {
  const raw = loadRepoConfig(repoPath);
  if (!raw) return null;
  const commands = raw?.commands?.afterEdit;
  if (!commands || typeof commands !== "object") return null;

  if (Array.isArray(commands)) {
    const valid: Record<string, AfterEditCommandConfig> = {};
    for (const [index, cmd] of commands.entries()) {
      if (!cmd || typeof cmd !== "object") continue;
      const run = (cmd as any).run;
      if (typeof run !== "string" || run.length === 0) continue;
      const globsRaw = (cmd as any).globs ?? (cmd as any).glob;
      const globs = Array.isArray(globsRaw) ? globsRaw.filter((g): g is string => typeof g === "string") : undefined;
      valid[`cmd-${index + 1}`] = { run, ...(globs && globs.length > 0 ? { globs } : {}) };
    }
    return Object.keys(valid).length > 0 ? valid : null;
  }

  const valid: Record<string, AfterEditCommandConfig> = {};
  for (const [id, cmd] of Object.entries(commands as Record<string, unknown>)) {
    if (!cmd || typeof cmd !== "object") continue;
    const run = (cmd as any).run;
    if (typeof run !== "string" || run.length === 0) continue;
    const enabledRaw = (cmd as any).enabled;
    const globsRaw = (cmd as any).globs ?? (cmd as any).glob;
    const globs = Array.isArray(globsRaw) ? globsRaw.filter((g): g is string => typeof g === "string") : undefined;
    valid[id] = {
      run,
      ...(globs && globs.length > 0 ? { globs } : {}),
      ...(typeof enabledRaw === "boolean" ? { enabled: enabledRaw } : {}),
    };
  }
  return valid;
}

export function loadRepoAfterImplementCommands(repoPath: string): Record<string, AfterImplementCommandConfig> | null {
  const raw = loadRepoConfig(repoPath);
  if (!raw) return null;
  const commands = raw?.commands?.afterImplement;
  if (!commands || typeof commands !== "object") return null;

  if (Array.isArray(commands)) {
    const valid: Record<string, AfterImplementCommandConfig> = {};
    for (const [index, cmd] of commands.entries()) {
      if (!cmd || typeof cmd !== "object") continue;
      const run = (cmd as any).run;
      if (typeof run !== "string" || run.length === 0) continue;
      valid[`cmd-${index + 1}`] = { run };
    }
    return Object.keys(valid).length > 0 ? valid : null;
  }

  const valid: Record<string, AfterImplementCommandConfig> = {};
  for (const [id, cmd] of Object.entries(commands as Record<string, unknown>)) {
    if (!cmd || typeof cmd !== "object") continue;
    const run = (cmd as any).run;
    if (typeof run !== "string" || run.length === 0) continue;
    const enabledRaw = (cmd as any).enabled;
    valid[id] = {
      run,
      ...(typeof enabledRaw === "boolean" ? { enabled: enabledRaw } : {}),
    };
  }
  return valid;
}

export function autoCommit(files: string[], message: string, cwd: string): { ok: boolean; commitHash?: string; error?: string } {
  if (files.length === 0) return { ok: true };

  const cleanMessage = message.trim().slice(0, 72) || "checkpoint";

  try {
    execFileSync("git", ["add", "--", ...files], { cwd, encoding: "utf-8", stdio: "pipe" });
    const output =     execFileSync("git", ["commit", "-m", cleanMessage], { cwd, encoding: "utf-8", stdio: "pipe" });
    const hashMatch = output.match(/\[[^\]]* ([a-f0-9]{7,40})\]/);
    return { ok: true, commitHash: hashMatch?.[1] };
  } catch (err: any) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}
