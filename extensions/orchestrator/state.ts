import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, resolve, relative, isAbsolute, sep } from "path";
import lockfile from "proper-lockfile";
import { normalizeRepoPath, type RepoInfo } from "./repo-utils.js";
import { getLogger } from "./log.js";

function getLockfileFs(): typeof import("fs") | undefined {
  try {
    const fs = require("fs");
    fs.statSync(process.cwd());
    return fs;
  } catch (err: any) {
    getLogger().debug({ s: "state", err: err?.message }, "getLockfileFs unavailable");
    return undefined;
  }
}
import type { TimeoutConfig } from "./config.js";

export type TaskMode = "guided" | "autonomous";

export interface AutonomousPhaseConfig {
  plannerPreset?: string;
  reviewPreset?: string;
  maxReviewPasses: number;
}

export interface AutonomousConfig {
  phases: Record<string, AutonomousPhaseConfig>;
}

export type TaskType = "implement" | "debug" | "brainstorm" | "review" | "quick";

export type ImplementPhase = "brainstorm" | "plan" | "implement" | "done";
export type DebugPhase = "debug" | "plan" | "implement" | "done";
export type BrainstormPhase = "brainstorm" | "plan" | "implement" | "done";
export type ReviewPhase = "review" | "plan" | "implement" | "done";
export type QuickPhase = "quick";
export type Phase = ImplementPhase | DebugPhase | BrainstormPhase | ReviewPhase | QuickPhase;

export interface TaskState {
  phase: Phase;
  initialPhase?: string;
  step: string | null;
  reviewCycle: { kind: string; step: string; pass: number } | null;
  reviewPass: number;
  reviewPassByKind?: Record<string, Record<string, number>>;
  reviewApprovedClean?: boolean;
  modifiedFiles?: string[];
  committedFiles?: string[];
  repos?: RepoInfo[];
  from: string | null;
  description: string;
  startedAt: string;
  activePlannerPreset?: string;
  activeReviewPreset?: string;
  mode?: TaskMode;
  effectiveMode?: TaskMode;
  autonomousConfig?: AutonomousConfig;
  // Manual auto-review-until-approved (#5/#7): drives the same review-cycle loop
  // as autonomous mode over ONE phase, independently of effectiveMode (so it
  // works in force-guided brainstorm/debug/review). advanceOnComplete=false
  // (item 5) stops in-phase on approve/max-passes; =true (item 7) finalizes and
  // transitions to the next phase. deferredAdvance carries the next-phase inputs
  // the plain-continue path would have collected, captured up front because the
  // headless pp_phase_complete branch cannot prompt.
  manualAutoReview?: {
    phase: string;
    preset: string;
    maxPasses: number;
    advanceOnComplete: boolean;
    deferredAdvance?: { mode?: TaskMode; autonomousConfig?: AutonomousConfig; plannerPreset?: string };
  };
  plannerFailureAutoRetried?: boolean;
  reviewerFailureAutoRetried?: boolean;
  // Set once afterImplement has run for the current implement phase (either at
  // the guided/autonomous transition or the autonomous terminal handoff), so the
  // hooks never run twice for the same completion.
  afterImplementRan?: boolean;
  // Per-repo interleaved Plannotator review cursor (#3a). repoPaths is the ordered
  // set of repos to review; index is the next repo. Persisted so the loop resumes
  // on the next /pp after the agent fixes one repo's feedback. Undefined = no loop.
  plannotatorCursor?: { repoPaths: string[]; index: number };
  // The phase the task was in when it was marked done. Recorded so the Resume
  // "reopen a done task" flow (#2) can restore the actual last working phase
  // (done itself carries no phase history). Absent on legacy done tasks.
  completedFrom?: Phase;
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

export function getFirstPhase(type: TaskType): Exclude<Phase, "done"> {
  if (type === "implement" || type === "brainstorm") return "brainstorm";
  if (type === "debug") return "debug";
  if (type === "review") return "review";
  return "quick";
}

export function getEffectiveMode(state: TaskState): TaskMode | undefined {
  return state.effectiveMode ?? state.mode;
}

// The research first phases (brainstorm/debug/review) are always interactive: the user
// drives them, so they never inherit the task's autonomous mode even when one is set.
// plan/implement are autonomous-capable regardless of whether they are the task's initial phase.
export function getEffectivePhaseMode(state: TaskState): TaskMode {
  if (state.phase === "brainstorm" || state.phase === "debug" || state.phase === "review") return "guided";
  return getEffectiveMode(state) ?? "guided";
}

// Display-only: reflects the task's chosen mode regardless of per-phase interactivity.
// Returns undefined for quick tasks so the footer omits the mode segment entirely.
export function formatModeIndicator(state: TaskState, type: TaskType): TaskMode | undefined {
  if (type === "quick") return undefined;
  return getEffectiveMode(state) === "autonomous" ? "autonomous" : "guided";
}

export function createTask(cwd: string, type: TaskType, description: string, mode?: TaskMode): string {
  const log = getLogger();
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
    phase: getFirstPhase(type),
    initialPhase: getFirstPhase(type),
    step: "llm_work",
    reviewCycle: null,
    reviewPass: 0,
    repos: [{ path: normalizeRepoPath(cwd), isRoot: true }],
    from: null,
    description,
    startedAt: new Date().toISOString(),
    mode,
    plannerFailureAutoRetried: false,
    reviewerFailureAutoRetried: false,
  };

  writeFileSync(taskStatePath(taskDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
  log.info({ s: "task", taskDir, type, description, phase: state.phase }, "task created");
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
    if (!state.initialPhase) {
      state.initialPhase = state.phase;
    }
    if (state.plannerFailureAutoRetried === undefined) {
      state.plannerFailureAutoRetried = false;
    }
    if (state.reviewerFailureAutoRetried === undefined) {
      state.reviewerFailureAutoRetried = false;
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
  getLogger().debug({ s: "task", taskDir, phase: state.phase, step: state.step }, "saving task state");
  writeFileSync(taskStatePath(taskDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export interface ListTasksOptions {
  type?: TaskType;
  includeDone?: boolean;
}

export function listTasks(cwd: string, typeOrOptions?: TaskType | ListTasksOptions): TaskInfo[] {
  const options: ListTasksOptions =
    typeof typeOrOptions === "string" ? { type: typeOrOptions } : typeOrOptions ?? {};
  const base = stateDir(cwd);
  if (!existsSync(base)) return [];

  const types: TaskType[] = options.type ? [options.type] : ["implement", "debug", "brainstorm", "review", "quick"];
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
        if (state.phase !== "done" || options.includeDone) {
          results.push({ dir, state, type: t });
        }
      } catch {
        getLogger().warn({ s: "state", dir }, "skipping corrupt task");
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
    stale: timeouts.taskLockStale,
    update: timeouts.taskLockRefresh,
    retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
    onCompromised: (err: Error) => {
      getLogger().error({ s: "state", path: sp, err: err.message }, "lock compromised");
    },
  });
  return release;
}

export function getUnlockedTasks(cwd: string, lockStale?: number): TaskInfo[] {
  const tasks = listTasks(cwd);
  if (tasks.length === 0) return [];

  const stale = lockStale ?? 600000;
  const unlocked: TaskInfo[] = [];
  for (const task of tasks) {
    try {
      const checkFs = getLockfileFs();
      if (!lockfile.checkSync(taskStatePath(task.dir), { ...(checkFs && { fs: checkFs }), stale })) {
        unlocked.push(task);
      }
    } catch {
      getLogger().warn({ s: "state", dir: task.dir }, "failed to check lock");
    }
  }
  return unlocked;
}

export type ActiveTaskStatus =
  | { kind: "none" }
  | { kind: "single"; task: TaskInfo }
  | { kind: "ambiguous"; tasks: TaskInfo[] };

export function getActiveTaskStatus(cwd: string, lockStale?: number): ActiveTaskStatus {
  const unlocked = getUnlockedTasks(cwd, lockStale);
  if (unlocked.length === 0) return { kind: "none" };
  if (unlocked.length === 1) return { kind: "single", task: unlocked[0]! };
  return { kind: "ambiguous", tasks: unlocked };
}

export function getActiveTask(cwd: string, lockStale?: number): TaskInfo | null {
  const status = getActiveTaskStatus(cwd, lockStale);
  return status.kind === "single" ? status.task : null;
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
    return taskNameFromState(taskDir, loadTask(taskDir));
  } catch {
    getLogger().warn({ s: "state", taskDir }, "failed to read task name");
    return dirSlugName(taskDir);
  }
}

// Non-heading, non-empty content of a markdown file, collapsed onto one line
// (multiple content lines joined with a space), or null. Spanning multiple
// lines lets a multi-line request survive the later truncate-with-ellipsis
// instead of being cut off at the first content line. Bounded so a large file
// (e.g. RESEARCH.md) never builds an unbounded string.
function firstMarkdownContent(path: string): string | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return null;
  return lines.join(" ").slice(0, 700);
}

// The full, untrimmed task name (used for the Resume right-pane description).
// Resolves a real intent for generic-description tasks via a fallback chain:
// USER_REQUEST.md → RESEARCH.md → first artifact → dir slug.
export function taskFullName(taskDir: string, state: TaskState): string {
  let desc = state.description ?? "";

  if (["implement", "debug", "brainstorm", "review", "quick"].includes(desc)) {
    const fallback =
      firstMarkdownContent(join(taskDir, "USER_REQUEST.md")) ??
      firstMarkdownContent(join(taskDir, "RESEARCH.md")) ??
      firstArtifactTitle(taskDir);
    if (fallback) desc = fallback;
  }

  desc = desc.replace(/\s+/g, " ").trim();
  return desc || dirSlugName(taskDir);
}

function firstArtifactTitle(taskDir: string): string | null {
  const artifactsDir = join(taskDir, "artifacts");
  if (!existsSync(artifactsDir)) return null;
  const files = readdirSync(artifactsDir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(join(artifactsDir, file), "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const heading = lines.find((l) => l.startsWith("# "));
    if (heading) return heading.replace(/^#\s+/, "");
    const firstContent = lines.find((l) => !l.startsWith("#"));
    if (firstContent) return firstContent;
  }
  return null;
}

// Same as taskName but reuses an already-loaded TaskState (avoids re-reading
// state.json per resume-menu entry). Returns a TITLE trimmed to fit one line.
// The cap is conservative (fits within ~80 cols after the `→ N. ` selection
// prefix and a ` — <age>` suffix are added) so a Resume item never wraps.
export function taskNameFromState(taskDir: string, state: TaskState): string {
  const desc = taskFullName(taskDir, state);
  if (desc.length > 60) return desc.slice(0, 57) + "...";
  return desc;
}

function dirSlugName(taskDir: string): string {
  const dir = basename(taskDir);
  const idx = dir.indexOf("_");
  const slug = idx >= 0 ? dir.slice(idx + 1) : dir;
  return slug.replace(/-/g, " ");
}

// The task's short id is the leading segment of its dir name (`${id}_${slug}`),
// where id is a 12-char uuid slice from createTask. Used to disambiguate
// otherwise-identical resume-menu titles.
export function taskShortId(taskDir: string): string {
  const dir = basename(taskDir);
  const idPart = dir.split("_", 1)[0] ?? dir;
  return idPart.slice(0, 6);
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
