import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, resolve, relative, isAbsolute, sep } from "path";
import lockfile from "proper-lockfile";
import { normalizeRepoPath, type RepoInfo } from "./repo-utils.js";

function getLockfileFs(): typeof import("fs") | undefined {
  try {
    const fs = require("fs");
    fs.statSync(process.cwd());
    return fs;
  } catch {
    return undefined;
  }
}
import type { TimeoutConfig } from "./config.js";

export type TaskType = "implement" | "debug" | "brainstorm" | "review";

export type ImplementPhase = "brainstorm" | "plan" | "implement" | "done";
export type DebugPhase = "debug" | "plan" | "implement" | "done";
export type BrainstormPhase = "brainstorm" | "plan" | "implement" | "done";
export type ReviewPhase = "review" | "plan" | "implement" | "done";
export type Phase = ImplementPhase | DebugPhase | BrainstormPhase | ReviewPhase;

export interface TaskState {
  phase: Phase;
  step: string | null;
  reviewCycle: { kind: string; step: string; pass: number } | null;
  reviewPass: number;
  reviewPassByKind?: Record<string, number>;
  modifiedFiles?: string[];
  repos?: RepoInfo[];
  from: string | null;
  description: string;
  startedAt: string;
  activePlannerPreset?: string;
  activeReviewPreset?: string;

}

export interface TaskInfo {
  dir: string;
  state: TaskState;
  type: TaskType;
}

function stateDir(cwd: string): string {
  return join(cwd, ".pp", "state");
}

function taskStatePath(taskDir: string): string {
  return join(taskDir, "state.json");
}

export function createTask(cwd: string, type: TaskType, description: string): string {
  const id = crypto.randomUUID().slice(0, 12);
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const dirName = `${id}_${safeName}`;
  const taskDir = join(stateDir(cwd), type, dirName);

  mkdirSync(taskDir, { recursive: true });

  const state: TaskState = {
    phase: type === "implement" ? "brainstorm" : type === "debug" ? "debug" : type === "review" ? "review" : "brainstorm",
    step: "llm_work",
    reviewCycle: null,
    reviewPass: 0,
    repos: [{ path: normalizeRepoPath(cwd), isRoot: true }],
    from: null,
    description,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(taskStatePath(taskDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
  return taskDir;
}

export function loadTask(taskDir: string): TaskState {
  const sp = taskStatePath(taskDir);
  const raw = readFileSync(sp, "utf-8");
  try {
    const state = JSON.parse(raw) as TaskState;
    if ((state as any).phase === "planning") {
      state.phase = "plan";
    }
    if ((state as any).repoCwd && (!state.repos || state.repos.length === 0)) {
      state.repos = [{ path: (state as any).repoCwd, isRoot: false }];
    }
    if (!state.repos) state.repos = [];
    delete (state as any).repoCwd;
    return state;
  } catch (err: any) {
    throw new Error(`Failed to parse ${sp}: ${err.message}`);
  }
}

export function saveTask(taskDir: string, state: TaskState): void {
  writeFileSync(taskStatePath(taskDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function listTasks(cwd: string, type?: TaskType): TaskInfo[] {
  const base = stateDir(cwd);
  if (!existsSync(base)) return [];

  const types: TaskType[] = type ? [type] : ["implement", "debug", "brainstorm", "review"];
  const results: TaskInfo[] = [];

  for (const t of types) {
    const typeDir = join(base, t);
    if (!existsSync(typeDir)) continue;

    for (const entry of readdirSync(typeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(typeDir, entry.name);
      const sp = taskStatePath(dir);
      if (!existsSync(sp)) continue;

      try {
        const state = loadTask(dir);
        if (state.phase !== "done") {
          results.push({ dir, state, type: t });
        }
      } catch {
        console.error(`[pi-pi] Skipping corrupt task at ${dir}`);
      }
    }
  }

  results.sort((a, b) => {
    const aTime = a.state.startedAt ? new Date(a.state.startedAt).getTime() : 0;
    const bTime = b.state.startedAt ? new Date(b.state.startedAt).getTime() : 0;
    return bTime - aTime;
  });

  return results;
}

export async function lockTask(taskDir: string, timeouts: TimeoutConfig): Promise<() => Promise<void>> {
  const sp = taskStatePath(taskDir);
  if (!existsSync(sp)) {
    throw new Error(`Task state file not found: ${sp}`);
  }
  const lockFs = getLockfileFs();
  const release = await lockfile.lock(sp, {
    ...(lockFs && { fs: lockFs }),
    stale: timeouts.lockStale,
    update: timeouts.lockUpdate,
    retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
    onCompromised: (err: Error) => {
      console.error(`[pi-pi] Lock compromised for ${sp}: ${err.message}`);
    },
  });
  return release;
}

export function getActiveTask(cwd: string, lockStale?: number): TaskInfo | null {
  const tasks = listTasks(cwd);
  if (tasks.length === 0) return null;

  const stale = lockStale ?? 600000;
  const unlocked: TaskInfo[] = [];
  for (const task of tasks) {
    try {
      const checkFs = getLockfileFs();
      if (!lockfile.checkSync(taskStatePath(task.dir), { ...(checkFs && { fs: checkFs }), stale })) {
        unlocked.push(task);
      }
    } catch {
      console.error(`[pi-pi] Failed to check lock for ${task.dir}`);
    }
  }

  if (unlocked.length !== 1) return null;
  return unlocked[0];
}

export function validateFromPath(cwd: string, fromPath: string): { ok: true; dir: string } | { ok: false; reason: string } {
  if (fromPath.includes("..")) {
    return { ok: false, reason: "Path must not contain '..'" };
  }

  const stateRoot = resolve(stateDir(cwd));
  const resolved = resolve(stateRoot, fromPath);
  const rel = relative(stateRoot, resolved);

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: "Path escapes .pp/state/ directory" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, reason: `Source task not found: ${fromPath}` };
  }

  const sp = taskStatePath(resolved);
  if (!existsSync(sp)) {
    return { ok: false, reason: `No state.json found at ${fromPath} — not a valid task directory` };
  }

  return { ok: true, dir: resolved };
}

export function taskName(taskDir: string): string {
  try {
    const state = loadTask(taskDir);
    let desc = state.description ?? "";

    if (["implement", "debug", "brainstorm", "review"].includes(desc)) {
      const urPath = join(taskDir, "USER_REQUEST.md");
      if (existsSync(urPath)) {
        const content = readFileSync(urPath, "utf-8");
        const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        const firstContent = lines.find((l) => !l.startsWith("#"));
        if (firstContent) desc = firstContent;
      }
    }

    if (desc) {
      desc = desc.replace(/\s+/g, " ").trim();
      if (desc.length > 60) desc = desc.slice(0, 57) + "...";
      return desc;
    }
  } catch {
    console.error(`[pi-pi] Failed to read task name from ${taskDir}`);
  }
  const dir = basename(taskDir);
  const match = dir.match(/^\d+_(.+)$/);
  return match ? match[1].replace(/-/g, " ") : dir;
}

export function taskAge(state: TaskState): string {
  const ms = Date.now() - new Date(state.startedAt).getTime();
  if (isNaN(ms)) return "?";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function appendTaskLog(taskDir: string, fileName: string, entry: Record<string, unknown>): string {
  mkdirSync(taskDir, { recursive: true });
  const filePath = join(taskDir, fileName);
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  return filePath;
}
