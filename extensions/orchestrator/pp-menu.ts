import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, basename } from "path";
import { isDeepStrictEqual } from "util";
import { askUser, isCancel, type CancelReason } from "../../3p/pi-ask-user/index.js";
import { unregisterAgentDefinitions } from "./agents/registry.js";
import {
  type AfterEditCommandConfig,
  type AfterImplementCommandConfig,
  GLOBAL_CONFIG_PATH,
  getDefaultConfig,
  loadConfig,
  mergeConfigLayers,
  parseDuration,
  readRawConfig,
  removeConfigValue,
  resolvePreset,
  reviewPresetGroupForPhase,
  writeConfigValue,
  type PiPiConfig,
  type PresetGroup,
  type OrchestratorRole,
  type VariantConfig,
} from "./config.js";
import {
  loadPhaseReviewOutputs,
  hasFinalPassAnchors,
} from "./context.js";
import { detectDefaultBranch, enterReviewCycle, finalizeReviewCycle, isReviewCycleLive, registerFeatureToolsAndAgents } from "./event-handlers.js";
import { Orchestrator } from "./orchestrator.js";
import { cancelPendingPlannotatorWait, openPlannotator, openAnnotateReview, waitForPlannotatorResult } from "./plannotator.js";
import { advanceBanner } from "./messages.js";
import { findUnresolvedOpenQuestions } from "./validate-artifacts.js";
import { spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { spawnBrainstormReviewers } from "./phases/brainstorm.js";
import { nextPhase } from "./phases/machine.js";
import { getAllAliases, getModelFamilies, getModelInfo, resolveModel, updateRegistryFromAvailableModels } from "./model-registry.js";
import { compareModelVersion } from "./model-version.js";

import {
  listTasks,
  getActiveTaskStatus,
  getEffectiveMode,
  getEffectivePhaseMode,
  loadTask,
  lockTask,
  saveTask,
  taskAge,
  taskName,
  taskNameFromState,
  taskFullName,
  taskShortId,
  type AutonomousConfig,
  type TaskMode,
  type TaskInfo,
  type TaskType,
  type TaskState,
  type Phase,
} from "./state.js";
import {
  clearFlantGeneratedConfig,
  getFlantGeneratedConfig,
  loadFlantSettings,
  readClaudeOAuthToken,
  readGatewayApiKey,
  saveFlantSettings,
  unregisterFlantProviders,
  updateFlantInfra,
  type FlantSettings,
} from "./flant-infra.js";
import { runDoctor } from "./doctor.js";
import { normalizeRepoPath, type RepoInfo } from "./repo-utils.js";
import { getLogger, addTaskDestination, setLogLevel } from "./log.js";
import { handleSpawnResult } from "./spawn-cleanup.js";

type MenuMode = "command" | "tool";

const BACK = "back" as const;

// Sentinel returned by showActiveTaskMenu when the user dismissed the top-level
// menu with a deliberate ESC (cancelReason "user"), as opposed to selecting the
// "Back" option or a programmatic dismissal. Callers (pp_phase_complete) use it
// to stop the turn cleanly instead of returning reminder text that starts a new
// LLM turn. It is intentionally distinct from the empty-string "Back" return.
export const USER_CANCELLED = "\u0000user-cancelled" as const;

type OptionInput = string | { title: string; description?: string };

type TimeoutKey =
  | "performance.commands.afterEdit"
  | "performance.commands.afterImplement"
  | "performance.internals.subagentStale"
  | "performance.internals.mainTurnStale"
  | "performance.internals.taskLockStale"
  | "performance.internals.taskLockRefresh";

function isEnabled(value: { enabled?: boolean } | undefined): boolean {
  return value?.enabled !== false;
}

async function selectOption(ctx: any, question: string, options: OptionInput[]): Promise<string | undefined> {
  return (await selectOptionCancelable(ctx, question, options)).choice;
}

// Like selectOption but also surfaces the cancel reason so callers can tell a
// deliberate user ESC (reason "user") apart from a normal non-selection. Used by
// showActiveTaskMenu so pp_phase_complete can stop the turn cleanly on ESC
// (mirroring ask_user) while keeping the "Back" navigation reminder.
async function selectOptionCancelable(
  ctx: any,
  question: string,
  options: OptionInput[],
): Promise<{ choice?: string; cancelReason?: CancelReason }> {
  const orchestrator = Orchestrator.current;
  if (orchestrator) orchestrator.interactivePromptOpen = true;
  try {
    const result = await askUser(ctx, {
      question,
      options,
      allowFreeform: false,
      allowComment: false,
      allowMultiple: false,
    });
    if (result && isCancel(result)) return { cancelReason: result.reason };
    if (!result || result.kind !== "selection") return {};
    return { choice: result.selections[0] };
  } finally {
    if (orchestrator) orchestrator.interactivePromptOpen = false;
  }
}

function opt(title: string, description: string): OptionInput {
  return { title, description };
}

function getRegisteredRepos(orchestrator: Orchestrator): RepoInfo[] {
  const repos = orchestrator.active?.state.repos ?? [];
  if (repos.length > 0) return repos;
  return [{ path: normalizeRepoPath(orchestrator.cwd), isRoot: true }];
}

function validateRepos(repos: RepoInfo[]): RepoInfo[] {
  return repos.filter((repo) => {
    try {
      if (!existsSync(repo.path)) return false;
      return existsSync(join(repo.path, ".git"));
    } catch {
      return false;
    }
  });
}

function formatRepoLabel(repo: RepoInfo): string {
  return `${repo.path}${repo.isRoot ? " (root)" : ""}`;
}

function formatRepoList(repos: RepoInfo[]): string {
  return repos
    .map((repo) => {
      const base = repo.baseBranch ? `, base: ${repo.baseBranch}` : "";
      return `- ${formatRepoLabel(repo)}${base}`;
    })
    .join("\n");
}



async function pickCommitForRepo(orchestrator: Orchestrator, ctx: any, repo: RepoInfo): Promise<string | null> {
  let commits: Array<{ hash: string; message: string; age: string }> = [];
  try {
    const logResult = await orchestrator.pi.exec(
      "git", ["log", "--oneline", "--format=%h\t%s\t%cr", "-30"],
      { cwd: repo.path, timeout: 5000 },
    );
    if (logResult.code === 0 && logResult.stdout.trim()) {
      commits = logResult.stdout.trim().split("\n").map((line) => {
        const [hash, message, age] = line.split("\t");
        return { hash: hash || "", message: message || "", age: age || "" };
      }).filter((c) => c.hash);
    }
  } catch {}
  if (commits.length === 0) {
    ctx.ui.notify(`No commits found in ${repo.path}.`, "info");
    return null;
  }
  const commitOptions: OptionInput[] = commits.map((c) => ({
    title: `${c.hash} ${c.message}`,
    description: c.age,
  }));
  commitOptions.push({ title: "Back", description: "Return to the previous menu" });
  const picked = await selectOption(ctx, `Review changes since (${repo.path}):`, commitOptions);
  if (!picked || picked === "Back") return null;
  const pickedHash = picked.split(" ")[0];
  return pickedHash || null;
}

async function repoHasReviewableChanges(
  orchestrator: Orchestrator,
  repo: RepoInfo,
  base: string,
): Promise<{ changed: boolean; error?: string }> {
  const run = async (args: string[]): Promise<{ out: string; failed: boolean }> => {
    try {
      const res = await orchestrator.pi.exec("git", args, { cwd: repo.path, timeout: 5000 });
      if (res.code !== 0) return { out: "", failed: true };
      return { out: res.stdout, failed: false };
    } catch {
      return { out: "", failed: true };
    }
  };

  const committed = await run(["diff", "--name-only", `${base}...HEAD`]);
  const unstaged = await run(["diff", "--name-only"]);
  const staged = await run(["diff", "--cached", "--name-only"]);
  const status = await run(["status", "--porcelain"]);

  const hasCommitted = committed.out.trim().length > 0;
  const hasUnstaged = unstaged.out.trim().length > 0;
  const hasStaged = staged.out.trim().length > 0;
  const hasUntracked = status.out.split("\n").some((line) => line.startsWith("??"));
  const changed = hasCommitted || hasUnstaged || hasStaged || hasUntracked;

  if (changed) return { changed: true };

  // No change detected — but a failed probe (e.g. a missing/invalid base ref)
  // could be masking real changes, so surface it rather than silently hiding
  // the repo.
  if (committed.failed || unstaged.failed || staged.failed || status.failed) {
    return { changed: false, error: "git status/diff failed" };
  }

  return { changed: false };
}

interface RepoPrContext {
  repoPath: string;
  prUrl: string | null;
  prContext: string | null;
}

function setStep(orchestrator: Orchestrator, step: string): void {
  if (!orchestrator.active) return;
  orchestrator.active.state.step = step;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
}

// Publish the latest synthesized review findings to a target. The agent (not the
// extension) performs the writes: file comments = insert `AI_COMMENT:` markers at
// each finding's line; PR comments = run `gh` to post line-anchored comments from
// the user's own account. Both are idempotent — the agent checks for markers/
// comments it already published and skips duplicates, so re-publishing is safe.
const PRIVACY_INSTRUCTION =
  "PRIVACY: comment bodies MUST be self-contained observations about the code itself. Do NOT reference " +
  "private or internal details, \"the ticket\", issue trackers, or internal design docs. Say what is wrong " +
  "in the code, not that it \"violates the design goal\" of some private document.";

export function publishFileCommentsBanner(taskDir: string): string {
  const reviewsDir = join(taskDir, "code-reviews");
  return advanceBanner(
    "[PI-PI] Publish the synthesized review findings as FILE COMMENTS now.\n\n" +
    `Use the \`ANCHORS:\` block in the latest \`${reviewsDir}/*_final_pass-*.md\` as the file:line source — do NOT invent locations.\n\n` +
    "For each accepted finding, insert an `AI_COMMENT:` marker (inside each file's native comment syntax, e.g. `// AI_COMMENT: ...`, `# AI_COMMENT: ...`, `<!-- AI_COMMENT: ... -->`) on or immediately above the cited line, briefly stating the finding. " +
    "This is the ONLY source edit permitted — no fixes, no other changes.\n\n" +
    PRIVACY_INSTRUCTION + "\n\n" +
    "IDEMPOTENT: before inserting, check whether an equivalent `AI_COMMENT:` marker for that finding is already present at that location (e.g. from an earlier publish). If so, skip it — do NOT add a duplicate.\n\n" +
    "When done, report how many markers you inserted and how many you skipped as already-present, then end your turn.",
  );
}

export function publishPrCommentsBanner(taskDir: string): string {
  const reviewsDir = join(taskDir, "code-reviews");
  return advanceBanner(
    "[PI-PI] Publish the synthesized review findings as GITHUB PR COMMENTS now, from the user's own `gh`-authenticated account.\n\n" +
    `Use the \`ANCHORS:\` block in the latest \`${reviewsDir}/*_final_pass-*.md\` as the file:line source — do NOT invent locations.\n\n` +
    "For each registered repo, resolve the branch's PR with `gh pr view --json number,headRefName,headRefOid,url` (skip the repo if there is no PR or `gh auth status` fails). Derive owner/repo from the PR `url` (the base repo).\n\n" +
    "PRE-VALIDATE each anchor against the PR diff BEFORE building the review: fetch the diff (e.g. `gh pr diff <number>`) and keep, in a `comments` array, ONLY findings whose path+line are part of that diff. A single GitHub review is all-or-nothing — one invalid line comment rejects the WHOLE review — so an unvalidated anchor must NEVER go into `comments`.\n\n" +
    "Post ONE bundled review per repo via `gh api --method POST repos/<owner>/<repo>/pulls/<number>/reviews` with `commit_id=<headRefOid>`, `event=COMMENT` (neutral — never APPROVE or REQUEST_CHANGES), a summary `body`, and a `comments` array of `{path, line, side: RIGHT, body}` for the validated findings.\n\n" +
    "NON-DIFF findings (anchors not in the diff) are NEVER dropped: list them in the review `body` under a `Findings not anchorable to the diff:` heading, one per line ending with the exact ` (generated by pi-pi)` footer, using `file:—` (never an invented line). Do NOT rely on GitHub rejecting them.\n\n" +
    "The LAST line of every finding's comment body MUST be exactly:\n(generated by pi-pi)\n\n" +
    PRIVACY_INSTRUCTION + "\n\n" +
    "IDEMPOTENT (line comments): first list existing PR comments (`gh api repos/<owner>/<repo>/pulls/<number>/comments`, which also returns comments from earlier per-comment publishes) and do NOT re-post a finding whose path, line, `(generated by pi-pi)` footer, AND body text all match one already present. Two distinct findings on the same line are NOT duplicates. Skip only true duplicates.\n\n" +
    "IDEMPOTENT (body findings): also list existing reviews (`gh api repos/<owner>/<repo>/pulls/<number>/reviews`) and read their `body`. A GitHub review body cannot be deduped per-line, so before creating a new review, drop any non-diff finding whose `<file:—> — <text> (generated by pi-pi)` body line already appears in a prior pi-pi review body. If, after that, there are NO new line comments AND NO new body findings for a repo, do NOT create an empty duplicate review — report it as fully-published instead.\n\n" +
    "When done, report per repo how many comments you posted, how many you skipped as duplicates, and how many were unanchorable (in the body), then end your turn.",
  );
}

// Guard for the Publish menu: both banners consume the `ANCHORS:` block from the
// latest `code-reviews/*_final_pass-*.md`. If no such file exists, or the newest one
// carries no `ANCHORS:` block, publishing would spawn an agent that immediately fails.
// Returns a user-facing message to show instead, or undefined when publishing can proceed.
export const MISSING_FINAL_PASS_ANCHORS =
  "No ANCHORS-bearing final review file exists yet. Run or finish a review pass first " +
  "(/pp → Review) so the findings are synthesized into `code-reviews/*_final_pass-*.md`.";

export function publishGuard(taskDir: string): string | undefined {
  return hasFinalPassAnchors(taskDir) ? undefined : MISSING_FINAL_PASS_ANCHORS;
}

const AI_REVIEW_MARKER_SYNTAX =
  "(inside each file's native comment syntax, e.g. `// AI_REVIEW: ...`, `# AI_REVIEW: ...`, `<!-- AI_REVIEW: ... -->`)";

const AI_REVIEW_MARKER_LOOP =
  "For each marker: address the request, then remove that marker in the SAME edit. After a pass, re-scan the target files and " +
  "repeat until no `AI_REVIEW:` markers remain. Then verify your work and report what you changed per marker. When complete, " +
  "call pp_phase_complete.";

// Read-only phases (brainstorm/debug/review) and plan produce markdown state files rather than
// source changes, so their AI_REVIEW scan targets those artifacts. Missing targets are skipped,
// not errors. Kept as literal-token guidance (no regexp/parser), mirroring the implement banner.
function readOnlyReviewBanner(phase: string, taskDir: string): string {
  const targets =
    phase === "plan"
      ? "the synthesized plan(s) at `" + taskDir + "/plans/*_synthesized.md` ONLY (ignore raw planner outputs, " +
        "`review_*` files, and the `plan-reviews/`, `brainstorm-reviews/`, `code-reviews/` directories)"
      : "`" + taskDir + "/USER_REQUEST.md`, `" + taskDir + "/RESEARCH.md`, and `" + taskDir + "/artifacts/*.md`";
  return advanceBanner(
    `[PI-PI] The user reviewed this phase's state files in their editor and left inline \`AI_REVIEW:\` markers ` +
    `${AI_REVIEW_MARKER_SYNTAX}.\n\n` +
    `Search WITHIN ${targets} for \`AI_REVIEW:\`. Only scan those files — skip any target that does not exist ` +
    `(a missing \`artifacts/*.md\` or a not-yet-produced state file is fine, not an error).\n\n` +
    AI_REVIEW_MARKER_LOOP,
  );
}

function showStatus(orchestrator: Orchestrator, ctx: any): void {
  if (!orchestrator.active) {
    ctx.ui.notify("No active task.", "info");
    return;
  }
  const cycle = orchestrator.active.state.reviewCycle
    ? ` | ReviewCycle: ${orchestrator.active.state.reviewCycle.kind}/${orchestrator.active.state.reviewCycle.step} (pass ${orchestrator.active.state.reviewCycle.pass})`
    : "";
  ctx.ui.notify(
    `Type: ${orchestrator.active.type} | Phase: ${orchestrator.active.state.phase} | Step: ${orchestrator.active.state.step} | ReviewPass: ${orchestrator.active.state.reviewPass}${cycle} | Task: ${orchestrator.active.description} | Age: ${taskAge(orchestrator.active.state)} | Dir: ${orchestrator.active.dir}`,
    "info",
  );
}

async function abortCurrentWork(orchestrator: Orchestrator, ctx: any): Promise<void> {
  // Clear pi-pi's own delayed post-error retry (timer + ESC interrupt). Unlike
  // pause/finish, abortCurrentWork does NOT go through cleanupActive/
  // resetTaskScopedState, so without this a scheduled retry would survive the
  // abort and re-nudge seconds later.
  orchestrator.cancelPendingRetry();
  orchestrator.abortAllSubagents();
  orchestrator.transitionController.abortMainAgent(ctx.abort?.bind(ctx));
  await ctx.waitForIdle?.();
  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);
}

async function pauseTask(orchestrator: Orchestrator, ctx: any): Promise<string> {
  if (!orchestrator.active) return "No active task.";

  cancelPendingPlannotatorWait(orchestrator);
  orchestrator.abortAllSubagents();
  orchestrator.transitionController.abortMainAgent(ctx.abort?.bind(ctx));
  await ctx.waitForIdle?.();

  const name = orchestrator.active.description;
  const type = orchestrator.active.type;

  orchestrator.active.state.reviewCycle = null;
  // Drop any in-progress per-repo Plannotator cursor so a resumed task does not
  // auto-reopen Plannotator; the user re-enters Review explicitly.
  orchestrator.active.state.plannotatorCursor = undefined;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.lastCtx = ctx;
  orchestrator.updateStatus(ctx);
  // Route through the controller as a "done" target (same coordinator as every
  // other compaction). The agent was aborted above, so this compacts via the
  // already-idle path; the awaitable resolves at every terminus.
  await orchestrator.transitionController.requestTransition({
    kind: "done",
    summary: `Task "${name}" (${type}) paused.`,
  });
  ctx.ui.notify(`Task "${name}" paused. Use /pp → Resume to continue.`, "info");
  return `Task "${name}" paused.`;
}

async function finishTask(orchestrator: Orchestrator, ctx: any): Promise<string> {
  if (!orchestrator.active) return "No active task.";

  // The review phase must produce the ANCHORS-bearing final_pass file Publish
  // consumes; block the direct Complete path too (it bypasses validateExitCriteria).
  if (orchestrator.active.state.phase === "review" && !hasFinalPassAnchors(orchestrator.active.dir)) {
    ctx.ui.notify(MISSING_FINAL_PASS_ANCHORS, "warning");
    return MISSING_FINAL_PASS_ANCHORS;
  }

  cancelPendingPlannotatorWait(orchestrator);
  orchestrator.abortAllSubagents();
  orchestrator.transitionController.abortMainAgent(ctx.abort?.bind(ctx));
  await ctx.waitForIdle?.();

  const name = orchestrator.active.description;
  const type = orchestrator.active.type;
  const dir = orchestrator.active.dir;

  orchestrator.lastCtx = ctx;

  // Record the phase we finished FROM so a later Resume can reopen the task at
  // its real last working phase (done carries no phase history of its own).
  orchestrator.active.state.completedFrom = orchestrator.active.state.phase;
  orchestrator.active.state.phase = "done";
  orchestrator.active.state.step = null;
  orchestrator.active.state.reviewCycle = null;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.updateStatus(ctx);
  // Route through the controller as a "done" target (fire-and-forget: the task
  // is over, nothing awaits this compaction).
  void orchestrator.transitionController.requestTransition({
    kind: "done",
    discard: true,
    summary: `Task "${name}" (${type}) is finished — DISCARD its entire conversation. Do NOT carry forward, reference, or act on any of this task's messages, phase, plan, or aborted turns; the next task starts from a clean slate.`,
  });

  const urExists = existsSync(join(dir, "USER_REQUEST.md"));
  const resExists = existsSync(join(dir, "RESEARCH.md"));

  if ((type === "brainstorm" || type === "debug") && urExists && resExists) {
    const taskRelPath = relative(join(orchestrator.cwd, ".pp", "state"), dir);
    ctx.ui.notify(
      `Task "${name}" completed. Artifacts saved.\nUse /pp → Implement → From and choose ${taskRelPath}`,
      "info",
    );
  } else {
    ctx.ui.notify(`Task "${name}" completed.`, "info");
  }

  return `Task "${name}" completed.`;
}

function getDefaultReviewPresetName(config: PiPiConfig, phase: string): string {
  return config.agents.subagents.presetGroups[reviewPresetGroupForPhase(phase)].default;
}

function isPresetEnabled(preset: { enabled?: boolean } | undefined): boolean {
  return preset?.enabled !== false;
}

function getReviewPresetGroup(phase: string): PresetGroup {
  return reviewPresetGroupForPhase(phase);
}

export async function pickPreset(
  ctx: any,
  orchestrator: Orchestrator,
  group: PresetGroup,
  title: string,
): Promise<string | null> {
  const presets = orchestrator.config.agents.subagents.presetGroups[group].presets ?? {};
  const defaultPresetName = orchestrator.config.agents.subagents.presetGroups[group].default;

  const options: OptionInput[] = [];
  const byTitle = new Map<string, string>();

  for (const [presetName, preset] of Object.entries(presets)) {
    if (!isPresetEnabled(preset)) continue;
    const enabledModels = Object.values(preset.agents)
      .filter((variant) => isEnabled(variant))
      .map((variant) => {
        const info = getModelInfo(variant.model);
        return `${info.vendor}/${info.family} (${variant.thinking})`;
      });
    const description = enabledModels.length > 0 ? enabledModels.join(", ") : "No enabled models";
    const optionTitle = presetName === defaultPresetName ? `${presetName} [default]` : presetName;
    byTitle.set(optionTitle, presetName);
    options.push({ title: optionTitle, description });
  }

  options.push({ title: "Back", description: "Return to the previous menu" });

  const choice = await selectOption(ctx, title, options);
  if (!choice || choice === "Back") return null;
  return byTitle.get(choice) ?? null;
}

// The phase to restore when reopening a done task (#2). Prefer the recorded
// completedFrom; for legacy done tasks that lack it, fall back to the phase whose
// transition target is "done" (approximate — assumes the task ran to its terminal
// phase, which is wrong only for tasks completed early).
function reopenPhaseForDoneTask(type: TaskType, state: TaskState): Phase {
  if (state.completedFrom) return state.completedFrom;
  for (const phase of ["implement", "plan", "review", "debug", "brainstorm", "quick"] as Phase[]) {
    if (nextPhase(type, phase) === "done") return phase;
  }
  return "implement" as Phase;
}

export async function resumeTask(
  orchestrator: Orchestrator,
  ctx: any,
  task: TaskInfo,
): Promise<{ ok: boolean; error?: string }> {
  const pi = orchestrator.pi;

  try {
    orchestrator.config = loadConfig(orchestrator.cwd);
  } catch (err: any) {
    const message = `Config error: ${err.message}`;
    ctx.ui.notify(message, "error");
    return { ok: false, error: message };
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockTask(task.dir, orchestrator.config.performance.internals);
  } catch {
    const staleSeconds = Math.round(orchestrator.config.performance.internals.taskLockStale / 1000);
    const message =
      `Cannot resume: task is locked by another pi session (or a session that crashed less than ${staleSeconds}s ago). ` +
      `Wait ${staleSeconds}s for the lock to expire, or kill the other session first.`;
    ctx.ui.notify(message, "error");
    return { ok: false, error: message };
  }

  orchestrator.resetTaskScopedState();
  orchestrator.activeTaskToken++;

  // Reopen a done task (#2): now that the lock is held, reload under the lock and
  // restore the phase the task was completed FROM so it re-enters at a sensible
  // working phase (done leaves step=null). Lock-first, then mutate, then save.
  if (task.state.phase === "done") {
    task.state = loadTask(task.dir);
    if (task.state.phase === "done") {
      task.state.phase = reopenPhaseForDoneTask(task.type, task.state);
      task.state.step = "llm_work";
      task.state.completedFrom = undefined;
      saveTask(task.dir, task.state);
    }
  }

  const normalizedRoot = normalizeRepoPath(orchestrator.cwd);
  if (!task.state.repos || task.state.repos.length === 0) {
    task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    saveTask(task.dir, task.state);
  }

  if (!task.state.repos.some((repo) => repo.isRoot)) {
    const rootByPath = task.state.repos.find((repo) => repo.path === normalizedRoot);
    if (rootByPath) {
      rootByPath.isRoot = true;
    } else if (task.state.repos.length > 0) {
      task.state.repos[0]!.isRoot = true;
    } else {
      task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    }
    saveTask(task.dir, task.state);
  }

  const validRepos = validateRepos(task.state.repos ?? []);
  if ((task.state.repos?.length ?? 0) !== validRepos.length) {
    const pruned = (task.state.repos?.length ?? 0) - validRepos.length;
    task.state.repos = validRepos;
    saveTask(task.dir, task.state);
    ctx.ui.notify(`Pruned ${pruned} stale repo(s) that no longer exist.`, "warning");
  }

  if (!task.state.repos || task.state.repos.length === 0) {
    task.state.repos = [{ path: normalizedRoot, isRoot: true }];
    saveTask(task.dir, task.state);
  }

  const needsRepoRegistrationPrompt = task.state.repos.some((repo) => !repo.baseBranch);

  orchestrator.active = {
    dir: task.dir,
    type: task.type,
    state: task.state,
    release,
    taskId: orchestrator.taskIdFromDir(task.dir),
    modifiedFiles: new Set(task.state.modifiedFiles ?? []),
    reviewPass: task.state.reviewPass,
    description: task.state.description,
  };

  addTaskDestination(task.dir);
  setLogLevel(orchestrator.config.general.logLevel);
  getLogger().info({ s: "task", dir: task.dir, type: task.type, phase: task.state.phase }, "task resumed");

  const modelConfig = orchestrator.config.agents.orchestrators[
    task.type === "debug" ? "debug"
    : task.type === "brainstorm" ? "brainstorm"
    : task.type === "review" ? "review"
    : "implement"
  ];
  const modelOk = await orchestrator.switchModel(ctx, modelConfig.model, modelConfig.thinking);
  if (!modelOk) {
    ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
  }

  orchestrator.registerAgents();
  pi.setSessionName(orchestrator.active.description.slice(0, 50));
  orchestrator.lastCtx = ctx;
  orchestrator.updateStatus(ctx);

  orchestrator.injectContextAndArtifacts(orchestrator.active.dir, orchestrator.active.state.phase);

  if (orchestrator.active.state.phase === "plan" && orchestrator.active.state.step === "await_planners") {
    const plansDir = join(orchestrator.active.dir, "plans");
    const requestedPlannerPresetName = orchestrator.active.state.activePlannerPreset ?? orchestrator.config.agents.subagents.presetGroups.planners.default;
    const plannerPresetExists = Object.prototype.hasOwnProperty.call(orchestrator.config.agents.subagents.presetGroups.planners.presets ?? {}, requestedPlannerPresetName);
    const plannerPresetName = plannerPresetExists
      ? requestedPlannerPresetName
      : (Object.keys(orchestrator.config.agents.subagents.presetGroups.planners.presets ?? {})[0] ?? requestedPlannerPresetName);
    if (orchestrator.active.state.activePlannerPreset !== plannerPresetName) {
      orchestrator.active.state.activePlannerPreset = plannerPresetName;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    if (!plannerPresetExists && plannerPresetName !== requestedPlannerPresetName) {
      ctx.ui.notify(
        `Planner preset "${requestedPlannerPresetName}" not found. Falling back to "${plannerPresetName}".`,
        "warning",
      );
    }
    const plannerVariants = resolvePreset(orchestrator.config, "planners", plannerPresetName);
    const enabledVariants = Object.entries(plannerVariants).filter(([, v]) => isEnabled(v));
    const planFiles = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
      : [];
    const completedVariants = new Set(planFiles.map((f) => f.replace(/^\d+_/, "").replace(/\.md$/, "")));
    const hasAllEnabledVariants = enabledVariants.every(([name]) => completedVariants.has(name));
    if (hasAllEnabledVariants) {
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    } else {
      const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));
      if (missingVariants.length > 0) {
        const missingConfig: typeof plannerVariants = {};
        for (const [name, cfg] of missingVariants) missingConfig[name] = cfg;
        orchestrator.pendingSubagentSpawns = missingVariants.length;
        orchestrator.failedPlannerVariants = [];
        const plannerSpawn = spawnPlanners(
          pi,
          orchestrator.cwd,
          orchestrator.active.dir,
          orchestrator.active.taskId,
          orchestrator.config,
          orchestrator.transitionController.phaseSend,
          missingConfig,
          orchestrator.active?.state.repos ?? [],
        );
        handleSpawnResult(orchestrator, plannerSpawn, {
          kind: "planner",
          logScope: "planner",
          logMessage: "spawnPlanners failed",
        });
      } else {
        orchestrator.active.state.step = "synthesize";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
    }
  }

  if (orchestrator.active.state.reviewCycle) {
    const cycle = orchestrator.active.state.reviewCycle;
    const phase = orchestrator.active.state.phase;
    const requestedReviewPresetName = orchestrator.active.state.activeReviewPreset
      ?? getDefaultReviewPresetName(orchestrator.config, phase);
    const group = getReviewPresetGroup(phase);
    const reviewPresetExists = Object.prototype.hasOwnProperty.call(orchestrator.config.agents.subagents.presetGroups[group].presets ?? {}, requestedReviewPresetName);
    const presetName = reviewPresetExists
      ? requestedReviewPresetName
      : (Object.keys(orchestrator.config.agents.subagents.presetGroups[group].presets ?? {})[0] ?? requestedReviewPresetName);
    if (orchestrator.active.state.activeReviewPreset !== presetName) {
      orchestrator.active.state.activeReviewPreset = presetName;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    if (!reviewPresetExists && presetName !== requestedReviewPresetName) {
      ctx.ui.notify(
        `Review preset "${requestedReviewPresetName}" not found. Falling back to "${presetName}".`,
        "warning",
      );
    }
    const reviewers = resolvePreset(orchestrator.config, group, presetName);
    const reviewerCount = Object.values(reviewers).filter((v) => isEnabled(v)).length;

    if (cycle.kind === "auto" && (cycle.step === "spawn_reviewers" || cycle.step === "await_reviewers")) {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      if (reviewerCount === 0) {
        orchestrator.active.state.reviewCycle = null;
        orchestrator.active.state.step = "llm_work";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        orchestrator.safeSendUserMessage("[PI-PI] No reviewers configured — nothing to review. Continue working.");
      } else if (outputs.length >= reviewerCount) {
        cycle.step = "apply_feedback";
        orchestrator.active.state.step = "apply_feedback";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
        orchestrator.transitionController.sendCustom(
          {
            customType: "pp-review-ready",
            content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
            display: false,
          },
          "context",
        );
      } else {
        const completedVariants = new Set(
          outputs.map((o) => o.name.replace(/^\d+_/, "").replace(/_round-\d+\.md$/, "").replace(/\.md$/, "")),
        );
        const enabledVariants = Object.entries(reviewers).filter(([, v]) => isEnabled(v));
        const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));

        if (missingVariants.length === 0) {
          cycle.step = "apply_feedback";
          orchestrator.active.state.step = "apply_feedback";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
          orchestrator.transitionController.sendCustom(
            {
              customType: "pp-review-ready",
              content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
              display: false,
            },
            "context",
          );
        } else {
          const missingReviewerConfig: typeof reviewers = {};
          for (const [name, cfg] of missingVariants) missingReviewerConfig[name] = cfg;
          orchestrator.active.state.activeReviewPreset = presetName;
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          orchestrator.pendingSubagentSpawns = missingVariants.length;
          const spawnFn = reviewPresetGroupForPhase(phase) === "brainstormReviewers"
            ? () => spawnBrainstormReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              orchestrator.transitionController.phaseSend,
              missingReviewerConfig,
              orchestrator.active?.state.repos ?? [],
            )
            : reviewPresetGroupForPhase(phase) === "planReviewers"
            ? () => spawnPlanReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              orchestrator.transitionController.phaseSend,
              missingReviewerConfig,
              orchestrator.active?.state.repos ?? [],
            )
            : () => spawnCodeReviewers(
              pi,
              orchestrator.cwd,
              orchestrator.active!.dir,
              orchestrator.active!.taskId,
              orchestrator.config,
              cycle.pass,
              phase,
              orchestrator.transitionController.phaseSend,
              missingReviewerConfig,
              orchestrator.active?.state.repos ?? [],
            );
          orchestrator.failedReviewerVariants = [];
          handleSpawnResult(orchestrator, spawnFn(), {
            kind: "reviewer",
            logScope: "review",
            logMessage: "spawn reviewers failed",
            onSettled: (result) => {
              if (result?.spawned === 0 && orchestrator.active?.state.reviewCycle?.step === "await_reviewers") {
                orchestrator.active.state.reviewCycle = null;
                orchestrator.active.state.step = "llm_work";
                saveTask(orchestrator.active.dir, orchestrator.active.state);
                orchestrator.safeSendUserMessage("[PI-PI] No reviewer outputs were produced — nothing to review. Continue working.");
              }
            },
          });
          cycle.step = "await_reviewers";
          orchestrator.active.state.step = "await_reviewers";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
        }
      }
    } else if (cycle.step === "apply_feedback") {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
      orchestrator.transitionController.sendCustom(
        {
          customType: "pp-review-ready",
          content: `[PI-PI] Review cycle is in apply_feedback step.\n\n${rendered}`,
          display: false,
        },
        "context",
      );
    }
  }

  const step = orchestrator.active.state.step;
  if (step === "await_planners" || step === "await_reviewers") {
    ctx.ui.notify(`Resumed task. Awaiting subagents (${step}).`, "info");
  } else if (step === "apply_feedback") {
    orchestrator.safeSendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Read reviewer outputs and apply feedback.`);
  } else {
    orchestrator.safeSendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Continue working.`);
  }

  if (needsRepoRegistrationPrompt) {
    orchestrator.safeSendUserMessage(
      "[PI-PI] Register your repos using pp_register_repo (including the root) before continuing.",
    );
  }

  return { ok: true };
}

function listCompletedFromTasks(cwd: string): TaskInfo[] {
  const paused = new Set<string>([
    ...listTasks(cwd, "brainstorm").map((t) => t.dir),
    ...listTasks(cwd, "debug").map((t) => t.dir),
    ...listTasks(cwd, "review").map((t) => t.dir),
  ]);
  const results: TaskInfo[] = [];

  for (const type of ["brainstorm", "debug", "review"] as TaskType[]) {
    const typeDir = join(cwd, ".pp", "state", type);
    if (!existsSync(typeDir)) continue;
    for (const entry of readdirSync(typeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(typeDir, entry.name);
      if (paused.has(dir)) continue;
      try {
        const state = loadTask(dir);
        if (state.phase !== "done") continue;
        if (!existsSync(join(dir, "USER_REQUEST.md")) || !existsSync(join(dir, "RESEARCH.md"))) continue;
        results.push({ dir, state, type });
      } catch {
        continue;
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

async function showSubagentsMenu(ctx: any): Promise<void> {
  const api = (globalThis as any)[Symbol.for("pi-subagents:menu")] as {
    showFleet?: (menuCtx: any) => Promise<void>;
  } | undefined;
  // showFleet opens the navigable running-agents list (the FleetView replacement).
  if (!api?.showFleet) {
    ctx.ui.notify("Subagents menu API is not available.", "warning");
    return;
  }
  await api.showFleet(ctx);
}

function countFlantProviders(settings: FlantSettings): { anthropic: number; openai: number } {
  const models = settings.cachedFlantModels ?? [];
  const anthropic = models.filter((m) => m.startsWith("claude-")).length;
  return { anthropic, openai: Math.max(0, models.length - anthropic) };
}

function collectRoleAssignments(config: Partial<PiPiConfig> | null): string[] {
  if (!config) return [];
  const out: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (typeof value === "string" && value.length > 0) out.push(`${key} = ${value}`);
  };

  add("agents.orchestrators.implement", config.agents?.orchestrators?.implement?.model);
  add("agents.orchestrators.plan", config.agents?.orchestrators?.plan?.model);
  add("agents.orchestrators.debug", config.agents?.orchestrators?.debug?.model);
  add("agents.orchestrators.brainstorm", config.agents?.orchestrators?.brainstorm?.model);
  add("agents.orchestrators.review", config.agents?.orchestrators?.review?.model);

  const addPresetAssignments = (group: "planners" | "planReviewers" | "codeReviewers" | "brainstormReviewers") => {
    const presets = config.agents?.subagents?.presetGroups?.[group]?.presets;
    if (!presets || typeof presets !== "object") return;
    for (const [presetName, preset] of Object.entries(presets)) {
      if (!preset || typeof preset !== "object") continue;
      const agents = (preset as any).agents;
      if (!agents || typeof agents !== "object") continue;
      if ((preset as any).enabled === false) continue;
      for (const [name, variant] of Object.entries(agents as Record<string, any>)) {
        if (variant?.enabled !== false) {
          add(`agents.subagents.presetGroups.${group}.presets.${presetName}.agents.${name}`, variant.model);
        }
      }
    }
  };

  addPresetAssignments("planners");
  addPresetAssignments("planReviewers");
  addPresetAssignments("codeReviewers");
  addPresetAssignments("brainstormReviewers");

  add("agents.subagents.simple.explore", config.agents?.subagents?.simple?.explore?.model);
  add("agents.subagents.simple.librarian", config.agents?.subagents?.simple?.librarian?.model);
  add("agents.subagents.simple.task", config.agents?.subagents?.simple?.task?.model);
  add("agents.subagents.simple.advisor", config.agents?.subagents?.simple?.advisor?.model);
  add("agents.subagents.simple.advisor2", config.agents?.subagents?.simple?.advisor2?.model);
  add("agents.subagents.simple.advisor3", config.agents?.subagents?.simple?.advisor3?.model);
  add("agents.subagents.simple.deep-debugger", config.agents?.subagents?.simple?.["deep-debugger"]?.model);
  add("agents.subagents.simple.reviewer", config.agents?.subagents?.simple?.reviewer?.model);
  return out;
}

function flantStatusText(settings: FlantSettings): string {
  const providers = countFlantProviders(settings);
  const assignments = collectRoleAssignments(getFlantGeneratedConfig());
  const lines = [
    `Enabled: ${settings.enabled ? "yes" : "no"}`,
    `Auto-update: ${settings.autoUpdate ? "yes" : "no"}`,
    `Last updated: ${settings.lastUpdated ?? "never"}`,
    `Providers: pp-flant-anthropic (${providers.anthropic} models), pp-flant-openai (${providers.openai} models)`,
  ];
  if (settings.subscription) {
    const hasOAuth = !!readClaudeOAuthToken();
    const hasGatewayKey = !!readGatewayApiKey();
    const subActive = hasOAuth && hasGatewayKey;
    lines.push(
      `Personal subscription: on (${subActive ? `active — pp-flant-anthropic-sub, ${providers.anthropic} models` : "inactive"})`,
    );
    lines.push(`Rate-limit switch-back check: every ${settings.switchBackIntervalMinutes} min`);
    if (!subActive) {
      if (!hasOAuth) lines.push("  - missing Claude OAuth token (run pi /login for Anthropic)");
      if (!hasGatewayKey) lines.push("  - missing gateway key (set LLM_API_KEY or FLANT_API_KEY)");
    }
  } else {
    lines.push("Personal subscription: off");
  }
  if (assignments.length === 0) {
    lines.push("Role assignments: none");
  } else {
    lines.push("Role assignments:");
    for (const assignment of assignments) {
      lines.push(`- ${assignment}`);
    }
  }
  return lines.join("\n");
}

function describeUpdateResult(result: { ok: boolean; error?: string; models?: string[] }): { text: string; kind: "info" | "warning" | "error" } {
  if (!result.ok) {
    return { text: `Flant update failed: ${result.error ?? "unknown error"}`, kind: "error" };
  }
  const models = result.models ?? [];
  const anthropic = models.filter((m) => m.startsWith("claude-")).length;
  const openai = Math.max(0, models.length - anthropic);
  return {
    text: `Flant update completed: ${models.length} models (pp-flant-anthropic: ${anthropic}, pp-flant-openai: ${openai}).`,
    kind: "info",
  };
}

async function showFlantInfraMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const settings = loadFlantSettings();
    const enableLabel = `Enable: ${settings.enabled ? "ON" : "OFF"}`;
    const options: OptionInput[] = [
      { title: enableLabel, description: "Turn the Flant AI model providers on or off" },
    ];
    const subscriptionLabel = `Personal Claude subscription: ${settings.subscription ? "ON" : "OFF"}`;
    if (settings.enabled) {
      options.push(
        { title: subscriptionLabel, description: "Route Claude roles through your personal Claude subscription instead of the gateway" },
        { title: `Auto-update on startup: ${settings.autoUpdate ? "ON" : "OFF"}`, description: "Refresh the available model list automatically each time pi starts" },
        { title: `Cache period: ${settings.cacheTTLDays} ${settings.cacheTTLDays === 1 ? "day" : "days"}`, description: "How long the fetched model list is reused before it is refreshed" },
      );
      if (settings.subscription) {
        options.push({ title: `Rate-limit switch-back check: every ${settings.switchBackIntervalMinutes} min`, description: "How often to retry your subscription after it was rate-limited and traffic fell back to the gateway" });
      }
      options.push(
        { title: "Update now", description: "Fetch the latest model list from Flant right away" },
        { title: "Current status", description: "Show the current Flant configuration, providers, and model counts" },
      );
    }
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Flant AI Infrastructure", options);
    if (!choice || choice === "Back") return BACK;

    if (choice === enableLabel) {
      if (settings.enabled) {
        const next = { ...settings, enabled: false };
        saveFlantSettings(next);
        unregisterFlantProviders(orchestrator.pi);
        clearFlantGeneratedConfig();
        ctx.ui.notify("Flant AI Infrastructure disabled.", "info");
      } else {
        if (!process.env.FLANT_API_KEY) {
          ctx.ui.notify("Set FLANT_API_KEY environment variable first.", "warning");
          continue;
        }
        const next = { ...settings, enabled: true };
        saveFlantSettings(next);
        const result = await updateFlantInfra(orchestrator.pi);
        const message = describeUpdateResult(result);
        ctx.ui.notify(message.text, message.kind);
      }
      continue;
    }

    if (choice.startsWith("Auto-update on startup:")) {
      saveFlantSettings({ ...settings, autoUpdate: !settings.autoUpdate });
      ctx.ui.notify(`Auto-update on startup: ${!settings.autoUpdate ? "ON" : "OFF"}`, "info");
      continue;
    }

    if (choice === subscriptionLabel) {
      const turningOn = !settings.subscription;
      if (turningOn) {
        if (!readClaudeOAuthToken()) {
          ctx.ui.notify("No Claude OAuth token found. Log in to your personal Claude subscription in pi first (/login → Anthropic), then retry.", "warning");
          continue;
        }
        if (!readGatewayApiKey()) {
          ctx.ui.notify("Set LLM_API_KEY (or FLANT_API_KEY) for the gateway first.", "warning");
          continue;
        }
      }
      const next = { ...settings, subscription: turningOn };
      saveFlantSettings(next);
      const result = await updateFlantInfra(orchestrator.pi);
      if (!result.ok) {
        ctx.ui.notify(`Personal subscription ${turningOn ? "enable" : "disable"} failed: ${result.error ?? "unknown error"}`, "error");
      } else {
        ctx.ui.notify(
          turningOn
            ? "Personal Claude subscription ON — Claude roles now route through sub/claude-* (billed to your subscription); non-Claude roles stay on llm-api.flant.ru."
            : "Personal Claude subscription OFF — Claude roles reverted to pp-flant-anthropic.",
          "info",
        );
      }
      continue;
    }

    if (choice.startsWith("Rate-limit switch-back check:")) {
      const selected = await selectOption(ctx, "Switch-back check interval", [
        { title: "15 min", description: "Probe the subscription limit every 15 minutes" },
        { title: "30 min", description: "Default — probe every 30 minutes" },
        { title: "60 min", description: "Probe hourly" },
        { title: "120 min", description: "Probe every two hours" },
        { title: "Back", description: "Return to the previous menu" },
      ]);
      if (!selected || selected === "Back") continue;
      const mins = Number(selected.split(" ")[0]);
      if (!Number.isFinite(mins) || mins <= 0) continue;
      saveFlantSettings({ ...settings, switchBackIntervalMinutes: mins });
      ctx.ui.notify(`Switch-back check interval set to ${mins} min.`, "info");
      continue;
    }

    if (choice.startsWith("Cache period:")) {
      const selected = await selectOption(ctx, "Cache period", [
        { title: "1 day", description: "Refresh model metadata daily" },
        { title: "3 days", description: "Refresh model metadata every three days" },
        { title: "7 days", description: "Default — refresh weekly" },
        { title: "14 days", description: "Refresh model metadata every two weeks" },
        { title: "30 days", description: "Refresh model metadata monthly" },
        { title: "Back", description: "Return to the previous menu" },
      ]);
      if (!selected || selected === "Back") continue;
      const days = Number(selected.split(" ")[0]);
      if (!Number.isFinite(days) || days <= 0) continue;
      saveFlantSettings({ ...settings, cacheTTLDays: days });
      ctx.ui.notify(`Cache period set to ${days} ${days === 1 ? "day" : "days"}.`, "info");
      continue;
    }

    if (choice === "Update now") {
      const result = await updateFlantInfra(orchestrator.pi);
      const message = describeUpdateResult(result);
      ctx.ui.notify(message.text, message.kind);
      continue;
    }

    ctx.ui.notify(flantStatusText(settings), "info");
  }
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatElapsedDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function showUsage(ctx: any): void {
  const tracker = (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] as
    | {
        getTotalInputTokens(): number; getTotalOutputTokens(): number;
        getTotalCacheReadTokens(): number; getTotalCacheWriteTokens(): number;
        getTotalProcessedInputTokens(): number;
        getTotalCost(): number; getCacheHitRate(): number;
        getMainInputTokens(): number; getMainOutputTokens(): number;
        getMainCacheReadTokens(): number; getMainCacheWriteTokens(): number;
        getMainCost(): number;
        getPerModelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; turns: number; subscription: boolean }>;
        getSubagentList(): Array<{ description: string; agentType: string; modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number; subscription: boolean }>;
      }
    | undefined;

  if (!tracker) {
    ctx.ui.notify("No usage data available.", "info");
    return;
  }

  // Token-weighted cache hit rate: cache reads over all processed input
  // (uncached + cache read + cache write). Same formula everywhere so the
  // total, per-model, and per-agent percentages are directly comparable.
  const hitRate = (uncached: number, cacheRead: number, cacheWrite: number): number => {
    const processed = uncached + cacheRead + cacheWrite;
    return processed > 0 ? cacheRead / processed : 0;
  };

  // Compact one-line input part: total processed input with an inline
  // uncached / cache read / cache write breakdown, e.g. "↑1.3k (u84 r1.0k w200)".
  const inputPart = (uncached: number, cacheRead: number, cacheWrite: number, cacheSupported: boolean): string => {
    const processed = uncached + cacheRead + cacheWrite;
    const head = `↑${formatTokenCount(processed)}`;
    if (!cacheSupported) return head;
    return `${head} (u${formatTokenCount(uncached)} r${formatTokenCount(cacheRead)} w${formatTokenCount(cacheWrite)})`;
  };

  const totalUncachedInput = tracker.getTotalInputTokens();
  const totalOutput = tracker.getTotalOutputTokens();
  const totalCacheRead = tracker.getTotalCacheReadTokens();
  const totalCacheWrite = tracker.getTotalCacheWriteTokens();
  const totalProcessedInput = tracker.getTotalProcessedInputTokens();
  const totalCost = tracker.getTotalCost();
  const totalCacheRate = tracker.getCacheHitRate();

  const mainInput = tracker.getMainInputTokens();
  const mainOutput = tracker.getMainOutputTokens();
  const mainCacheRead = tracker.getMainCacheReadTokens();
  const mainCacheWrite = tracker.getMainCacheWriteTokens();
  const mainCost = tracker.getMainCost();
  const models = tracker.getPerModelUsage();
  const subagents = tracker.getSubagentList();

  const byModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cacheSupported: boolean; cost: number; subscription: boolean }>();
  const mainModelEntries = Object.entries(models);
  // Subscription (flat-rate) models contribute no dollars, so exclude their
  // tokens from the proportional-share denominator or paid rows would be
  // inflated and the sub/ rows would receive a spurious share.
  const mainTotalTokens = mainModelEntries.reduce((s, [, u]) => s + (u.subscription ? 0 : u.inputTokens + u.outputTokens), 0);
  for (const [modelId, usage] of mainModelEntries) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const modelCostShare = usage.subscription || mainTotalTokens <= 0 ? 0 : mainCost * (modelTokens / mainTotalTokens);
    byModel.set(modelId, {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, cacheSupported: usage.cacheSupported, cost: modelCostShare,
      subscription: usage.subscription,
    });
  }
  for (const sa of subagents) {
    const key = sa.modelId !== "unknown" ? sa.modelId : `subagent:${sa.description}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
      if (sa.subscription) existing.subscription = true;
    } else {
      byModel.set(key, {
        input: sa.inputTokens, output: sa.outputTokens,
        cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens, cacheSupported: sa.cacheSupported, cost: sa.cost,
        subscription: sa.subscription,
      });
    }
  }

  // Total input the model processed = uncached + cache read + cache write.
  // Shown as an explicit breakdown so the (often tiny) uncached sliver no
  // longer masquerades as the whole "Input" figure.
  const lines: string[] = ["Session usage (total):"];
  lines.push(`  Input: ${formatTokenCount(totalProcessedInput)} tokens`);
  lines.push(`    • uncached:    ${formatTokenCount(totalUncachedInput)}`);
  lines.push(`    • cache read:  ${formatTokenCount(totalCacheRead)}`);
  lines.push(`    • cache write: ${formatTokenCount(totalCacheWrite)}`);
  lines.push(`  Output: ${formatTokenCount(totalOutput)} tokens`);
  if (totalCacheRead > 0) lines.push(`  Cache: ⚡${Math.round(totalCacheRate * 100)}% hit rate`);
  lines.push(`  Cost: $${totalCost.toFixed(2)}`);

  if (byModel.size > 0) {
    lines.push("");
    lines.push("By model:");
    for (const [modelId, m] of byModel) {
      const cr = Math.round(hitRate(m.input, m.cacheRead, m.cacheWrite) * 100);
      const parts = [inputPart(m.input, m.cacheRead, m.cacheWrite, m.cacheSupported), `↓${formatTokenCount(m.output)}`];
      if (m.cacheSupported) parts.push(`⚡${cr}%`);
      if (m.subscription) parts.push("subscription");
      else if (m.cost > 0) parts.push(`$${m.cost.toFixed(2)}`);
      lines.push(`  ${modelId}: ${parts.join("  ")}`);
    }
  }

  lines.push("");
  lines.push("By agent:");
  const agentModelNames = Object.keys(models);
  if (agentModelNames.length > 0) {
    const mainCacheSupported = mainModelEntries.some(([, u]) => u.cacheSupported);
    const mainAllSubscription = mainModelEntries.every(([, u]) => u.subscription);
    const mainParts = [inputPart(mainInput, mainCacheRead, mainCacheWrite, mainCacheSupported), `↓${formatTokenCount(mainOutput)}`];
    const mainCR = Math.round(hitRate(mainInput, mainCacheRead, mainCacheWrite) * 100);
    if (mainCacheSupported) mainParts.push(`⚡${mainCR}%`);
    if (mainAllSubscription) mainParts.push("subscription");
    else if (mainCost > 0) mainParts.push(`$${mainCost.toFixed(2)}`);
    lines.push(`  Main (${agentModelNames.join(", ")}): ${mainParts.join("  ")}`);
  }
  const byAgentType = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number; count: number; subscriptionRuns: number }>();
  for (const sa of subagents) {
    const key = sa.agentType || sa.description;
    const existing = byAgentType.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
      existing.durationMs += sa.durationMs;
      existing.toolUses += sa.toolUses;
      existing.count += 1;
      if (sa.subscription) existing.subscriptionRuns += 1;
    } else {
      byAgentType.set(key, {
        input: sa.inputTokens, output: sa.outputTokens, cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens,
        cacheSupported: sa.cacheSupported, cost: sa.cost, durationMs: sa.durationMs, toolUses: sa.toolUses, count: 1,
        subscriptionRuns: sa.subscription ? 1 : 0,
      });
    }
  }
  for (const [agentType, agg] of byAgentType) {
    const saCR = Math.round(hitRate(agg.input, agg.cacheRead, agg.cacheWrite) * 100);
    const parts = [inputPart(agg.input, agg.cacheRead, agg.cacheWrite, agg.cacheSupported), `↓${formatTokenCount(agg.output)}`];
    if (agg.cacheSupported) parts.push(`⚡${saCR}%`);
    // All runs subscription-routed → flat-rate label; otherwise show the
    // paid-only summed cost (subscription runs already contribute $0).
    if (agg.subscriptionRuns === agg.count) parts.push("subscription");
    else if (agg.cost > 0) parts.push(`$${agg.cost.toFixed(2)}`);
    if (agg.durationMs > 0) parts.push(formatElapsedDuration(agg.durationMs));
    if (agg.toolUses > 0) parts.push(`${agg.toolUses} tools`);
    const countSuffix = agg.count > 1 ? ` (×${agg.count})` : "";
    lines.push(`  ${agentType}${countSuffix}: ${parts.join("  ")}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function showInfoMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = [];
    options.push({ title: "Usage", description: "Show session token usage and cost breakdown" });
    options.push({ title: "Doctor", description: "Run diagnostic checks" });
    if (orchestrator.active) {
      options.push({ title: "Task status", description: "Show current task phase, step, and timing" });
      options.push({ title: "Repos", description: "Registered repositories and base branches" });
    }
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Info", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Usage") {
      showUsage(ctx);
      continue;
    }
    if (choice === "Doctor") {
      await runDoctor(orchestrator, ctx);
      continue;
    }
    if (choice === "Task status") {
      showStatus(orchestrator, ctx);
      continue;
    }
    if (choice === "Repos") {
      await showReposSettings(orchestrator, ctx);
      continue;
    }
  }
}

type Scope = "global" | "project";
type MainModelRole = keyof PiPiConfig["agents"]["orchestrators"];
type AgentRole = keyof PiPiConfig["agents"]["subagents"]["simple"];
type TimeoutGroup = "commands" | "internals";
type CommandListKey = keyof PiPiConfig["commands"];
type TimeoutEntry = { key: TimeoutKey; path: string[]; value: number };

export interface ConfigSourceInfo {
  activeValue: any;
  defaultValue: any;
  flantValue: any | undefined;
  globalValue: any | undefined;
  projectValue: any | undefined;
  source: "default" | "flant" | "global" | "project";
}

const ORCHESTRATOR_ROLES: Array<{ role: MainModelRole; label: string; description: string }> = [
  { role: "brainstorm", label: "Brainstormer", description: "agents.orchestrators.brainstorm" },
  { role: "implement", label: "Implementer", description: "agents.orchestrators.implement" },
  { role: "plan", label: "Planner", description: "agents.orchestrators.plan" },
  { role: "debug", label: "Debugger", description: "agents.orchestrators.debug" },
  { role: "review", label: "Reviewer", description: "agents.orchestrators.review" },
  { role: "quick", label: "Quick", description: "agents.orchestrators.quick" },
];

const SUBAGENT_ROLES: Array<{ role: AgentRole; label: string; description: string }> = [
  { role: "explore", label: "Explore", description: "agents.subagents.simple.explore" },
  { role: "librarian", label: "Librarian", description: "agents.subagents.simple.librarian" },
  { role: "task", label: "Task", description: "agents.subagents.simple.task" },
  { role: "advisor", label: "Advisor (Opus)", description: "agents.subagents.simple.advisor" },
  { role: "advisor2", label: "Advisor 2 (GPT)", description: "agents.subagents.simple.advisor2" },
  { role: "advisor3", label: "Advisor 3 (Gemini)", description: "agents.subagents.simple.advisor3" },
  { role: "deep-debugger", label: "Deep debugger", description: "agents.subagents.simple.deep-debugger" },
  { role: "reviewer", label: "Reviewer", description: "agents.subagents.simple.reviewer" },
];

const PRESET_GROUP_ITEMS: Array<{ group: PresetGroup; label: string }> = [
  { group: "brainstormReviewers", label: "Brainstorm reviewers" },
  { group: "planners", label: "Planners" },
  { group: "planReviewers", label: "Plan reviewers" },
  { group: "codeReviewers", label: "Code reviewers" },
];

const TIMEOUT_LABELS: Record<TimeoutKey, string> = {
  "performance.commands.afterEdit": "Command after file edit",
  "performance.commands.afterImplement": "Command after implementation",
  "performance.internals.subagentStale": "Subagent stale",
  "performance.internals.mainTurnStale": "Main turn stale",
  "performance.internals.taskLockStale": "Lock stale",
  "performance.internals.taskLockRefresh": "Lock update",
};

const VALID_NAME_RE = /^[A-Za-z0-9-]+$/;

function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pp", "config.json");
}

function getScopeConfigPath(orchestrator: Orchestrator, scope: Scope): string {
  return scope === "global" ? GLOBAL_CONFIG_PATH : getProjectConfigPath(orchestrator.cwd);
}

function hasNestedKey(obj: unknown, keyPath: string[]): boolean {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

function getNestedValue(obj: unknown, keyPath: string[]): any {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setNestedValue(obj: Record<string, any>, keyPath: string[], value: any): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) cursor[key] = {};
    cursor = cursor[key] as Record<string, any>;
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
}

function deleteNestedValue(obj: Record<string, any>, keyPath: string[]): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    cursor = current;
  }
  delete cursor[keyPath[keyPath.length - 1]!];
}

function formatInlineValue(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tagsString(tags: string[]): string {
  return tags.length > 0 ? `(${tags.join(", ")})` : "";
}

function withTags(label: string, tags: string): string {
  return tags ? `${label} ${tags}` : label;
}

function getRawScopeValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  return getNestedValue(raw, keyPath);
}

function getRawScopeConfigs(orchestrator: Orchestrator): { globalConfig: Record<string, any>; projectConfig: Record<string, any> } {
  return {
    globalConfig: readRawConfig(GLOBAL_CONFIG_PATH),
    projectConfig: readRawConfig(getProjectConfigPath(orchestrator.cwd)),
  };
}

function isEmptyOverride(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

function hasLayerOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): boolean {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  if (!hasNestedKey(raw, keyPath)) return false;
  return !isEmptyOverride(getNestedValue(raw, keyPath));
}

function getLayerOverrideValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  return getNestedValue(raw, keyPath);
}

function getOwnedScopes(orchestrator: Orchestrator, keyPath: string[]): Scope[] {
  const out: Scope[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) out.push("global");
  if (hasLayerOverride(orchestrator, "project", keyPath)) out.push("project");
  return out;
}

export function getConfigSourceInfo(orchestrator: Orchestrator, keyPath: string[]): ConfigSourceInfo {
  const { globalConfig, projectConfig } = getRawScopeConfigs(orchestrator);
  const flantConfig = getFlantGeneratedConfig() as Record<string, any> | null;
  const activeValue = getNestedValue(orchestrator.config as Record<string, any>, keyPath);
  const defaultValue = getNestedValue(getDefaultConfig() as Record<string, any>, keyPath);
  const flantValue = flantConfig ? getNestedValue(flantConfig, keyPath) : undefined;
  const globalValue = hasNestedKey(globalConfig, keyPath) ? getNestedValue(globalConfig, keyPath) : undefined;
  const projectValue = hasNestedKey(projectConfig, keyPath) ? getNestedValue(projectConfig, keyPath) : undefined;
  const source = hasNestedKey(projectConfig, keyPath)
    ? "project"
    : hasNestedKey(globalConfig, keyPath)
    ? "global"
    : flantConfig && hasNestedKey(flantConfig, keyPath)
    ? "flant"
    : "default";
  return {
    activeValue,
    defaultValue,
    flantValue,
    globalValue,
    projectValue,
    source,
  };
}

export function formatSourceTags(currentValue: any, info: ConfigSourceInfo): string {
  const tags: string[] = [];
  if (isDeepStrictEqual(currentValue, info.activeValue)) tags.push("active");
  if (isDeepStrictEqual(currentValue, info.defaultValue)) tags.push("default");
  if (info.flantValue !== undefined && isDeepStrictEqual(currentValue, info.flantValue)) tags.push("flant");
  if (info.globalValue !== undefined && isDeepStrictEqual(currentValue, info.globalValue)) tags.push("global");
  if (info.projectValue !== undefined && isDeepStrictEqual(currentValue, info.projectValue)) tags.push("project");
  return tagsString(tags);
}

export function buildResetOptions(orchestrator: Orchestrator, keyPath: string[]): OptionInput[] {
  const options: OptionInput[] = [];
  const globalValue = getLayerOverrideValue(orchestrator, "global", keyPath);
  if (hasLayerOverride(orchestrator, "global", keyPath) && !isEmptyOverride(globalValue)) {
    options.push(opt("Reset global setting", formatInlineValue(globalValue)));
  }
  const projectValue = getLayerOverrideValue(orchestrator, "project", keyPath);
  if (hasLayerOverride(orchestrator, "project", keyPath) && !isEmptyOverride(projectValue)) {
    options.push(opt("Reset project setting", formatInlineValue(projectValue)));
  }
  return options;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

export function slugify(text: string, maxLen = 40): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const safe = collapsed.replace(/[^A-Za-z0-9 _./:-]/g, "").trim();
  const base = safe || collapsed || "(empty)";
  if (base.length <= maxLen) return base;
  return `${base.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function tryApplyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const target = scope === "global" ? nextGlobal : nextProject;
    setNestedValue(target, keyPath, value);
    mergeConfigLayers(nextGlobal, nextProject);
    writeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath, value);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function tryClearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const target = scope === "global" ? nextGlobal : nextProject;
    deleteNestedValue(target, keyPath);
    mergeConfigLayers(nextGlobal, nextProject);
    removeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function parseCommaSeparated(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeUniqueTitle(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (true) {
    const candidate = `${base} (${index})`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeProviderLabel(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "x-ai") return "xAI";
  if (provider === "qwen") return "Qwen";
  if (provider === "pp-flant-anthropic") return "Flant Anthropic";
  if (provider === "pp-flant-openai") return "Flant OpenAI";
  return provider;
}

function providerOrder(provider: string): number {
  if (provider === "pp-flant-anthropic") return 0;
  if (provider === "pp-flant-openai") return 1;
  if (provider === "anthropic") return 2;
  if (provider === "openai") return 3;
  if (provider === "google") return 4;
  if (provider === "deepseek") return 5;
  if (provider === "x-ai") return 6;
  if (provider === "qwen") return 7;
  return 99;
}

function listAvailableModels(ctx: any): Array<{ provider: string; id: string; spec: string }> {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return [];

  const seen = new Set<string>();
  const models: Array<{ provider: string; id: string; spec: string }> = [];
  for (const model of available) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const spec = `${provider}/${id}`;
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id, spec });
  }

  models.sort((a, b) => {
    const byProviderOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byProviderOrder !== 0) return byProviderOrder;
    const byProviderName = a.provider.localeCompare(b.provider);
    if (byProviderName !== 0) return byProviderName;
    return compareModelVersion(b.id, a.id);
  });

  return models;
}

async function pickScope(ctx: any, orchestrator: Orchestrator): Promise<Scope | null> {
  const choice = await selectOption(ctx, "Scope", [
    opt("Set globally", GLOBAL_CONFIG_PATH),
    opt("Set for project", getProjectConfigPath(orchestrator.cwd)),
    opt("Back", "Return to the previous menu"),
  ]);
  if (!choice || choice === "Back") return null;
  if (choice === "Set globally") return "global";
  if (choice === "Set for project") return "project";
  return null;
}

async function pickScopeFromOwned(ctx: any, orchestrator: Orchestrator, keyPath: string[]): Promise<Scope | null> {
  const scopes = getOwnedScopes(orchestrator, keyPath);
  if (scopes.length === 0) return null;
  if (scopes.length === 1) return scopes[0]!;
  const options: OptionInput[] = [
    opt("Global override", GLOBAL_CONFIG_PATH),
    opt("Project override", getProjectConfigPath(orchestrator.cwd)),
    opt("Back", "Return to the previous menu"),
  ];
  const choice = await selectOption(ctx, "Choose override scope", options);
  if (!choice || choice === "Back") return null;
  return choice === "Global override" ? "global" : "project";
}

async function pickModel(ctx: any, currentModel?: string): Promise<string | null> {
  const aliasMap = getAllAliases();
  const families = getModelFamilies();
  const availableModels = listAvailableModels(ctx);
  const availableSpecs = new Set(availableModels.map((m) => m.spec));
  const currentResolved = currentModel ? resolveModel(currentModel) : null;
  const currentAvailable = currentResolved ? availableSpecs.has(currentResolved) : false;
  const visibleAliases = new Set(
    Object.entries(aliasMap)
      .filter(([, resolved]) => availableSpecs.has(resolved))
      .map(([alias]) => alias),
  );
  const options: OptionInput[] = [];
  const selectionToModel = new Map<string, string>();
  const usedTitles = new Set<string>();

  if (currentModel && !visibleAliases.has(currentModel)) {
    const tags = ["active"];
    if (!currentAvailable) tags.push("unavailable");
    const title = makeUniqueTitle(withTags(currentModel, tagsString(tags)), usedTitles);
    options.push(opt(title, "Current model"));
    selectionToModel.set(title, currentModel);
  }

  const aliasEntries: Array<{ provider: string; displayName: string; alias: string }> = [];
  for (const family of families) {
    for (const alias of family.aliases) {
      if (!visibleAliases.has(alias)) continue;
      aliasEntries.push({
        provider: alias.split("/")[0] ?? "",
        displayName: family.displayName,
        alias,
      });
    }
  }

  aliasEntries.sort((a, b) => {
    const byProviderOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byProviderOrder !== 0) return byProviderOrder;
    const byProviderName = a.provider.localeCompare(b.provider);
    if (byProviderName !== 0) return byProviderName;
    return a.displayName.localeCompare(b.displayName);
  });

  for (const entry of aliasEntries) {
    const providerLabel = normalizeProviderLabel(entry.provider);
    const tags = entry.alias === currentModel ? tagsString(["active"]) : "";
    const title = makeUniqueTitle(withTags(`${providerLabel} — ${entry.displayName} (latest)`, tags), usedTitles);
    options.push(opt(title, entry.alias));
    selectionToModel.set(title, entry.alias);
  }

  if (availableModels.length > 0) {
    for (const model of availableModels) {
      if (currentModel && model.spec === currentModel) continue;
      const providerLabel = normalizeProviderLabel(model.provider);
      const title = makeUniqueTitle(`${providerLabel} — ${model.id}`, usedTitles);
      options.push(opt(title, model.spec));
      selectionToModel.set(title, model.spec);
    }
  }

  options.push(opt("Back", "Return to the previous menu"));

  while (true) {
    const choice = await selectOption(ctx, "Model", options);
    if (!choice || choice === "Back") return null;
    const selected = selectionToModel.get(choice);
    if (selected) return selected;
  }
}

async function pickThinking(
  ctx: any,
  allowXhigh: boolean,
  orchestrator?: Orchestrator,
  keyPath?: string[],
): Promise<string | null> {
  const options: OptionInput[] = [];
  const byTitle = new Map<string, string>();
  const usedTitles = new Set<string>();
  const values = allowXhigh ? ["xhigh", "high", "medium", "low", "off"] : ["high", "medium", "low", "off"];
  const info = orchestrator && keyPath ? getConfigSourceInfo(orchestrator, keyPath) : null;
  for (const value of values) {
    const label = thinkingLabel(value);
    const title = makeUniqueTitle(withTags(label, info ? formatSourceTags(value, info) : ""), usedTitles);
    options.push(title);
    byTitle.set(title, value);
  }
  options.push(opt("Back", "Return to the previous menu"));
  const choice = await selectOption(ctx, "Thinking level", options);
  if (!choice || choice === "Back") return null;
  return byTitle.get(choice) ?? null;
}

function refreshSubagentDefinitions(orchestrator: Orchestrator, keyPath: string[]): void {
  if (keyPath[0] !== "agents") return;
  unregisterAgentDefinitions(orchestrator.pi);
  orchestrator.registerAgents();
}

function applyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): void {
  const result = tryApplyConfigChange(orchestrator, scope, keyPath, value);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify(`Config update rejected: ${result.error}`, "error");
    return;
  }
  const available = (orchestrator.lastCtx as any)?.modelRegistry?.getAvailable?.();
  if (Array.isArray(available)) {
    const modelIds = available
      .map((m: any) => {
        const provider = typeof m?.provider === "string" ? m.provider.trim() : "";
        const id = typeof m?.id === "string" ? m.id.trim() : "";
        return provider && id ? `${provider}/${id}` : "";
      })
      .filter((id: string) => id.length > 0);
    updateRegistryFromAvailableModels(modelIds);
  }
  refreshSubagentDefinitions(orchestrator, keyPath);
}

function clearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): void {
  const result = tryClearConfigOverride(orchestrator, scope, keyPath);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify(`Config update rejected: ${result.error}`, "error");
    return;
  }
  refreshSubagentDefinitions(orchestrator, keyPath);
}

function thinkingLabel(value: string): string {
  if (value === "off") return "Off";
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  if (value === "xhigh") return "Extra High";
  return value;
}

function logLevelLabel(value: string): string {
  if (value === "debug") return "Debug";
  if (value === "info") return "Info";
  if (value === "warn") return "Warning";
  if (value === "error") return "Error";
  return value;
}

function applyScopeChoice(orchestrator: Orchestrator, keyPath: string[], value: any, scope: Scope | null): void {
  if (!scope) return;
  try {
    const globalConfig = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const projectConfig = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const mergedWithoutScope = scope === "global"
      ? (() => {
        deleteNestedValue(globalConfig, keyPath);
        return mergeConfigLayers(globalConfig, null);
      })()
      : (() => {
        deleteNestedValue(projectConfig, keyPath);
        return mergeConfigLayers(globalConfig, projectConfig);
      })();
    const defaultForScope = getNestedValue(mergedWithoutScope, keyPath);
    if (isDeepStrictEqual(value, defaultForScope)) {
      if (scope === "global") {
        clearConfigOverride(orchestrator, "global", keyPath);
        return;
      }
      if (!hasLayerOverride(orchestrator, "global", keyPath)) {
        clearConfigOverride(orchestrator, "project", keyPath);
        return;
      }
    }
  } catch {}
  applyConfigChange(orchestrator, scope, keyPath, value);
}

function enabledPresetSummary(variants: Record<string, VariantConfig>): string {
  const enabled = Object.entries(variants)
    .filter(([, variant]) => isEnabled(variant))
    .map(([name, variant]) => {
      const info = getModelInfo(variant.model);
      return `${name}: ${info.vendor}/${info.family} (${variant.thinking})`;
    });
  return enabled.length > 0 ? enabled.join(", ") : "No enabled models";
}

async function promptRequiredInput(ctx: any, label: string): Promise<string | null> {
  const value = await ctx.ui.input(label);
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed;
}

async function promptSafeName(ctx: any, label: string): Promise<string | null> {
  const value = await promptRequiredInput(ctx, label);
  if (!value) return null;
  if (!VALID_NAME_RE.test(value)) {
    ctx.ui.notify("Use only letters, numbers, and '-'.", "warning");
    return null;
  }
  return value;
}

async function maybeHandleResetChoice(orchestrator: Orchestrator, ctx: any, choice: string, keyPath: string[]): Promise<boolean> {
  if (choice === "Reset global setting") {
    const confirm = await selectOption(ctx, "Confirm reset?", [
      opt("Yes, reset", `Reset global override ${formatInlineValue(getLayerOverrideValue(orchestrator, "global", keyPath))}`),
      opt("Back", "Cancel"),
    ]);
    if (confirm !== "Yes, reset") return true;
    clearConfigOverride(orchestrator, "global", keyPath);
    return true;
  }
  if (choice === "Reset project setting") {
    const confirm = await selectOption(ctx, "Confirm reset?", [
      opt("Yes, reset", `Reset project override ${formatInlineValue(getLayerOverrideValue(orchestrator, "project", keyPath))}`),
      opt("Back", "Cancel"),
    ]);
    if (confirm !== "Yes, reset") return true;
    clearConfigOverride(orchestrator, "project", keyPath);
    return true;
  }
  return false;
}

async function showOrchestratorEditor(
  orchestrator: Orchestrator,
  ctx: any,
  role: MainModelRole,
  label: string,
): Promise<typeof BACK> {
  while (true) {
    const current = orchestrator.config.agents.orchestrators[role];
    const basePath = ["agents", "orchestrators", role];
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${current.model}`, "Choose the model for this agent"),
      opt(`Thinking: ${thinkingLabel(current.thinking)}`, "Choose how much this agent thinks before acting"),
      ...buildResetOptions(orchestrator, basePath),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, current.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, [...basePath, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, false, orchestrator, [...basePath, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, [...basePath, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, basePath);
  }
}

async function showOrchestratorsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = ORCHESTRATOR_ROLES.map(({ role, label, description }) => {
      const current = orchestrator.config.agents.orchestrators[role];
      return opt(label, `${current.model} / ${thinkingLabel(current.thinking)} — ${description}`);
    });
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Orchestrators", options);
    if (!choice || choice === "Back") return BACK;
    const picked = ORCHESTRATOR_ROLES.find((item) => item.label === choice);
    if (!picked) continue;
    await showOrchestratorEditor(orchestrator, ctx, picked.role, picked.label);
  }
}

async function showSimpleSubagentEditor(
  orchestrator: Orchestrator,
  ctx: any,
  role: AgentRole,
  label: string,
): Promise<typeof BACK> {
  while (true) {
    const current = orchestrator.config.agents.subagents.simple[role];
    const basePath = ["agents", "subagents", "simple", role];
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${current.model}`, "Choose the model for this agent"),
      opt(`Thinking: ${thinkingLabel(current.thinking)}`, "Choose how much this agent thinks before acting"),
      ...buildResetOptions(orchestrator, basePath),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, current.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, [...basePath, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, true, orchestrator, [...basePath, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, [...basePath, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, basePath);
  }
}

async function addPresetVariant(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<void> {
  const variantName = await promptSafeName(ctx, "Agent name");
  if (!variantName) return;
  if (orchestrator.config.agents.subagents.presetGroups[group].presets?.[presetName]?.agents?.[variantName]) {
    ctx.ui.notify(`Agent '${variantName}' already exists.`, "warning");
    return;
  }
  const model = await pickModel(ctx);
  if (!model) return;
  const thinking = await pickThinking(ctx, true);
  if (!thinking) return;
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return;
  applyConfigChange(orchestrator, scope, ["agents", "subagents", "presetGroups", group, "presets", presetName, "agents", variantName], {
    enabled: true,
    model,
    thinking,
  });
}

async function removePresetVariant(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
  variantName: string,
): Promise<void> {
  const variantPath = ["agents", "subagents", "presetGroups", group, "presets", presetName, "agents", variantName];
  const presetAgentsPath = ["agents", "subagents", "presetGroups", group, "presets", presetName, "agents"];
  const scopes = getOwnedScopes(orchestrator, variantPath);
  if (scopes.length === 0) return;
  const scope = scopes.length === 1 ? scopes[0]! : await pickScopeFromOwned(ctx, orchestrator, variantPath);
  if (!scope) return;
  const rawPresetValue = getRawScopeValue(orchestrator, scope, presetAgentsPath);
  if (!rawPresetValue || typeof rawPresetValue !== "object" || Array.isArray(rawPresetValue)) {
    ctx.ui.notify("No override in selected scope.", "info");
    return;
  }
  const rawPreset = rawPresetValue as Record<string, VariantConfig>;
  if (!Object.prototype.hasOwnProperty.call(rawPreset, variantName)) {
    ctx.ui.notify("Agent is inherited and cannot be removed in selected scope.", "info");
    return;
  }
  if (Object.keys(rawPreset).length <= 1) {
    try {
      const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
      const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
      const target = scope === "global" ? nextGlobal : nextProject;
      deleteNestedValue(target, presetAgentsPath);
      mergeConfigLayers(nextGlobal, nextProject);
    } catch {
      ctx.ui.notify("Cannot delete the last agent in this preset.", "warning");
      return;
    }
    clearConfigOverride(orchestrator, scope, presetAgentsPath);
    return;
  }
  const nextPreset = structuredClone(rawPreset);
  delete nextPreset[variantName];
  applyConfigChange(orchestrator, scope, presetAgentsPath, nextPreset);
}

async function showPresetVariantEditor(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
  variantName: string,
): Promise<typeof BACK> {
  while (true) {
    const variant = orchestrator.config.agents.subagents.presetGroups[group].presets?.[presetName]?.agents?.[variantName];
    if (!variant) return BACK;
    const variantPath = ["agents", "subagents", "presetGroups", group, "presets", presetName, "agents", variantName];
    const options: OptionInput[] = [
      opt(`Enabled: ${isEnabled(variant) ? "Yes" : "No"}`, "Toggle enabled state"),
      opt(`Model: ${variant.model}`, "Choose the model for this agent"),
      opt(`Thinking: ${thinkingLabel(variant.thinking)}`, "Choose how much this agent thinks before acting"),
    ];
    if (getOwnedScopes(orchestrator, variantPath).length > 0) {
      options.push(opt("Delete", "Delete this agent override"));
    }
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `Agent "${variantName}"`, options);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, variant.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, [...variantPath, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, true, orchestrator, [...variantPath, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, [...variantPath, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Enabled:")) {
      await showBooleanSetting(orchestrator, ctx, "Enabled", [...variantPath, "enabled"], "Make this agent available for use", "Disable this agent so it is not used");
      continue;
    }
    const confirm = await selectOption(ctx, "Confirm delete?", [
      opt("Yes, delete", "This cannot be undone"),
      opt("Back", "Cancel"),
    ]);
    if (confirm !== "Yes, delete") continue;
    await removePresetVariant(orchestrator, ctx, group, presetName, variantName);
    return BACK;
  }
}

async function showPresetAgentsMenu(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<typeof BACK> {
  while (true) {
    const preset = orchestrator.config.agents.subagents.presetGroups[group].presets?.[presetName];
    if (!preset) return BACK;
    const agents = preset.agents ?? {};
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    for (const [variantName, variant] of Object.entries(agents)) {
      const tag = isEnabled(variant) ? "" : " (disabled)";
      const title = `Agent "${variantName}"${tag}`;
      options.push(opt(title, `${variant.model} / ${thinkingLabel(variant.thinking)}`));
      byTitle.set(title, variantName);
    }
    options.push(opt("New agent", "Add an agent variant to this preset"));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Agents", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New agent") {
      await addPresetVariant(orchestrator, ctx, group, presetName);
      continue;
    }
    const variantName = byTitle.get(choice);
    if (!variantName) continue;
    await showPresetVariantEditor(orchestrator, ctx, group, presetName, variantName);
  }
}

function deletePresetFromScope(orchestrator: Orchestrator, scope: Scope, group: PresetGroup, presetName: string): void {
  const groupPath = ["agents", "subagents", "presetGroups", group, "presets"];
  const rawGroup = getRawScopeValue(orchestrator, scope, groupPath);
  if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) return;
  const nextGroup = structuredClone(rawGroup as Record<string, { enabled?: boolean; agents: Record<string, VariantConfig> }>);
  delete nextGroup[presetName];
  if (Object.keys(nextGroup).length === 0) {
    clearConfigOverride(orchestrator, scope, groupPath);
  } else {
    applyConfigChange(orchestrator, scope, groupPath, nextGroup);
  }
}

function isPresetDisabled(orchestrator: Orchestrator, group: PresetGroup, presetName: string): boolean {
  const preset = orchestrator.config.agents.subagents.presetGroups[group].presets[presetName];
  return preset?.enabled === false;
}

function setPresetDisabled(orchestrator: Orchestrator, group: PresetGroup, presetName: string, disabled: boolean, scope: Scope): void {
  applyConfigChange(
    orchestrator,
    scope,
    ["agents", "subagents", "presetGroups", group, "presets", presetName, "enabled"],
    !disabled,
  );
}

async function showPresetEditor(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<typeof BACK> {
  while (true) {
    const preset = orchestrator.config.agents.subagents.presetGroups[group].presets?.[presetName];
    if (!preset) return BACK;
    const isDefault = orchestrator.config.agents.subagents.presetGroups[group].default === presetName;
    const disabled = isPresetDisabled(orchestrator, group, presetName);
    const presetPath = ["agents", "subagents", "presetGroups", group, "presets", presetName];
    const defaultPath = ["agents", "subagents", "presetGroups", group, "default"];
    const options: OptionInput[] = [
      opt(`Enabled: ${disabled ? "No" : "Yes"}`, "Enable or disable this preset"),
      opt("Agents", `${Object.keys(preset.agents ?? {}).length} agents`),
    ];
    if (!isDefault) {
      options.push(opt("Use as default", "Set as default preset"));
    }
    options.push(...buildResetOptions(orchestrator, presetPath));
    if (getOwnedScopes(orchestrator, presetPath).length > 0) {
      options.push(opt("Delete", "Delete this preset override"));
    }
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `Preset "${presetName}"${isDefault ? " (default)" : ""}`, options);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Enabled:")) {
      await showPresetEnabledSetting(orchestrator, ctx, group, presetName);
      continue;
    }
    if (choice === "Use as default") {
      applyScopeChoice(orchestrator, defaultPath, presetName, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === "Agents") {
      await showPresetAgentsMenu(orchestrator, ctx, group, presetName);
      continue;
    }
    if (choice === "Delete") {
      if (isDefault) {
        ctx.ui.notify("Cannot delete the default preset. Change the default first.", "warning");
        continue;
      }
      const confirm = await selectOption(ctx, "Confirm delete?", [
        opt("Yes, delete", "This cannot be undone"),
        opt("Back", "Cancel"),
      ]);
      if (confirm !== "Yes, delete") continue;
      const scope = await pickScopeFromOwned(ctx, orchestrator, presetPath);
      if (!scope) continue;
      deletePresetFromScope(orchestrator, scope, group, presetName);
      return BACK;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, presetPath);
  }
}

async function showPresetEnabledSetting(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  presetName: string,
): Promise<void> {
  const enabledPath = ["agents", "subagents", "presetGroups", group, "presets", presetName, "enabled"];
  const info = getConfigSourceInfo(orchestrator, enabledPath);
  const yesTitle = withTags("Yes", formatSourceTags(true, info));
  const noTitle = withTags("No", formatSourceTags(false, info));
  const choice = await selectOption(ctx, "Enabled", [
    { title: yesTitle, description: "Make this preset available for selection" },
    { title: noTitle, description: "Hide this preset so it can no longer be selected" },
    opt("Back", "Return to the previous menu"),
  ]);
  if (!choice || choice === "Back") return;
  if (choice === yesTitle) {
    const scope = await pickScope(ctx, orchestrator);
    if (!scope) return;
    setPresetDisabled(orchestrator, group, presetName, false, scope);
  } else if (choice === noTitle) {
    const scope = await pickScope(ctx, orchestrator);
    if (!scope) return;
    setPresetDisabled(orchestrator, group, presetName, true, scope);
  }
}

async function addNewPreset(orchestrator: Orchestrator, ctx: any, group: PresetGroup): Promise<void> {
  const name = await promptSafeName(ctx, "Preset name");
  if (!name) return;
  if (orchestrator.config.agents.subagents.presetGroups[group].presets?.[name]) {
    ctx.ui.notify(`Preset '${name}' already exists.`, "warning");
    return;
  }
  const variantName = await promptSafeName(ctx, "Initial agent name");
  if (!variantName) return;
  const model = await pickModel(ctx);
  if (!model) return;
  const thinking = await pickThinking(ctx, true);
  if (!thinking) return;
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return;
  applyConfigChange(orchestrator, scope, ["agents", "subagents", "presetGroups", group, "presets", name], {
    enabled: true,
    agents: {
      [variantName]: { enabled: true, model, thinking },
    },
  });
}

async function showPresetSettings(
  orchestrator: Orchestrator,
  ctx: any,
  group: PresetGroup,
  title: string,
): Promise<typeof BACK> {
  while (true) {
    const presets = orchestrator.config.agents.subagents.presetGroups[group].presets ?? {};
    const defaultName = orchestrator.config.agents.subagents.presetGroups[group].default;
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    for (const [presetName, preset] of Object.entries(presets)) {
      const tags: string[] = [];
      if (presetName === defaultName) tags.push("default");
      if (isPresetDisabled(orchestrator, group, presetName)) tags.push("disabled");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      const optionTitle = `Preset "${presetName}"${tagStr}`;
      options.push(opt(optionTitle, enabledPresetSummary(preset.agents)));
      byTitle.set(optionTitle, presetName);
    }
    options.push(opt("New preset", "Create a preset in this group"));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, title, options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New preset") {
      await addNewPreset(orchestrator, ctx, group);
      continue;
    }
    const presetName = byTitle.get(choice);
    if (!presetName) continue;
    await showPresetEditor(orchestrator, ctx, group, presetName);
  }
}

async function showSubagentSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = SUBAGENT_ROLES.map(({ role, label, description }) => {
      const current = orchestrator.config.agents.subagents.simple[role];
      return opt(label, `${current.model} / ${thinkingLabel(current.thinking)} — ${description}`);
    });
    for (const item of PRESET_GROUP_ITEMS) {
      options.push(opt(item.label, `${Object.keys(orchestrator.config.agents.subagents.presetGroups[item.group].presets ?? {}).length} presets`));
    }
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Subagents", options);
    if (!choice || choice === "Back") return BACK;
    const simple = SUBAGENT_ROLES.find((item) => item.label === choice);
    if (simple) {
      await showSimpleSubagentEditor(orchestrator, ctx, simple.role, simple.label);
      continue;
    }
    const group = PRESET_GROUP_ITEMS.find((item) => item.label === choice);
    if (!group) continue;
    await showPresetSettings(orchestrator, ctx, group.group, group.label);
  }
}

function getCommandScope(orchestrator: Orchestrator, keyPath: string[]): Scope {
  const info = getConfigSourceInfo(orchestrator, keyPath);
  if (info.source === "project") return "project";
  if (info.source === "global") return "global";
  return "project";
}

function ensureUniqueCommandId(existing: Record<string, unknown>, base: string): string {
  if (!Object.prototype.hasOwnProperty.call(existing, base)) return base;
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(existing, `${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function commandIdFromRun(run: string): string {
  const base = run
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "command";
}

async function showAfterEditCommands(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const commands = orchestrator.config.commands.afterEdit;
    const entries = Object.entries(commands);
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    const usedTitles = new Set<string>();
    for (const [id, cmd] of entries) {
      const title = makeUniqueTitle(`Command "${id}"`, usedTitles);
      const globsCount = (cmd.globs ?? []).length;
      const enabledTag = isEnabled(cmd) ? "" : " [disabled]";
      options.push(opt(`${title}${enabledTag}`, `${globsCount} patterns — ${cmd.run}`));
      byTitle.set(`${title}${enabledTag}`, id);
    }
    options.push(opt("New command", "Add a command to run after a file edit"));
    options.push(...buildResetOptions(orchestrator, ["commands", "afterEdit"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `After file edit: ${entries.length} commands`, options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New command") {
      const run = await promptRequiredInput(ctx, "Command to run");
      if (!run) continue;
      const globInput = await promptRequiredInput(ctx, "Glob patterns (comma-separated)");
      if (!globInput) {
        ctx.ui.notify("At least one file pattern is required.", "warning");
        continue;
      }
      const patterns = parseCommaSeparated(globInput);
      if (patterns.length === 0) {
        ctx.ui.notify("At least one file pattern is required.", "warning");
        continue;
      }
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const baseId = commandIdFromRun(run);
      const id = ensureUniqueCommandId(commands, baseId);
      applyConfigChange(orchestrator, scope, ["commands", "afterEdit", id], { run, globs: patterns, enabled: true });
      continue;
    }
    if (await maybeHandleResetChoice(orchestrator, ctx, choice, ["commands", "afterEdit"])) continue;
    const id = byTitle.get(choice);
    if (!id) continue;
    const commandPath = ["commands", "afterEdit", id];
    while (true) {
      const command = orchestrator.config.commands.afterEdit[id];
      if (!command) break;
      const commandChoice = await selectOption(ctx, `Command "${id}"`, [
        opt("Edit command", command.run),
        opt("Triggers", `${(command.globs ?? []).length} patterns`),
        opt(`Enabled: ${isEnabled(command) ? "Yes" : "No"}`, "Toggle command"),
        opt("Delete command", "Remove this command"),
        opt("Back", "Return to previous menu"),
      ]);
      if (!commandChoice || commandChoice === "Back") break;
      if (commandChoice === "Edit command") {
        const run = await promptRequiredInput(ctx, `Command (current: ${command.run})`);
        if (!run) continue;
        const scope = await pickScope(ctx, orchestrator);
        if (!scope) continue;
        applyConfigChange(orchestrator, scope, [...commandPath, "run"], run);
        continue;
      }
      if (commandChoice.startsWith("Enabled:")) {
        await showBooleanSetting(orchestrator, ctx, "Enabled", [...commandPath, "enabled"], "Run this command when its triggers fire", "Keep this command configured but stop running it");
        continue;
      }
      if (commandChoice === "Triggers") {
        while (true) {
          const current = orchestrator.config.commands.afterEdit[id];
          if (!current) break;
          const currentGlobs = current.globs ?? [];
          const patternUsed = new Set<string>();
          const patternOptions: OptionInput[] = currentGlobs.map((glob) => {
            const title = makeUniqueTitle(`Pattern "${slugify(glob, 50)}"`, patternUsed);
            return opt(title, glob);
          });
          patternOptions.push(opt("New pattern", "Add trigger pattern"));
          patternOptions.push(opt("Back", "Return to previous menu"));
          const patternChoice = await selectOption(ctx, "File patterns", patternOptions);
          if (!patternChoice || patternChoice === "Back") break;
          if (patternChoice === "New pattern") {
            const value = await promptRequiredInput(ctx, "Pattern");
            if (!value) continue;
            const scope = await pickScope(ctx, orchestrator);
            if (!scope) continue;
            applyConfigChange(orchestrator, scope, [...commandPath, "globs"], [...currentGlobs, value]);
            continue;
          }
          const patternGlob = patternOptions.find((o) => (typeof o === "string" ? o : o.title) === patternChoice);
          const actualGlob = patternGlob && typeof patternGlob !== "string" ? patternGlob.description : undefined;
          const patternIndex = actualGlob ? currentGlobs.indexOf(actualGlob) : -1;
          if (patternIndex < 0) continue;
          const action = await selectOption(ctx, `Pattern "${slugify(currentGlobs[patternIndex]!, 50)}"`, [
            opt("Edit", currentGlobs[patternIndex]!),
            opt("Delete", "Remove this pattern"),
            opt("Back", "Return to previous menu"),
          ]);
          if (!action || action === "Back") continue;
          const nextGlob = [...currentGlobs];
          if (action === "Delete") {
            const confirm = await selectOption(ctx, "Confirm delete?", [
              opt("Yes, delete", "This cannot be undone"),
              opt("Back", "Cancel"),
            ]);
            if (confirm !== "Yes, delete") continue;
            nextGlob.splice(patternIndex, 1);
          } else {
            const value = await promptRequiredInput(ctx, `Pattern (current: ${currentGlobs[patternIndex]})`);
            if (!value) continue;
            nextGlob[patternIndex] = value;
          }
          const scope = await pickScope(ctx, orchestrator);
          if (!scope) continue;
          applyConfigChange(orchestrator, scope, [...commandPath, "globs"], nextGlob);
        }
        continue;
      }
      const confirm = await selectOption(ctx, "Confirm delete?", [
        opt("Yes, delete", "This cannot be undone"),
        opt("Back", "Cancel"),
      ]);
      if (confirm !== "Yes, delete") continue;
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      clearConfigOverride(orchestrator, scope, commandPath);
      break;
    }
  }
}

async function showAfterImplementCommands(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const commands = orchestrator.config.commands.afterImplement;
    const entries = Object.entries(commands);
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    const usedTitles = new Set<string>();
    for (const [id, cmd] of entries) {
      const enabledTag = isEnabled(cmd) ? "" : " [disabled]";
      const title = makeUniqueTitle(`Command "${id}"${enabledTag}`, usedTitles);
      options.push(opt(title, cmd.run));
      byTitle.set(title, id);
    }
    options.push(opt("New command", "Add a command to run after implementation"));
    options.push(...buildResetOptions(orchestrator, ["commands", "afterImplement"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, `After implementation: ${entries.length} commands`, options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "New command") {
      const run = await promptRequiredInput(ctx, "Command to run");
      if (!run) continue;
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const id = ensureUniqueCommandId(commands, commandIdFromRun(run));
      applyConfigChange(orchestrator, scope, ["commands", "afterImplement", id], { run, enabled: true });
      continue;
    }
    if (await maybeHandleResetChoice(orchestrator, ctx, choice, ["commands", "afterImplement"])) continue;
    const id = byTitle.get(choice);
    if (!id) continue;
    const commandPath = ["commands", "afterImplement", id];
    while (true) {
      const command = orchestrator.config.commands.afterImplement[id];
      if (!command) break;
      const commandChoice = await selectOption(ctx, `Command "${id}"`, [
        opt("Edit command", command.run),
        opt(`Enabled: ${isEnabled(command) ? "Yes" : "No"}`, "Toggle command"),
        opt("Delete command", "Remove this command"),
        opt("Back", "Return to previous menu"),
      ]);
      if (!commandChoice || commandChoice === "Back") break;
      if (commandChoice === "Edit command") {
        const run = await promptRequiredInput(ctx, `Command (current: ${command.run})`);
        if (!run) continue;
        const scope = await pickScope(ctx, orchestrator);
        if (!scope) continue;
        applyConfigChange(orchestrator, scope, [...commandPath, "run"], run);
        continue;
      }
      if (commandChoice.startsWith("Enabled:")) {
        await showBooleanSetting(orchestrator, ctx, "Enabled", [...commandPath, "enabled"], "Run this command when its triggers fire", "Keep this command configured but stop running it");
        continue;
      }
      const confirm = await selectOption(ctx, "Confirm delete?", [
        opt("Yes, delete", "This cannot be undone"),
        opt("Back", "Cancel"),
      ]);
      if (confirm !== "Yes, delete") continue;
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      clearConfigOverride(orchestrator, scope, commandPath);
      break;
    }
  }
}

async function showCommandsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const afterEditCount = Object.keys(orchestrator.config.commands.afterEdit).length;
    const afterImplementCount = Object.keys(orchestrator.config.commands.afterImplement).length;
    const choice = await selectOption(ctx, "Commands", [
      opt(
        `After file edit: ${afterEditCount} commands`,
        "Commands run when a matching file is edited (e.g. format, lint)",
      ),
      opt(
        `After implementation: ${afterImplementCount} commands`,
        "Commands run once the implement phase completes (e.g. build, test)",
      ),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("After file edit:")) {
      await showAfterEditCommands(orchestrator, ctx);
      continue;
    }
    await showAfterImplementCommands(orchestrator, ctx);
  }
}

async function showTimeoutsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const timeoutEntries: TimeoutEntry[] = [
      {
        key: "performance.commands.afterEdit",
        path: ["performance", "commands", "afterEdit"],
        value: orchestrator.config.performance.commands.afterEdit,
      },
      {
        key: "performance.commands.afterImplement",
        path: ["performance", "commands", "afterImplement"],
        value: orchestrator.config.performance.commands.afterImplement,
      },
      {
        key: "performance.internals.subagentStale",
        path: ["performance", "internals", "subagentStale"],
        value: orchestrator.config.performance.internals.subagentStale,
      },
      {
        key: "performance.internals.mainTurnStale",
        path: ["performance", "internals", "mainTurnStale"],
        value: orchestrator.config.performance.internals.mainTurnStale,
      },
      {
        key: "performance.internals.taskLockStale",
        path: ["performance", "internals", "taskLockStale"],
        value: orchestrator.config.performance.internals.taskLockStale,
      },
      {
        key: "performance.internals.taskLockRefresh",
        path: ["performance", "internals", "taskLockRefresh"],
        value: orchestrator.config.performance.internals.taskLockRefresh,
      },
    ];
    const options: OptionInput[] = timeoutEntries.map((entry) => {
      const value = entry.value;
      const key = entry.key;
      return opt(`${TIMEOUT_LABELS[key]}: ${formatDuration(value)}`, "Change this time limit");
    });
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Timeouts", options);
    if (!choice || choice === "Back") return BACK;
    const entry = timeoutEntries.find((item) => choice.startsWith(`${TIMEOUT_LABELS[item.key]}:`));
    if (!entry) continue;
    while (true) {
      const current = getNestedValue(orchestrator.config, entry.path);
      if (typeof current !== "number") break;
      const action = await selectOption(ctx, `${TIMEOUT_LABELS[entry.key]}: ${formatDuration(current)}`, [
        opt("Edit", "Set timeout value"),
        ...buildResetOptions(orchestrator, entry.path),
        opt("Back", "Return to the previous menu"),
      ]);
      if (!action || action === "Back") break;
      if (action === "Edit") {
        const input = await promptRequiredInput(
          ctx,
          `New value (current: ${formatDuration(current)}, e.g. 30s, 5m, 1h, or milliseconds)`,
        );
        if (!input) continue;
        const parsed = parseDuration(input);
        if (parsed === null) {
          ctx.ui.notify("Invalid duration format.", "warning");
          continue;
        }
        applyScopeChoice(orchestrator, entry.path, parsed, await pickScope(ctx, orchestrator));
        continue;
      }
      await maybeHandleResetChoice(orchestrator, ctx, action, entry.path);
    }
  }
}

async function showPerformanceSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "Performance", [
      opt("Timeouts", "Adjust per-operation time limits"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    await showTimeoutsSettings(orchestrator, ctx);
  }
}

async function showBooleanSetting(
  orchestrator: Orchestrator,
  ctx: any,
  title: string,
  keyPath: string[],
  yesDescription = "Turn this setting on",
  noDescription = "Turn this setting off",
): Promise<void> {
  while (true) {
    const info = getConfigSourceInfo(orchestrator, keyPath);
    const yesTitle = withTags("Yes", formatSourceTags(true, info));
    const noTitle = withTags("No", formatSourceTags(false, info));
    const choice = await selectOption(ctx, title, [
      { title: yesTitle, description: yesDescription },
      { title: noTitle, description: noDescription },
      ...buildResetOptions(orchestrator, keyPath),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return;
    if (choice === yesTitle) {
      applyScopeChoice(orchestrator, keyPath, true, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === noTitle) {
      applyScopeChoice(orchestrator, keyPath, false, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath);
  }
}

async function showInvertedBooleanSetting(
  orchestrator: Orchestrator,
  ctx: any,
  title: string,
  keyPath: string[],
  yesDescription = "Turn this setting on",
  noDescription = "Turn this setting off",
): Promise<void> {
  while (true) {
    const info = getConfigSourceInfo(orchestrator, keyPath);
    const yesTitle = withTags("Yes", formatSourceTags(false, info));
    const noTitle = withTags("No", formatSourceTags(true, info));
    const choice = await selectOption(ctx, title, [
      { title: yesTitle, description: yesDescription },
      { title: noTitle, description: noDescription },
      ...buildResetOptions(orchestrator, keyPath),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return;
    if (choice === yesTitle) {
      applyScopeChoice(orchestrator, keyPath, false, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === noTitle) {
      applyScopeChoice(orchestrator, keyPath, true, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath);
  }
}

async function showLogLevelSetting(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const levels: Array<{ value: PiPiConfig["general"]["logLevel"]; label: string; description: string }> = [
    { value: "debug", label: "Debug", description: "Log everything, including detailed diagnostics for troubleshooting" },
    { value: "info", label: "Info", description: "Log normal activity plus warnings and errors" },
    { value: "warn", label: "Warning", description: "Log only warnings and errors" },
    { value: "error", label: "Error", description: "Log only errors" },
  ];
  while (true) {
    const info = getConfigSourceInfo(orchestrator, ["general", "logLevel"]);
    const options: OptionInput[] = levels.map((entry) => ({ title: withTags(entry.label, formatSourceTags(entry.value, info)), description: entry.description }));
    options.push(...buildResetOptions(orchestrator, ["general", "logLevel"]));
    options.push(opt("Back", "Return to the previous menu"));
    const choice = await selectOption(ctx, "Log level", options);
    if (!choice || choice === "Back") return;
    const picked = levels.find((entry) => choice.startsWith(entry.label));
    if (picked) {
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      applyConfigChange(orchestrator, scope, ["general", "logLevel"], picked.value);
      setLogLevel(orchestrator.config.general.logLevel);
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, ["general", "logLevel"]);
    setLogLevel(orchestrator.config.general.logLevel);
  }
}

async function showGeneralSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "General", [
      opt(`Commit automatically: ${orchestrator.config.general.autoCommit ? "Yes" : "No"}`, "Enable or disable auto commits"),
      opt(`Inject root AGENTS.md: ${orchestrator.config.general.injectAgentsMd ? "Yes" : "No"}`, "Inject the working repo's root AGENTS.md into the agent system prompt"),
      opt(`Ignore configs from other repos: ${orchestrator.config.general.loadExtraRepoConfigs ? "No" : "Yes"}`, "Load only root repo config"),
      opt(`Log level: ${logLevelLabel(orchestrator.config.general.logLevel)}`, "Logging verbosity"),
      opt(`Tracing: ${orchestrator.config.general.tracing ? "Yes" : "No"}`, "Capture full session traces to .pp/logs/traces/"),
      opt("Flant AI Infrastructure", "Configure corporate AI model provider"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice.startsWith("Commit automatically:")) {
      await showBooleanSetting(orchestrator, ctx, "Commit automatically", ["general", "autoCommit"], "Commit changes automatically as work progresses", "Leave committing to you");
      continue;
    }
    if (choice.startsWith("Inject root AGENTS.md:")) {
      await showBooleanSetting(orchestrator, ctx, "Inject root AGENTS.md", ["general", "injectAgentsMd"], "Inject the working repo's root AGENTS.md into the agent system prompt", "Do not inject AGENTS.md");
      continue;
    }
    if (choice.startsWith("Ignore configs from other repos:")) {
      await showInvertedBooleanSetting(orchestrator, ctx, "Ignore configs from other repos", ["general", "loadExtraRepoConfigs"], "Use only the root repo config and ignore configs from other registered repos", "Also load configs from the other registered repos");
      continue;
    }
    if (choice.startsWith("Log level:")) {
      await showLogLevelSetting(orchestrator, ctx);
      continue;
    }
    if (choice.startsWith("Tracing:")) {
      await showBooleanSetting(orchestrator, ctx, "Tracing", ["general", "tracing"], "Capture full session traces to .pp/logs/traces/", "Do not record session traces");
      continue;
    }
    await showFlantInfraMenu(orchestrator, ctx);
  }
}

async function showAgentsSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "Agents", [
      opt("Orchestrators", "Orchestrator and subagent configuration"),
      opt("Subagents", "Simple subagents and preset groups"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;
    if (choice === "Orchestrators") {
      await showOrchestratorsSettings(orchestrator, ctx);
      continue;
    }
    await showSubagentSettings(orchestrator, ctx);
  }
}

async function showReposSettings(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const repos = orchestrator.active?.state.repos ?? [];
    if (repos.length === 0) {
      await selectOption(ctx, "No repos registered yet. The agent will register repos when it starts working.", [
        opt("Back", "Return to the previous menu"),
      ]);
      return BACK;
    }

    const options: OptionInput[] = repos.map((repo) => ({
      title: repo.path,
      description: `base: ${repo.baseBranch ?? "(not set)"}${repo.isRoot ? " (root)" : ""}`,
    }));
    options.push(opt("Back", "Return to the previous menu"));

    const choice = await selectOption(ctx, "Repos", options);
    if (!choice || choice === "Back") return BACK;

    const repo = repos.find((item) => item.path === choice);
    if (!repo) continue;

    const repoOptions: OptionInput[] = [
      opt("Change base branch", `currently: ${repo.baseBranch ?? "(not set)"}`),
      opt("Back", "Return to repo list"),
    ];
    const repoChoice = await selectOption(ctx, `${repo.path}${repo.isRoot ? " (root)" : ""}`, repoOptions);
    if (!repoChoice || repoChoice === "Back") continue;

    if (repoChoice === "Change base branch") {
      const value = await ctx.ui.input("Base branch (e.g. origin/main):");
      if (value === undefined || value === null) continue;
      repo.baseBranch = String(value).trim() || undefined;
      saveTask(orchestrator.active!.dir, orchestrator.active!.state);
      unregisterAgentDefinitions(orchestrator.pi);
      orchestrator.registerAgents();
      ctx.ui.notify(`Base branch set to: ${repo.baseBranch ?? "(cleared)"}`, "info");
    }
  }
}

async function showLspSettings(ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "LSP", [
      opt("Restart all servers", "Stop all servers. They reinitialize on next use"),
      opt("Back", "Return to the previous menu"),
    ]);
    if (!choice || choice === "Back") return BACK;

    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as {
      restart?: (menuCtx: any) => Promise<void>;
    } | undefined;
    if (!api?.restart) {
      ctx.ui.notify("LSP API is not available.", "warning");
      continue;
    }
    try {
      await api.restart(ctx);
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to restart LSP servers: ${message}`, "error");
    }
  }
}

async function showSettingsMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK> {
  while (true) {
    const options: OptionInput[] = [
      opt("Info", "Usage and task status"),
      opt("General", "Commit, log level, Flant AI, repos"),
      opt("Agents", "Orchestrator and subagent configuration"),
      opt("Commands", "After file edit and after implementation"),
      opt("Performance", "Per-operation timeout limits"),
      opt("LSP", "Language server controls"),
      opt("Back", "Return to the previous menu"),
    ];

    const choice = await selectOption(ctx, "Settings", options);
    if (!choice || choice === "Back") return BACK;

    if (choice === "Info") await showInfoMenu(orchestrator, ctx);
    else if (choice === "General") await showGeneralSettings(orchestrator, ctx);
    else if (choice === "Agents") await showAgentsSettings(orchestrator, ctx);
    else if (choice === "Commands") await showCommandsSettings(orchestrator, ctx);
    else if (choice === "Performance") await showPerformanceSettings(orchestrator, ctx);
    else if (choice === "LSP") await showLspSettings(ctx);
  }
}

// First phases (brainstorm/debug/review) are always interactive and can never run
// autonomously — autonomous configs only ever cover plan/implement.
export function autonomousPhasesForTask(type: TaskType): string[] {
  if (type === "implement" || type === "debug" || type === "review") return ["plan", "implement"];
  return [];
}

function defaultAutonomousReviewPreset(type: TaskType, phase: string): string {
  if (type === "review" && phase === "review") return "deep";
  return "regular";
}

function buildDefaultAutonomousConfig(type: TaskType): AutonomousConfig {
  const phases = autonomousPhasesForTask(type);
  const out: AutonomousConfig = { phases: {} };
  for (const phase of phases) {
    out.phases[phase] = {
      reviewPreset: defaultAutonomousReviewPreset(type, phase),
      maxReviewPasses: 3,
      ...(phase === "plan" ? { plannerPreset: "regular" } : {}),
    };
  }
  return out;
}

async function showTaskModePicker(ctx: any): Promise<TaskMode | "back"> {
  const mode = await selectOption(ctx, "Mode", [
    opt("Guided", "User gates at every phase transition"),
    opt("Autonomous", "Full pipeline with automatic phase transitions"),
    opt("Back", "Return to the previous menu"),
  ]);
  if (!mode || mode === "Back") return "back";
  return mode === "Autonomous" ? "autonomous" : "guided";
}

export async function pickMaxReviewPasses(ctx: any, current: number): Promise<number | null> {
  const currentLabel = current >= 999 ? "-" : String(current);
  while (true) {
    const input = await ctx.ui.input(
      `Max review passes (enter a positive integer, or "-" for unlimited) [${currentLabel}]`,
    );
    if (input === undefined || input === null) return null;
    const trimmed = String(input).trim();
    if (trimmed === "") return null;
    if (trimmed === "-") return 999;
    if (!/^\d+$/.test(trimmed)) {
      ctx.ui.notify('Please enter a positive integer, or "-" for unlimited.', "warning");
      continue;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed <= 0) {
      ctx.ui.notify('Please enter a positive integer, or "-" for unlimited.', "warning");
      continue;
    }
    return parsed;
  }
}

async function showAutonomousPhaseSettings(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  phase: string,
  config: AutonomousConfig,
): Promise<void> {
  const phaseConfig = config.phases[phase] ?? {
    reviewPreset: defaultAutonomousReviewPreset(type, phase),
    maxReviewPasses: 3,
    ...(phase === "plan" ? { plannerPreset: "regular" } : {}),
  };
  config.phases[phase] = phaseConfig;

  while (true) {
    const reviewPreset = phaseConfig.reviewPreset ?? defaultAutonomousReviewPreset(type, phase);
    const maxReview = phaseConfig.maxReviewPasses >= 999 ? "No limit" : String(phaseConfig.maxReviewPasses);
    const options: OptionInput[] = [
      opt(`Review preset: ${reviewPreset}`, "Pick which reviewer group runs in this phase"),
    ];
    if (phase === "plan") {
      options.push(opt(`Planner preset: ${phaseConfig.plannerPreset ?? "regular"}`, "Pick which planner group runs in this phase"));
    }
    options.push(opt(`Max review passes: ${maxReview}`, "Safety cap for autonomous review loops"));
    options.push(opt("Back", "Return to autonomous settings"));

    const choice = await selectOption(ctx, `${phase.charAt(0).toUpperCase()}${phase.slice(1)} phase`, options);
    if (!choice || choice === "Back") return;

    if (choice.startsWith("Review preset:")) {
      const group = getReviewPresetGroup(phase);
      const picked = await pickPreset(ctx, orchestrator, group, "Review preset");
      if (picked) phaseConfig.reviewPreset = picked;
      continue;
    }

    if (choice.startsWith("Planner preset:")) {
      const picked = await pickPreset(ctx, orchestrator, "planners", "Planner preset");
      if (picked) phaseConfig.plannerPreset = picked;
      continue;
    }

    const pickedMax = await pickMaxReviewPasses(ctx, phaseConfig.maxReviewPasses);
    if (pickedMax !== null) phaseConfig.maxReviewPasses = pickedMax;
  }
}

async function showAutonomousSettings(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
): Promise<AutonomousConfig | null> {
  const config = buildDefaultAutonomousConfig(type);
  const phases = autonomousPhasesForTask(type);

  while (true) {
    const options: OptionInput[] = [
      opt("Start", "Begin with current autonomous settings"),
      ...phases.map((phase) => opt(`${phase.charAt(0).toUpperCase()}${phase.slice(1)} phase`, "Configure presets and review passes")),
      opt("Back", "Return to mode selection"),
    ];
    const choice = await selectOption(ctx, "Autonomous", options);
    if (!choice || choice === "Back") return null;
    if (choice === "Start") return config;

    const phase = choice.replace(/ phase$/, "").toLowerCase();
    if (!phases.includes(phase)) continue;
    await showAutonomousPhaseSettings(orchestrator, ctx, type, phase, config);
  }
}

async function pickModeForTaskStart(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
): Promise<{ mode: TaskMode; autonomousConfig?: AutonomousConfig } | null> {
  while (true) {
    const mode = await showTaskModePicker(ctx);
    if (mode === "back") return null;
    if (mode === "guided") return { mode: "guided" };
    const autonomousConfig = await showAutonomousSettings(orchestrator, ctx, type);
    if (!autonomousConfig) continue;
    return { mode: "autonomous", autonomousConfig };
  }
}

// Title: scannable human-readable intent + age. Callers must guarantee
// uniqueness across the menu (see buildResumeOptions) so the option->task
// mapping stays stable.
function resumeOptionTitle(t: TaskInfo): string {
  const marker = t.state.phase === "done" ? "✓ done · " : "";
  return `${marker}${taskNameFromState(t.dir, t.state)} — ${taskAge(t.state)}`;
}

// Description: rich per-entry detail sourced entirely from the already-loaded
// TaskState (no extra disk reads). Empty/irrelevant fields are omitted.
function resumeOptionDescription(t: TaskInfo, cwd: string): string {
  const s = t.state;
  const parts: string[] = [];

  const phaseStep = s.step ? `${s.phase}/${s.step}` : s.phase;
  parts.push(`${t.type} · ${phaseStep}`);

  const mode = s.effectiveMode ?? s.mode;
  if (mode) parts.push(mode);

  if (s.reviewCycle && s.reviewCycle.pass > 0) parts.push(`review pass ${s.reviewCycle.pass}`);

  const fileCount = s.modifiedFiles?.length ?? 0;
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);

  // Only surface the repo when it is informative: a multi-repo task, or a root
  // repo that differs from the current project directory.
  const rootRepo = s.repos?.find((r) => r.isRoot) ?? s.repos?.[0];
  if (rootRepo && ((s.repos?.length ?? 0) > 1 || basename(rootRepo.path) !== basename(cwd))) {
    parts.push(`repo: ${basename(rootRepo.path)}`);
  }

  parts.push(`id ${taskShortId(t.dir)}`);

  // Metadata line first, then a blank line, then the full (untrimmed) intent, so
  // the right pane leads with phase/mode/id and still shows the real task below.
  const full = taskFullName(t.dir, s);
  const meta = parts.join(" · ");
  return full && full !== meta ? `${meta}\n\n${full}` : meta;
}

// Build menu options with a stable option->task index. Titles are made unique
// (short id appended on collision) so selection maps back deterministically even
// if two tasks share an intent, and the age component can't break the mapping
// after the picker returns.
function buildResumeOptions(tasks: TaskInfo[], cwd: string): { options: OptionInput[]; byTitle: Map<string, TaskInfo> } {
  const seen = new Map<string, number>();
  const byTitle = new Map<string, TaskInfo>();
  const options: OptionInput[] = [];
  for (const t of tasks) {
    let title = resumeOptionTitle(t);
    const count = seen.get(title) ?? 0;
    seen.set(title, count + 1);
    if (count > 0 || byTitle.has(title)) title = `${title} [${taskShortId(t.dir)}]`;
    while (byTitle.has(title)) title = `${title} ·`;
    byTitle.set(title, t);
    options.push({ title, description: resumeOptionDescription(t, cwd) });
  }
  return { options, byTitle };
}

type StatusFilter = "Active" | "Active + Done" | "Done only" | "All";
interface ResumeFilters {
  status: StatusFilter;
  type: "All" | TaskType;
  mode: "All" | TaskMode;
  repo: string;
}

const STATUS_CYCLE: StatusFilter[] = ["Active", "Active + Done", "Done only", "All"];
const TYPE_CYCLE: Array<"All" | TaskType> = ["All", "implement", "debug", "brainstorm", "review", "quick"];
const MODE_CYCLE: Array<"All" | TaskMode> = ["All", "guided", "autonomous"];

function defaultResumeFilters(): ResumeFilters {
  return { status: "Active", type: "All", mode: "All", repo: "All" };
}

function filtersSummary(f: ResumeFilters): string {
  return `Status: ${f.status} · Type: ${f.type} · Mode: ${f.mode} · Repo: ${f.repo}`;
}

function applyResumeFilters(tasks: TaskInfo[], f: ResumeFilters): TaskInfo[] {
  return tasks.filter((t) => {
    const isDone = t.state.phase === "done";
    if (f.status === "Active" && isDone) return false;
    if (f.status === "Done only" && !isDone) return false;
    if (f.type !== "All" && t.type !== f.type) return false;
    if (f.mode !== "All" && (t.state.effectiveMode ?? t.state.mode) !== f.mode) return false;
    if (f.repo !== "All") {
      const rootRepo = t.state.repos?.find((r) => r.isRoot) ?? t.state.repos?.[0];
      if (!rootRepo || basename(rootRepo.path) !== f.repo) return false;
    }
    return true;
  });
}

function cycle<T>(values: readonly T[], current: T): T {
  const idx = values.indexOf(current);
  return values[(idx + 1) % values.length]!;
}

async function showResumeFilters(
  orchestrator: Orchestrator,
  ctx: any,
  filters: ResumeFilters,
  lockToType: TaskType | undefined,
): Promise<void> {
  const repoNames = Array.from(
    new Set(
      listTasks(orchestrator.cwd, { type: lockToType, includeDone: true })
        .map((t) => {
          const rootRepo = t.state.repos?.find((r) => r.isRoot) ?? t.state.repos?.[0];
          return rootRepo ? basename(rootRepo.path) : null;
        })
        .filter((n): n is string => !!n),
    ),
  );
  const repoCycle = ["All", ...repoNames];
  while (true) {
    const options: OptionInput[] = [
      opt(`Status: ${filters.status}`, "Cycle: Active / Active + Done / Done only / All"),
    ];
    if (!lockToType) options.push(opt(`Type: ${filters.type}`, "Cycle task type"));
    options.push(opt(`Mode: ${filters.mode}`, "Cycle: All / guided / autonomous"));
    options.push(opt(`Repo: ${filters.repo}`, "Cycle registered repo"));
    options.push(opt("Clear filters", "Reset to defaults"));
    options.push(opt("Back", "Return to the Resume list"));

    const choice = await selectOption(ctx, "Filters", options);
    if (!choice || choice === "Back") return;
    if (choice.startsWith("Status:")) filters.status = cycle(STATUS_CYCLE, filters.status);
    else if (choice.startsWith("Type:")) filters.type = cycle(TYPE_CYCLE, filters.type);
    else if (choice.startsWith("Mode:")) filters.mode = cycle(MODE_CYCLE, filters.mode);
    else if (choice.startsWith("Repo:")) filters.repo = cycle(repoCycle, filters.repo);
    else if (choice === "Clear filters") {
      const cleared = defaultResumeFilters();
      filters.status = cleared.status;
      filters.type = cleared.type;
      filters.mode = cleared.mode;
      filters.repo = cleared.repo;
    }
  }
}

async function showResumeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType | undefined,
  emptyMessage: string,
): Promise<typeof BACK | "started"> {
  const filters = defaultResumeFilters();
  while (true) {
    const all = listTasks(orchestrator.cwd, { type, includeDone: true });
    if (all.length === 0) {
      ctx.ui.notify(emptyMessage, "info");
      return BACK;
    }
    const tasks = applyResumeFilters(all, filters);

    const { options, byTitle } = buildResumeOptions(tasks, orchestrator.cwd);
    options.unshift({ title: "⚙  Filters", description: filtersSummary(filters) });
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "Resume", options);
    if (!choice || choice === "Back") return BACK;
    if (choice === "⚙  Filters") {
      await showResumeFilters(orchestrator, ctx, filters, type);
      continue;
    }

    const task = byTitle.get(choice);
    if (!task) continue;
    const result = await resumeTask(orchestrator, ctx, task);
    if (result.ok) return "started";
  }
}

function fromOptionTitle(t: TaskInfo): string {
  return taskName(t.dir);
}

function fromOptionDescription(t: TaskInfo, cwd: string): string {
  const age = taskAge(t.state);
  const rel = relative(join(cwd, ".pp", "state"), t.dir);
  return `${t.type}, ${age} — ${rel}`;
}

async function showFromMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const tasks = listCompletedFromTasks(orchestrator.cwd);
    if (tasks.length === 0) {
      ctx.ui.notify("No completed brainstorm/debug/review tasks with artifacts found.", "info");
      return BACK;
    }

    const options: OptionInput[] = tasks.map((t) => ({
      title: fromOptionTitle(t),
      description: fromOptionDescription(t, orchestrator.cwd),
    }));
    options.push({ title: "Back", description: "Return to the previous menu" });

    const choice = await selectOption(ctx, "From", options);
    if (!choice || choice === "Back") return BACK;

    const selected = tasks.find((t) => fromOptionTitle(t) === choice);
    if (!selected) continue;

    const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement");
    if (!modeSelection) continue;
    // Carry the source task's resolved name so the new implement task shows a
    // real name instead of the literal "implement" (#7).
    const inheritedName = taskFullName(selected.dir, selected.state);
    await orchestrator.startTask(ctx, "implement", inheritedName, selected.dir, true, modeSelection.mode);
    if (orchestrator.active) {
      orchestrator.active.state.autonomousConfig = modeSelection.autonomousConfig;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    }
    return "started";
  }
}

async function showImplementMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Implement", [
      { title: "New", description: "Start a new implementation from scratch" },
      { title: "From", description: "Continue from a completed brainstorm or debug task" },
      { title: "Resume", description: "Resume a paused implementation" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement");
      if (!modeSelection) continue;
      await orchestrator.startTask(ctx, "implement", "implement", undefined, undefined, modeSelection.mode);
      if (orchestrator.active) {
        orchestrator.active.state.autonomousConfig = modeSelection.autonomousConfig;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
      return "started";
    }

    if (choice === "From") {
      const result = await showFromMenu(orchestrator, ctx);
      if (result === "started") return result;
      continue;
    }

    const result = await showResumeMenu(orchestrator, ctx, "implement", "No paused implement tasks found.");
    if (result === "started") return result;
  }
}

function buildPrContext(parsed: any): { prUrl: string | null; prContext: string | null } {
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed?.body === "string" ? parsed.body.trim() : "";
  const commentsRaw = Array.isArray(parsed?.comments)
    ? parsed.comments
    : Array.isArray(parsed?.comments?.nodes)
    ? parsed.comments.nodes
    : [];
  const comments: string[] = commentsRaw
    .map((comment: any) => {
      const text = typeof comment?.body === "string"
        ? comment.body.trim()
        : typeof comment?.bodyText === "string"
        ? comment.bodyText.trim()
        : "";
      return text;
    })
    .filter((text: string): text is string => text.length > 0);

  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (body) parts.push(`Body:\n${body}`);
  if (comments.length > 0) {
    parts.push(`Comments:\n${comments.map((comment, index) => `${index + 1}. ${comment}`).join("\n\n")}`);
  }

  const prUrl = typeof parsed?.url === "string" && parsed.url.trim().length > 0 ? parsed.url.trim() : null;
  return { prUrl, prContext: parts.length > 0 ? parts.join("\n\n") : null };
}

async function detectCurrentPrContext(orchestrator: Orchestrator, repos: RepoInfo[]): Promise<RepoPrContext[]> {
  const results: RepoPrContext[] = [];
  for (const repo of repos) {
    try {
      const prResult = await orchestrator.pi.exec("gh", ["pr", "view", "--json", "url,title,body,comments"], {
        cwd: repo.path,
        timeout: 10000,
      });
      if (prResult.code !== 0) continue;
      const parsed = JSON.parse(prResult.stdout);
      const pr = buildPrContext(parsed);
      if (pr.prUrl || pr.prContext) {
        results.push({ repoPath: repo.path, prUrl: pr.prUrl, prContext: pr.prContext });
      }
    } catch {}
  }
  return results;
}

async function openCodeReviewInPlannotator(
  orchestrator: Orchestrator,
  payload: { cwd: string; diffType?: string; defaultBranch?: string },
): Promise<{ status: "approved" | "needs_changes" | "error"; feedback?: string; error?: string }> {
  const requestPayload: Record<string, unknown> = { cwd: payload.cwd };
  if (payload.diffType) requestPayload.diffType = payload.diffType;
  if (payload.defaultBranch) requestPayload.defaultBranch = payload.defaultBranch;

  const { opened, reviewId, outcome } = await openPlannotator(orchestrator.pi, "code-review", requestPayload);
  if (!opened) {
    return {
      status: "error",
      error: outcome === "timeout"
        ? "Plannotator did not respond within 30s (is the browser extension running?)."
        : "Plannotator is not available (no handler responded — is the browser extension installed?).",
    };
  }

  let result: { approved: boolean; feedback?: string; error?: string };
  try {
    result = await waitForPlannotatorResult(orchestrator, reviewId, null);
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Plannotator review failed." };
  }
  if (result.error) {
    return { status: "error", error: result.error };
  }
  const feedback = typeof result.feedback === "string" && result.feedback.trim().length > 0
    ? result.feedback
    : undefined;
  return { status: result.approved ? "approved" : "needs_changes", feedback };
}

// Per-repo interleaved Plannotator loop (#3a). Runs from the persisted cursor: for
// each repo, ask the diff scope, open Plannotator and WAIT (dialogue closed). On
// NEEDS_CHANGES, persist the cursor advanced past this repo and return a work
// instruction (mirrors the plan path: answer questions + apply changes) so the
// agent fixes THIS repo before the next opens; the next /pp resumes the loop. On
// approved, advance and continue in-loop. On error the repo is left UNREVIEWED:
// the cursor stays put and the user chooses Retry / Skip / Done. When the cursor
// is exhausted or the user stops, clear the cursor and return null (fall back to
// the menu).
async function runPlannotatorCursor(orchestrator: Orchestrator, ctx: any): Promise<string | null> {
  const task = orchestrator.active;
  if (!task) return null;
  const cursor = task.state.plannotatorCursor;
  if (!cursor) return null;

  while (task.state.plannotatorCursor && task.state.plannotatorCursor.index < task.state.plannotatorCursor.repoPaths.length) {
    const cur = task.state.plannotatorCursor;
    const repoPath = cur.repoPaths[cur.index];
    const repo = getRegisteredRepos(orchestrator).find((r) => r.path === repoPath) ?? { path: repoPath, isRoot: false };

    const diffChoice = await selectOption(ctx, `Review: ${formatRepoLabel(repo)}`, [
      opt("All branch changes", "Committed changes vs base branch"),
      opt("Last commit", "Changes in the most recent commit"),
      opt("Since commit", "Review all changes since a specific commit"),
      opt("Uncommitted changes", "Working directory changes"),
      opt("Skip this repo", "Move to the next repository"),
      opt("Done (stop reviewing)", "Stop iterating repositories"),
    ]);

    if (!diffChoice || diffChoice === "Done (stop reviewing)") {
      task.state.plannotatorCursor = undefined;
      saveTask(task.dir, task.state);
      return null;
    }
    if (diffChoice === "Skip this repo") {
      cur.index += 1;
      saveTask(task.dir, task.state);
      continue;
    }

    let diffType: string;
    let defaultBranch: string | undefined;
    if (diffChoice === "All branch changes") {
      diffType = "branch";
      defaultBranch = await detectDefaultBranch(orchestrator, getRegisteredRepos(orchestrator), repo.path);
    } else if (diffChoice === "Last commit") {
      diffType = "last-commit";
    } else if (diffChoice === "Since commit") {
      const pickedHash = await pickCommitForRepo(orchestrator, ctx, repo);
      if (!pickedHash) continue;
      diffType = "branch";
      defaultBranch = pickedHash;
    } else {
      diffType = "uncommitted";
    }

    const result = await openCodeReviewInPlannotator(orchestrator, { cwd: repo.path, diffType, defaultBranch });

    // On error the repo is UNREVIEWED: do not advance the cursor (that would
    // silently drop it from the pass). Keep it as the current repo until the
    // user retries, explicitly skips, or stops.
    if (result.status === "error") {
      ctx.ui.notify(`${formatRepoLabel(repo)}: ERROR${result.error ? ` — ${result.error}` : ""}`, "warning");
      const errorChoice = await selectOption(ctx, `Review failed: ${formatRepoLabel(repo)}`, [
        opt("Retry", "Try reviewing this repository again"),
        opt("Skip this repo", "Leave this repository unreviewed and move on"),
        opt("Done (stop reviewing)", "Stop iterating repositories"),
      ]);
      if (!errorChoice || errorChoice === "Done (stop reviewing)") {
        task.state.plannotatorCursor = undefined;
        saveTask(task.dir, task.state);
        return null;
      }
      if (errorChoice === "Skip this repo") {
        cur.index += 1;
        saveTask(task.dir, task.state);
      }
      // Retry: leave cur.index unchanged so the loop re-reviews this repo.
      continue;
    }

    // Advance past this repo on a resolved outcome; on needs_changes the agent
    // fixes it during the turn started by the returned instruction, then the next
    // /pp resumes at the following repo.
    cur.index += 1;
    const exhausted = cur.index >= cur.repoPaths.length;

    if (result.status === "needs_changes") {
      if (exhausted) task.state.plannotatorCursor = undefined;
      setStep(orchestrator, "llm_work");
      saveTask(task.dir, task.state);
      const feedback = result.feedback ? `\n\nFeedback:\n${result.feedback}` : "";
      const more = exhausted
        ? "This was the last repo to review."
        : "After you finish, run /pp to continue Plannotator review of the remaining repositories.";
      return advanceBanner(
        `[PI-PI] Plannotator requested changes for ${formatRepoLabel(repo)}.${feedback}\n\n` +
        "Address the user's feedback. If the feedback contains questions, answer them. If it requests changes, " +
        `make the changes. Then call pp_phase_complete when done.\n\n${more}`,
      );
    }

    ctx.ui.notify(`${formatRepoLabel(repo)}: APPROVED`, "info");
    saveTask(task.dir, task.state);
  }

  // Cursor exhausted with no outstanding changes: clear it and fall back to /pp.
  task.state.plannotatorCursor = undefined;
  saveTask(task.dir, task.state);
  return null;
}

async function showReviewMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Review", [
      { title: "New", description: "Start a new review — type what to review (a branch, commit range, uncommitted changes, or a PR URL) as your first chat message" },
      { title: "Resume", description: "Resume a previously unfinished review" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "review");
      if (!modeSelection) continue;
      await orchestrator.startTask(ctx, "review", "review", undefined, undefined, modeSelection.mode);
      if (!orchestrator.active || orchestrator.active.type !== "review") return BACK;
      orchestrator.active.state.autonomousConfig = modeSelection.autonomousConfig;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return "started";
    }

    const result = await showResumeMenu(orchestrator, ctx, "review", "No paused review tasks found.");
    if (result === "started") return result;
  }
}

async function showTaskTypeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, type.charAt(0).toUpperCase() + type.slice(1), [
      { title: "New", description: "Start a new session" },
      { title: "Resume", description: "Resume a paused session" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      let mode: TaskMode | undefined;
      let autonomousConfig: AutonomousConfig | undefined;
      if (type === "debug") {
        const modeSelection = await pickModeForTaskStart(orchestrator, ctx, type);
        if (!modeSelection) continue;
        mode = modeSelection.mode;
        autonomousConfig = modeSelection.autonomousConfig;
      }
      await orchestrator.startTask(ctx, type, type, undefined, undefined, mode);
      if (orchestrator.active) {
        orchestrator.active.state.autonomousConfig = autonomousConfig;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
      return "started";
    }

    const result = await showResumeMenu(orchestrator, ctx, type, `No paused ${type} tasks found.`);
    if (result === "started") return result;
  }
}

async function showTaskMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Task", [
      { title: "Implement", description: "Want to make some changes? Research any topic or a codebase, brainstorm solutions and implement the chosen one" },
      { title: "Debug", description: "Something is broken? Investigate it. If there is an issue — brainstorm solutions and fix it" },
      { title: "Brainstorm", description: "No idea where to start? Research any topic or a codebase. If there is a problem to solve — brainstorm solutions and solve it" },
      { title: "Review", description: "Want to ensure that some commits or a GitHub PR are good to go? Review it. Even fix it yourself, if you want" },
      { title: "Quick", description: "Quick freeform task — no phases, no reviews, just work" },
      { title: "Resume", description: "Resume a previously unfinished task" },
      { title: "Back", description: "Return to the previous menu" },
    ]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "Debug") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "debug");
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Brainstorm") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "brainstorm");
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Implement") {
      const result = await showImplementMenu(orchestrator, ctx);
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Review") {
      const result = await showReviewMenu(orchestrator, ctx);
      if (result === "started") return "started";
      continue;
    }

    if (choice === "Quick") {
      await orchestrator.startTask(ctx, "quick", "quick");
      return "started";
    }

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, undefined, "No paused tasks found.");
      if (result === "started") return "started";
      continue;
    }
  }
}

// Minimal read-only path shown when loadConfig threw on session_start. It must NOT
// register or trigger normal task execution against the invalid config — it only
// helps the user locate and fix the broken config, then re-check it.
async function showConfigErrorMenu(orchestrator: Orchestrator, ctx: any): Promise<string | undefined> {
  const projectConfigPath = join(orchestrator.cwd, ".pp", "config.json");
  while (true) {
    const choice = await selectOption(
      ctx,
      `/pp — config error\n\n${orchestrator.configError}\n\nProject config: ${projectConfigPath}\nGlobal config: ${GLOBAL_CONFIG_PATH}`,
      [
        { title: "Re-check config", description: "Reload config after fixing it" },
        { title: "Doctor", description: "Run diagnostic checks" },
        { title: "Back", description: "Close this menu" },
      ],
    );
    if (!choice || choice === "Back") return undefined;

    if (choice === "Re-check config") {
      try {
        orchestrator.config = loadConfig(orchestrator.cwd);
        orchestrator.configError = null;
        // session_start skipped feature/tool/agent registration when config
        // loading failed; register them now that the config is valid so the
        // orchestration tools exist, not just the menu.
        registerFeatureToolsAndAgents(orchestrator);
        ctx.ui.notify("Config loaded successfully. Run /pp again to continue.", "info");
        return undefined;
      } catch (err: any) {
        orchestrator.configError = err.message;
        ctx.ui.notify(`Config error: ${err.message}`, "error");
        continue;
      }
    }

    if (choice === "Doctor") {
      await runDoctor(orchestrator, ctx);
      continue;
    }
  }
}

async function showNoActiveMenu(orchestrator: Orchestrator, ctx: any): Promise<string | undefined> {
  const status = getActiveTaskStatus(orchestrator.cwd, orchestrator.config.performance.internals.taskLockStale);
  const title = status.kind === "ambiguous"
    ? `/pp\n\n${status.tasks.length} paused tasks found (their locks are free). Choose Task → Resume to pick one.`
    : "/pp";
  while (true) {
    const choice = await selectOption(ctx, title, [
      { title: "Task", description: "Start a new task or resume a paused one" },
      { title: "Subagents", description: "View and manage running subagents" },
      { title: "Settings", description: "Models, agents, commands, and other configuration" },
      { title: "Back to prompt", description: "Close this menu" },
    ]);
    if (!choice || choice === "Back to prompt") return undefined;

    if (choice === "Task") {
      const result = await showTaskMenu(orchestrator, ctx);
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }

    await showSettingsMenu(orchestrator, ctx);
  }
}

function getReviewLabels(orchestrator: Orchestrator): { autoLabel: string } {
  const phase = orchestrator.active?.state.phase;
  const byPhase = (phase && orchestrator.active?.state.reviewPassByKind?.[phase]) ?? {};
  const autoCount = byPhase["auto"] ?? 0;
  const autoLabel = autoCount > 0 ? `Auto review (pass ${autoCount + 1})` : "Auto review";
  return { autoLabel };
}

function hasEnabledReviewers(orchestrator: Orchestrator, presetName?: string): boolean {
  if (!orchestrator.active) return false;
  const phase = orchestrator.active.state.phase;
  const group = getReviewPresetGroup(phase);
  const reviewers = resolvePreset(orchestrator.config, group, presetName);
  return Object.values(reviewers).some((v) => isEnabled(v));
}

function handleReviewResult(ctx: any, text: string): { continueLoop: boolean; text?: string } {
  if (text.includes("Choose another option.") || text === "Plannotator approved the plan. Choose next action.") {
    ctx.ui.notify(text, "info");
    return { continueLoop: true };
  }
  return { continueLoop: false, text };
}

async function showQuickTaskMenu(
  orchestrator: Orchestrator,
  ctx: any,
  summary: string,
  mode: MenuMode,
): Promise<string> {
  while (true) {
    if (!orchestrator.active) return "No active task.";
    const task = orchestrator.active;
    const headerLines = [`/pp\n\nTask: ${task.type}\nPhase: ${task.state.phase}`];
    if (summary !== "/pp") headerLines.push(`\n\n${summary}`);
    const menuTitle = headerLines.join("");

    const { choice, cancelReason } = await selectOptionCancelable(ctx, menuTitle, [
      opt("Complete", "Mark task as done and clean up"),
      opt("Pause", "Suspend task to resume later"),
      opt("Subagents", "View and manage running subagents"),
      opt("Settings", "Models, agents, commands, and other configuration"),
      opt("Back to prompt", "Return to the prompt and keep working"),
    ]);
    // A deliberate ESC in tool mode must stop the turn cleanly (mirror the
    // guided/autonomous branches); in command mode ESC just closes the menu.
    if (cancelReason === "user" && mode === "tool") return USER_CANCELLED;
    if (!choice || choice === "Back to prompt") return "";
    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }
    if (choice === "Settings") {
      await showSettingsMenu(orchestrator, ctx);
      continue;
    }
    if (choice === "Pause") {
      const text = await pauseTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }
    const text = await finishTask(orchestrator, ctx);
    return mode === "tool" ? text : "";
  }
}

export async function showActiveTaskMenu(
  orchestrator: Orchestrator,
  ctx: any,
  summary: string,
  mode: MenuMode = "command",
  // Display-only override for the autonomous terminal implement handoff (#1):
  // render the guided Next/Review menu even though the task is autonomous, WITHOUT
  // mutating task.state.mode. Never persisted; does not affect the footer indicator
  // or getEffectivePhaseMode.
  forceGuided = false,
): Promise<string> {
  const continueMessage = advanceBanner("[PI-PI] User wants to continue. Run /pp when ready to advance.");

  while (true) {
    if (!orchestrator.active) return "No active task.";

    const task = orchestrator.active;
    if (task.type === "quick") {
      return showQuickTaskMenu(orchestrator, ctx, summary, mode);
    }
    // Auto-resume an in-progress per-repo Plannotator review (#3a): if the agent
    // just finished fixing one repo's feedback and ran /pp, continue the loop at
    // the next repo instead of showing the top-level menu. On another
    // needs_changes this returns a fresh work instruction; when exhausted it
    // clears the cursor and falls through to the normal menu.
    if (task.state.plannotatorCursor) {
      const resumeText = await runPlannotatorCursor(orchestrator, ctx);
      if (resumeText) return resumeText;
    }
    const phase = task.state.phase;
    const step = task.state.step;
    const effectiveMode = getEffectivePhaseMode(task.state);

    // Suppress phase-advancing/review actions while a transition is in flight
    // (controller pending/compacting/resuming) OR while awaiting subagents. The
    // controller's isRunning() predicate already folds in the await_* steps.
    const waiting = !orchestrator.transitionController.isRunning();
    const { autoLabel } = getReviewLabels(orchestrator);
    const isReviewPhase = phase === "review";
    const hasPlannotator = phase === "plan" || phase === "implement" || isReviewPhase;
    // The artifact the automated reviewers scan, mirroring reviewPresetGroupForPhase:
    // brainstorm/debug → brainstormReviewers (research artifacts), plan → planReviewers
    // (synthesized plan), implement/review → codeReviewers (code changes). This is the primary
    // "Review" target named at the top level; the per-phase "Review on my own" description names
    // the manual editor pass's target separately (it can differ).
    const reviewGroup = reviewPresetGroupForPhase(phase);
    const reviewTarget = reviewGroup === "planReviewers"
      ? "the synthesized plan"
      : reviewGroup === "brainstormReviewers"
      ? "this phase's research artifacts"
      : "the code changes";

    const opt = (title: string, description: string): OptionInput => ({ title, description });

    if (effectiveMode === "autonomous" && !forceGuided) {
      const { choice: autoChoice, cancelReason } = await selectOptionCancelable(ctx, `/pp\n\nTask: ${task.type}\nPhase: ${phase}${summary !== "/pp" ? `\n\n${summary}` : ""}`, [
        opt("Complete task", "Mark task as done and clean up"),
        opt("Pause task", "Suspend task to resume later"),
        opt("Subagents", "View and manage running subagents"),
        opt("Settings", "Models, agents, commands, and other configuration"),
        opt("Back to prompt", "Return to the prompt and keep working"),
      ]);
      // A deliberate ESC only needs distinct handling in tool mode (so
      // pp_phase_complete can stop the turn); in command mode ESC just closes
      // the menu like "Back".
      if (cancelReason === "user" && mode === "tool") return USER_CANCELLED;
      if (!autoChoice || autoChoice === "Back to prompt") return "";
      if (autoChoice === "Subagents") {
        await showSubagentsMenu(ctx);
        continue;
      }
      if (autoChoice === "Settings") {
        await showSettingsMenu(orchestrator, ctx);
        continue;
      }
      if (autoChoice === "Complete task") {
        const text = await finishTask(orchestrator, ctx);
        return mode === "tool" ? text : "";
      }
      const text = await pauseTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }

    const options: OptionInput[] = [];
    options.push(opt("Next", "Complete, pause, or continue to next phase"));
    if (!waiting) {
      options.push(opt("Review", `Review ${reviewTarget}: automated reviewers${hasPlannotator ? ", Plannotator, or" : " or"} your own editor pass`));
    }
    options.push(opt("Subagents", "View and manage running subagents"));
    options.push(opt("Settings", "Models, agents, commands, and other configuration"));
    options.push(opt("Back to prompt", "Return to the prompt and keep working"));

    const headerLines = [`/pp\n\nTask: ${task.type}\nPhase: ${phase}`];
    if (summary !== "/pp") headerLines.push(`\n\n${summary}`);
    const menuTitle = headerLines.join("");
    const { choice, cancelReason } = await selectOptionCancelable(ctx, menuTitle, options);
    if (cancelReason === "user" && mode === "tool") return USER_CANCELLED;
    if (!choice || choice === "Back to prompt") {
      return "";
    }

    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }
    if (choice === "Settings") {
      await showSettingsMenu(orchestrator, ctx);
      continue;
    }
    if (mode === "command") {
      await abortCurrentWork(orchestrator, ctx);
    }

    if (choice === "Next") {
      // The Next submenu runs its own loop so that a deeper submenu's "Back"
      // (e.g. Publish) returns here rather than overshooting to the top-level menu.
      while (true) {
        const canContinue = phase !== "implement" && !waiting;
        const continueLabel = phase === "plan" ? "Continue to implement" : "Continue to plan & implement";
        const finishOptions: OptionInput[] = [];
        if (phase === "review") {
          finishOptions.push(opt("Publish", "Publish the synthesized review findings as file comments or GitHub PR comments"));
        }
        if (canContinue) {
          finishOptions.push(opt(continueLabel, "Approve and advance to the next phase"));
        }
        finishOptions.push(opt("Complete", "Mark task as done and clean up"));
        finishOptions.push(opt("Pause", "Suspend task to resume later"));
        finishOptions.push(opt("Back", "Return to the previous menu"));

        const finishChoice = await selectOption(ctx, "Next", finishOptions);
        if (!finishChoice || finishChoice === "Back") break;
        if (finishChoice === "Publish") {
          const target = await selectOption(ctx, "Publish", [
            opt("As file comments", "Insert AI_COMMENT: markers at each finding's location in the source"),
            opt("As GitHub PR comments", "Post line-anchored comments to the branch's PR from your GitHub account"),
            opt("Back", "Return to the previous menu"),
          ]);
          if (!target || target === "Back") continue;
          const guardMessage = publishGuard(task.dir);
          if (guardMessage) {
            ctx.ui.notify(guardMessage, "info");
            continue;
          }
          return target === "As file comments"
            ? publishFileCommentsBanner(task.dir)
            : publishPrCommentsBanner(task.dir);
        }
        if (finishChoice === "Pause") {
          const text = await pauseTask(orchestrator, ctx);
          return mode === "tool" ? text : "";
        }
        if (finishChoice === "Complete") {
          const text = await finishTask(orchestrator, ctx);
          return mode === "tool" ? text : "";
        }
        const next = nextPhase(task.type, phase);

        if (
          next === "plan" &&
          task.type === "brainstorm"
        ) {
          const modeSelection = await pickModeForTaskStart(orchestrator, ctx, "implement");
          if (!modeSelection) continue;
          task.state.mode = modeSelection.mode;
          task.state.effectiveMode = undefined;
          task.state.autonomousConfig = modeSelection.autonomousConfig;
          saveTask(task.dir, task.state);
        }

        // Autonomous handoff gate (#1): this guided menu only advances interactive
        // phases (brainstorm/debug/review) or guided-mode tasks. When the mode that
        // now applies is autonomous and the next phase will run without a user, no
        // question may be deferred downstream — the plan/implement phases can't ask.
        // brainstorm picks its mode just above, so task.state.mode is current here.
        if (getEffectiveMode(task.state) === "autonomous" && next && next !== "done") {
          const researchPath = join(task.dir, "RESEARCH.md");
          if (existsSync(researchPath)) {
            const unresolved = findUnresolvedOpenQuestions(readFileSync(researchPath, "utf-8"));
            if (unresolved.length > 0) {
              ctx.ui.notify(
                `Cannot advance: ${unresolved.length} open question(s) in RESEARCH.md are unresolved. ` +
                `In autonomous mode the downstream phases cannot ask the user — answer them now, or mark each ` +
                `with DECIDED:/ASSUMED: and rationale, then advance again.`,
                "error",
              );
              continue;
            }
          }
        }

        let plannerPreset: string | undefined;
        if (next === "plan") {
          if (getEffectiveMode(task.state) !== "autonomous") {
            const pickedPlannerPreset = await pickPreset(ctx, orchestrator, "planners", "Planner preset");
            if (!pickedPlannerPreset) continue;
            plannerPreset = pickedPlannerPreset;
          }
        }
        finalizeReviewCycle(task);
        const result = await orchestrator.transitionToNextPhase(ctx, plannerPreset);
        if (!result.ok) return `Transition blocked: ${result.error}`;
        // Transition is now owned by the controller (state ≠ running) or we're
        // awaiting subagents; either way the menu returns empty.
        return "";
      }
      continue;
    }

    if (choice === "Review") {
      // The Review submenu runs its own loop so a recoverable choice (no reviewers
      // enabled, preset cancelled, "Review on my own" Back, a plannotator early
      // exit) returns HERE rather than overshooting to the top-level /pp menu.
      // Only an explicit "Back" breaks out; start/wait/instruction paths return.
      while (true) {
      // A review already running: block re-entry BEFORE any finalizeReviewCycle
      // (which would null the live cycle and hide it), so we never double-spawn.
      // Notify and break back to the top-level menu with the live cycle intact
      // rather than exiting /pp.
      if (isReviewCycleLive(task)) {
        ctx.ui.notify("A review is already running", "info");
        break;
      }
      const reviewOptions: OptionInput[] = [
        opt(autoLabel, `Run configured reviewers over ${reviewTarget}`),
      ];
      const hasArtifactPlannotator = phase === "brainstorm" || phase === "debug";
      if (hasPlannotator) {
        reviewOptions.push(opt("Review in Plannotator", phase === "plan" ? "Open plan review in browser" : "Open code diff review in browser"));
      } else if (hasArtifactPlannotator) {
        reviewOptions.push(opt("Review in Plannotator", "Open USER_REQUEST.md, RESEARCH.md, and artifacts/*.md for review in browser"));
      }
      reviewOptions.push(opt("Review on my own", phase === "implement"
        ? "Mark spots in the changed files with AI_REVIEW: comments; the agent then addresses each and removes the marker"
        : phase === "plan"
          ? "Mark spots in the synthesized plan with AI_REVIEW: comments; the agent then addresses each and removes the marker"
          : "Mark spots in USER_REQUEST.md, RESEARCH.md, and artifacts/*.md with AI_REVIEW: comments; the agent then addresses each and removes the marker"));
      reviewOptions.push(opt("Back", "Return to the previous menu"));

      const reviewChoice = await selectOption(ctx, "Review", reviewOptions);
      if (!reviewChoice || reviewChoice === "Back") break;

      if (reviewChoice === "Review in Plannotator") {
        if (hasArtifactPlannotator) {
          // brainstorm/debug have no diff or plan file: review the whole artifact
          // set in one annotate-folder pass over the task dir (walks USER_REQUEST.md +
          // RESEARCH.md + artifacts/*.md recursively). The result comes back on the
          // synchronous annotate respond callback, NOT via waitForPlannotatorResult.
          const { opened, result } = await openAnnotateReview(orchestrator.pi, {
            filePath: task.dir,
            folderPath: task.dir,
            mode: "annotate-folder",
            gate: true,
          });
          if (!opened || !result) {
            ctx.ui.notify("Could not open Plannotator for review.", "error");
            continue;
          }
          if (result.approved) {
            ctx.ui.notify("Plannotator review approved. Choose next action.", "info");
            continue;
          }
          const feedback = result.feedback?.trim();
          if (feedback) {
            setStep(orchestrator, "llm_work");
            return advanceBanner(
              "[PI-PI] The user reviewed this phase's artifacts in Plannotator and left the following feedback. " +
              "Address each point, updating USER_REQUEST.md, RESEARCH.md, and artifacts/*.md as needed:\n\n" +
              feedback,
            );
          }
          continue;
        }
        if (phase === "plan") {
          finalizeReviewCycle(task);
          const text = await enterReviewCycle(orchestrator, ctx, "plannotator");
          const curStep = orchestrator.active?.state.step;
          if (curStep === "await_reviewers") return "";
          const handled = handleReviewResult(ctx, text);
          if (handled.continueLoop) continue;
          return handled.text ?? text;
        }
        const allRepos = getRegisteredRepos(orchestrator);
        const eligible: string[] = [];
        for (const repo of allRepos) {
          const base = await detectDefaultBranch(orchestrator, allRepos, repo.path);
          const { changed, error } = await repoHasReviewableChanges(orchestrator, repo, base);
          if (error || changed) eligible.push(repo.path);
        }
        if (eligible.length === 0) {
          ctx.ui.notify("No registered repositories have changes to review.", "info");
          continue;
        }
        // Start (or restart) the interleaved per-repo cursor and run it. On
        // needs_changes runPlannotatorCursor persists the cursor and returns a
        // work instruction (exits the menu to start the agent turn); the next /pp
        // resumes at the following repo.
        task.state.plannotatorCursor = { repoPaths: eligible, index: 0 };
        saveTask(task.dir, task.state);
        const cursorText = await runPlannotatorCursor(orchestrator, ctx);
        if (cursorText) return cursorText;
        continue;
      }

      if (reviewChoice === "Review on my own") {
        const gate = await selectOption(ctx, "Editor review", [
          opt("Done", "I've added AI_REVIEW: markers and saved my files"),
          opt("Skip markers", "Continue without the marker workflow"),
          opt("Back", "Return to the review menu"),
        ]);
        if (!gate || gate === "Back") continue;
        setStep(orchestrator, phase === "plan" ? "synthesize" : "llm_work");
        if (gate === "Skip markers") {
          return continueMessage;
        }
        if (phase === "implement") {
          return advanceBanner(
            "[PI-PI] The user reviewed the changes in their editor and left inline `AI_REVIEW:` markers " +
            `${AI_REVIEW_MARKER_SYNTAX}.\n\n` +
            "For each registered repo, enumerate the CHANGED files only — union of `git diff --name-only <base>...HEAD`, " +
            "`git diff --name-only`, `git diff --cached --name-only`, and untracked-non-ignored files from `git status --porcelain` " +
            "(base = each repo's configured base branch) — and search WITHIN those files for `AI_REVIEW:`. Do NOT grep the whole " +
            "worktree (avoid vendored/generated/node_modules and historical markers).\n\n" +
            AI_REVIEW_MARKER_LOOP,
          );
        }
        return readOnlyReviewBanner(phase, task.dir);
      }

      const reviewPreset = await pickPreset(ctx, orchestrator, getReviewPresetGroup(phase), "Review preset");
      if (!reviewPreset) continue;
      finalizeReviewCycle(task);
      if (!hasEnabledReviewers(orchestrator, reviewPreset)) {
        const reviewGroup = reviewPresetGroupForPhase(phase);
        const label = reviewGroup === "brainstormReviewers" ? "artifact" : reviewGroup === "planReviewers" ? "plan" : "code";
        ctx.ui.notify(`No ${label} reviewers enabled.`, "info");
        continue;
      }
      const text = await enterReviewCycle(orchestrator, ctx, reviewPreset);
      const curStep = orchestrator.active?.state.step;
      if (curStep === "await_reviewers") return "";
      const handled = handleReviewResult(ctx, text);
      if (handled.continueLoop) continue;
      return handled.text ?? text;
      }
    }
  }
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any, mode: MenuMode = "command"): Promise<string | undefined> {
  if (orchestrator.configError) {
    return showConfigErrorMenu(orchestrator, ctx);
  }
  if (!orchestrator.active) {
    return showNoActiveMenu(orchestrator, ctx);
  }
  const text = await showActiveTaskMenu(orchestrator, ctx, "/pp", mode);
  return text || undefined;
}
