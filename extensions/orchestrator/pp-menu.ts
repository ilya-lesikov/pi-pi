import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { askUser } from "../../3p/pi-ask-user/index.js";
import { unregisterAgentDefinitions } from "./agents/registry.js";
import { loadConfig } from "./config.js";
import {
  loadBrainstormReviewOutputs,
  loadCodeReviewOutputs,
  loadPlanReviewOutputs,
} from "./context.js";
import { enterReviewCycle, finalizeReviewCycle } from "./event-handlers.js";
import { Orchestrator, deepReviewConfig } from "./orchestrator.js";
import { cancelPendingPlannotatorWait } from "./plannotator.js";
import { spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { spawnBrainstormReviewers } from "./phases/brainstorm.js";
import {
  listTasks,
  loadTask,
  lockTask,
  saveTask,
  taskAge,
  taskName,
  type TaskInfo,
  type TaskType,
} from "./state.js";

type MenuMode = "command" | "tool";

const BACK = "back" as const;

type OptionInput = string | { title: string; description?: string };

async function selectOption(ctx: any, question: string, options: OptionInput[]): Promise<string | undefined> {
  const result = await askUser(ctx, {
    question,
    options,
    allowFreeform: false,
    allowComment: false,
    allowMultiple: false,
  });
  if (!result || result.kind !== "selection") return undefined;
  return result.selections[0];
}

function setStep(orchestrator: Orchestrator, step: string): void {
  if (!orchestrator.active) return;
  orchestrator.active.state.step = step;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
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

async function finishTask(orchestrator: Orchestrator, ctx: any): Promise<string> {
  if (!orchestrator.active) return "No active task.";

  cancelPendingPlannotatorWait(orchestrator);
  orchestrator.abortAllSubagents();
  ctx.abort?.();
  await ctx.waitForIdle?.();

  const name = orchestrator.active.description;
  const type = orchestrator.active.type;
  const dir = orchestrator.active.dir;

  orchestrator.taskDoneCompactionPending = true;
  orchestrator.taskDoneCompactionSummary = `Task "${name}" (${type}) completed.`;

  orchestrator.active.state.phase = "done";
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  unregisterAgentDefinitions(orchestrator.pi);
  await orchestrator.cleanupActive();

  const taskStore = (globalThis as any)[Symbol.for("pi-tasks:store")];
  taskStore?.clearAll?.();
  taskStore?.refreshWidget?.(ctx.ui);

  orchestrator.updateStatus(ctx);
  ctx.compact?.();

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

function loadPhaseReviewOutputs(taskDir: string, phase: string, pass: number): { name: string; content: string }[] {
  if (phase === "brainstorm") return loadBrainstormReviewOutputs(taskDir, pass);
  if (phase === "plan") return loadPlanReviewOutputs(taskDir);
  return loadCodeReviewOutputs(taskDir, pass);
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
    release = await lockTask(task.dir, orchestrator.config.timeouts);
  } catch {
    const staleSeconds = Math.round(orchestrator.config.timeouts.lockStale / 1000);
    const message =
      `Cannot resume: task is locked by another pi session (or a session that crashed less than ${staleSeconds}s ago). ` +
      `Wait ${staleSeconds}s for the lock to expire, or kill the other session first.`;
    ctx.ui.notify(message, "error");
    return { ok: false, error: message };
  }

  orchestrator.resetTaskScopedState();
  orchestrator.activeTaskToken++;

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

  const modelConfig = orchestrator.config.mainModel[task.type === "debug" ? "debug" : task.type === "brainstorm" ? "brainstorm" : "implement"];
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
    const enabledVariants = Object.entries(orchestrator.config.planners).filter(([, v]) => v.enabled);
    const planFiles = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"))
      : [];
    if (planFiles.length >= enabledVariants.length) {
      orchestrator.active.state.step = "synthesize";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
    } else {
      const completedVariants = new Set(planFiles.map((f) => f.replace(/^\d+_/, "").replace(/\.md$/, "")));
      const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));
      if (missingVariants.length > 0) {
        const missingConfig: Record<string, any> = {};
        for (const [name, cfg] of missingVariants) missingConfig[name] = cfg;
        const partialConfig = { ...orchestrator.config, planners: missingConfig };
        orchestrator.pendingSubagentSpawns = missingVariants.length;
        orchestrator.failedPlannerVariants = [];
        spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, partialConfig).then((result) => {
          orchestrator.failedPlannerVariants = result.failedVariants;
          if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
          for (const id of result.agentIds ?? []) {
            orchestrator.spawnedAgentIds.delete(id);
          }
          orchestrator.pendingSubagentSpawns = 0;
        }).catch((err: any) => {
          orchestrator.pendingSubagentSpawns = 0;
          console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
        });
      } else {
        orchestrator.active.state.step = "synthesize";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
      }
    }
  }

  if (orchestrator.active.state.reviewCycle) {
    const cycle = orchestrator.active.state.reviewCycle;
    const reviewConfig = cycle.kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
    const phase = orchestrator.active.state.phase;
    const reviewers = phase === "brainstorm"
      ? reviewConfig.brainstormReviewers
      : phase === "plan"
      ? reviewConfig.planReviewers
      : reviewConfig.codeReviewers;
    const reviewerCount = Object.values(reviewers).filter((v) => v.enabled).length;

    if ((cycle.kind === "auto" || cycle.kind === "auto-deep") && (cycle.step === "spawn_reviewers" || cycle.step === "await_reviewers")) {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      if (outputs.length >= reviewerCount) {
        cycle.step = "apply_feedback";
        orchestrator.active.state.step = "apply_feedback";
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
        pi.sendMessage(
          {
            customType: "pp-review-ready",
            content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
            display: false,
          },
          { deliverAs: "steer" },
        );
      } else {
        const completedVariants = new Set(
          outputs.map((o) => o.name.replace(/^\d+_/, "").replace(/_round-\d+\.md$/, "").replace(/\.md$/, "")),
        );
        const enabledVariants = Object.entries(reviewers).filter(([, v]) => v.enabled);
        const missingVariants = enabledVariants.filter(([name]) => !completedVariants.has(name));

        if (missingVariants.length === 0) {
          cycle.step = "apply_feedback";
          orchestrator.active.state.step = "apply_feedback";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
          const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
          pi.sendMessage(
            {
              customType: "pp-review-ready",
              content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
              display: false,
            },
            { deliverAs: "steer" },
          );
        } else {
          const missingReviewerConfig: Record<string, any> = {};
          for (const [name, cfg] of missingVariants) missingReviewerConfig[name] = cfg;
          const partialConfig = phase === "brainstorm"
            ? { ...reviewConfig, brainstormReviewers: missingReviewerConfig }
            : phase === "plan"
            ? { ...reviewConfig, planReviewers: missingReviewerConfig }
            : { ...reviewConfig, codeReviewers: missingReviewerConfig };
          orchestrator.pendingSubagentSpawns = missingVariants.length;
          const spawnFn = phase === "brainstorm"
            ? () => spawnBrainstormReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig, cycle.pass)
            : phase === "plan"
            ? () => spawnPlanReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig)
            : () => spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active!.dir, orchestrator.active!.taskId, partialConfig, cycle.pass);
          orchestrator.failedReviewerVariants = [];
          spawnFn().then((result) => {
            orchestrator.failedReviewerVariants = result.failedVariants;
            if (result.spawned === 0) orchestrator.pendingSubagentSpawns = 0;
            for (const id of result.agentIds ?? []) {
              orchestrator.spawnedAgentIds.delete(id);
            }
            orchestrator.pendingSubagentSpawns = 0;
          }).catch((err: any) => {
            orchestrator.pendingSubagentSpawns = 0;
            console.error(`[pi-pi] spawn reviewers failed: ${err.message}`);
          });
          cycle.step = "await_reviewers";
          orchestrator.active.state.step = "await_reviewers";
          saveTask(orchestrator.active.dir, orchestrator.active.state);
        }
      }
    } else if (cycle.step === "apply_feedback") {
      const outputs = loadPhaseReviewOutputs(orchestrator.active.dir, phase, cycle.pass);
      const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
      pi.sendMessage(
        {
          customType: "pp-review-ready",
          content: `[PI-PI] Review cycle is in apply_feedback step.\n\n${rendered}`,
          display: false,
        },
        { deliverAs: "steer" },
      );
    }
  }

  const step = orchestrator.active.state.step;
  if (step === "await_planners" || step === "await_reviewers") {
    ctx.ui.notify(`Resumed task. Awaiting subagents (${step}).`, "info");
  } else if (step === "apply_feedback") {
    pi.sendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Read reviewer outputs and apply feedback.`);
  } else {
    pi.sendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Continue working.`);
  }

  return { ok: true };
}

function listCompletedFromTasks(cwd: string): TaskInfo[] {
  const paused = new Set<string>([
    ...listTasks(cwd, "brainstorm").map((t) => t.dir),
    ...listTasks(cwd, "debug").map((t) => t.dir),
  ]);
  const results: TaskInfo[] = [];

  for (const type of ["brainstorm", "debug"] as TaskType[]) {
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
  const api = (globalThis as any)[Symbol.for("pi-subagents:menu")] as { showMenu?: (menuCtx: any) => Promise<void> } | undefined;
  if (!api?.showMenu) {
    ctx.ui.notify("Subagents menu API is not available.", "warning");
    return;
  }
  await api.showMenu(ctx);
}

async function showLspMenu(ctx: any): Promise<typeof BACK> {
  while (true) {
    const choice = await selectOption(ctx, "LSP", ["Status", "Restart", "Back"]);
    if (!choice || choice === "Back") return BACK;

    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as {
      status?: (menuCtx: any) => Promise<void>;
      restart?: (menuCtx: any) => Promise<void>;
    } | undefined;

    if (!api?.status || !api?.restart) {
      ctx.ui.notify("LSP API is not available.", "warning");
      continue;
    }

    if (choice === "Status") {
      await api.status(ctx);
      continue;
    }

    await api.restart(ctx);
  }
}

async function promptDescription(ctx: any, prompt: string, fallback: string): Promise<string | undefined> {
  const value = await ctx.ui.input(prompt);
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function resumeOptionTitle(t: TaskInfo): string {
  return taskName(t.dir);
}

function resumeOptionDescription(t: TaskInfo): string {
  const age = taskAge(t.state);
  const phase = t.state.phase === t.type ? t.type : `${t.type}/${t.state.phase}`;
  return `${phase}, ${age}`;
}

async function showResumeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType | undefined,
  emptyMessage: string,
): Promise<typeof BACK | "started"> {
  while (true) {
    const tasks = listTasks(orchestrator.cwd, type);
    if (tasks.length === 0) {
      ctx.ui.notify(emptyMessage, "info");
      return BACK;
    }

    const options: OptionInput[] = tasks.map((t) => ({
      title: resumeOptionTitle(t),
      description: resumeOptionDescription(t),
    }));
    options.push("Back");

    const choice = await selectOption(ctx, "Resume", options);
    if (!choice || choice === "Back") return BACK;

    const task = tasks.find((t) => resumeOptionTitle(t) === choice);
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
      ctx.ui.notify("No completed brainstorm/debug tasks with artifacts found.", "info");
      return BACK;
    }

    const options: OptionInput[] = tasks.map((t) => ({
      title: fromOptionTitle(t),
      description: fromOptionDescription(t, orchestrator.cwd),
    }));
    options.push("Back");

    const choice = await selectOption(ctx, "From", options);
    if (!choice || choice === "Back") return BACK;

    const selected = tasks.find((t) => fromOptionTitle(t) === choice);
    if (!selected) continue;

    const description = await promptDescription(ctx, "Describe the task", "implement");
    if (!description) continue;

    await orchestrator.startTask(ctx, "implement", description, selected.dir, true);
    return "started";
  }
}

async function showImplementMenu(orchestrator: Orchestrator, ctx: any): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, "Implement", ["New", "From", "Resume", "Back"]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const description = await promptDescription(ctx, "Describe the task", "implement");
      if (!description) continue;
      await orchestrator.startTask(ctx, "implement", description);
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

async function showTaskTypeMenu(
  orchestrator: Orchestrator,
  ctx: any,
  type: TaskType,
  inputPrompt: string,
): Promise<typeof BACK | "started"> {
  while (true) {
    const choice = await selectOption(ctx, type.charAt(0).toUpperCase() + type.slice(1), ["New", "Resume", "Back"]);
    if (!choice || choice === "Back") return BACK;

    if (choice === "New") {
      const description = await promptDescription(ctx, inputPrompt, type);
      if (!description) continue;
      await orchestrator.startTask(ctx, type, description);
      return "started";
    }

    const result = await showResumeMenu(orchestrator, ctx, type, `No paused ${type} tasks found.`);
    if (result === "started") return result;
  }
}

async function showNoActiveMenu(orchestrator: Orchestrator, ctx: any): Promise<string | undefined> {
  while (true) {
    const choice = await selectOption(ctx, "/pp", [
      { title: "Debug", description: "Diagnose an issue. Then (optionally) fix it" },
      { title: "Brainstorm", description: "Explore and brainstorm. Then (optionally) plan and implement" },
      { title: "Implement", description: "Brainstorm, plan and implement" },
      { title: "Resume", description: "Resume a previously unfinished task" },
      "Subagents",
      "LSP",
    ]);
    if (!choice) return undefined;

    if (choice === "Debug") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "debug", "Describe the task");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Brainstorm") {
      const result = await showTaskTypeMenu(orchestrator, ctx, "brainstorm", "Describe the task");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Implement") {
      const result = await showImplementMenu(orchestrator, ctx);
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Resume") {
      const result = await showResumeMenu(orchestrator, ctx, undefined, "No paused tasks found.");
      if (result === "started") return undefined;
      continue;
    }

    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }

    await showLspMenu(ctx);
  }
}

function getReviewLabels(orchestrator: Orchestrator): { autoLabel: string; deepLabel: string } {
  const byKind = orchestrator.active?.state.reviewPassByKind ?? {};
  const autoCount = byKind["auto"] ?? 0;
  const deepCount = byKind["auto-deep"] ?? 0;
  const autoLabel = autoCount > 0 ? `Review (pass ${autoCount + 1})` : "Review";
  const deepLabel = deepCount > 0 ? `Deep review (pass ${deepCount + 1})` : "Deep review";
  return { autoLabel, deepLabel };
}

function hasEnabledReviewers(orchestrator: Orchestrator, kind: "auto" | "auto-deep"): boolean {
  if (!orchestrator.active) return false;
  const phase = orchestrator.active.state.phase;
  const config = kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
  const reviewers = phase === "brainstorm"
    ? config.brainstormReviewers
    : phase === "plan"
    ? config.planReviewers
    : config.codeReviewers;
  return Object.values(reviewers).some((v) => v.enabled);
}

function handleReviewResult(ctx: any, text: string): { continueLoop: boolean; text?: string } {
  if (text.includes("Choose another option.") || text === "Plannotator approved the plan. Choose next action.") {
    ctx.ui.notify(text, "info");
    return { continueLoop: true };
  }
  return { continueLoop: false, text };
}

export async function showActiveTaskMenu(
  orchestrator: Orchestrator,
  ctx: any,
  summary: string,
  mode: MenuMode = "command",
): Promise<string> {
  const continueMessage = "User wants to continue. Run /pp when ready to advance.";

  while (true) {
    if (!orchestrator.active) return "No active task.";

    const task = orchestrator.active;
    const phase = task.state.phase;
    const step = task.state.step;

    const waiting = step === "await_planners" || step === "await_reviewers";
    const { autoLabel, deepLabel } = getReviewLabels(orchestrator);

    const options = waiting
      ? ["Status", "Finish", "Subagents", "LSP"]
      : phase === "brainstorm" && task.type === "implement"
      ? ["Approve brainstorm", autoLabel, deepLabel, "Continue brainstorming", "Status", "Finish", "Subagents", "LSP"]
      : phase === "brainstorm" && task.type === "brainstorm"
      ? ["Approve brainstorm", autoLabel, deepLabel, "Continue brainstorming", "Finish brainstorming", "Status", "Finish", "Subagents", "LSP"]
      : phase === "debug"
      ? ["Approve debug", autoLabel, deepLabel, "Continue debugging", "Finish debugging", "Status", "Finish", "Subagents", "LSP"]
      : phase === "plan"
      ? [
        "Approve plan",
        autoLabel,
        deepLabel,
        "Review in Plannotator",
        "Review on my own",
        "Continue planning",
        "Status",
        "Finish",
        "Subagents",
        "LSP",
      ]
      : phase === "implement"
      ? [
        "Approve implementation",
        autoLabel,
        deepLabel,
        "Review in Plannotator",
        "Review on my own",
        "Continue implementation",
        "Status",
        "Finish",
        "Subagents",
        "LSP",
      ]
      : ["Status", "Finish", "Subagents", "LSP"];

    const choice = await selectOption(ctx, summary, options);
    if (!choice) return mode === "tool" ? "No action selected." : "";

    if (choice === "Status") {
      showStatus(orchestrator, ctx);
      continue;
    }
    if (choice === "Subagents") {
      await showSubagentsMenu(ctx);
      continue;
    }
    if (choice === "LSP") {
      await showLspMenu(ctx);
      continue;
    }
    if (choice === "Finish") {
      const text = await finishTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }

    finalizeReviewCycle(task);

    if (choice === "Approve brainstorm" || choice === "Approve debug" || choice === "Approve plan" || choice === "Approve implementation") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      if (!result.ok) return `Transition blocked: ${result.error}`;
      const step = orchestrator.active?.state.step;
      if (step === "await_planners" || step === "await_reviewers") return "";
      if (choice === "Approve implementation") return "Implementation approved. Task completed.";
      return "";
    }

    if (choice === autoLabel || choice === deepLabel || choice === "Review in Plannotator") {
      const kind = choice === autoLabel ? "auto" as const : choice === deepLabel ? "auto-deep" as const : "plannotator" as const;
      if (kind !== "plannotator" && !hasEnabledReviewers(orchestrator, kind)) {
        const label = phase === "brainstorm" ? "brainstorm" : phase === "plan" ? "plan" : "code";
        ctx.ui.notify(`No ${label} reviewers enabled.`, "info");
        continue;
      }
      const text = await enterReviewCycle(orchestrator, ctx, kind);
      const step = orchestrator.active?.state.step;
      if (step === "await_reviewers") return "";
      const handled = handleReviewResult(ctx, text);
      if (handled.continueLoop) continue;
      return handled.text ?? text;
    }

    if (choice === "Review on my own") {
      if (phase === "plan") {
        setStep(orchestrator, "synthesize");
      } else {
        setStep(orchestrator, "llm_work");
      }
      return continueMessage;
    }

    if (choice === "Continue brainstorming" || choice === "Continue debugging" || choice === "Continue implementation") {
      setStep(orchestrator, "llm_work");
      return continueMessage;
    }

    if (choice === "Continue planning") {
      setStep(orchestrator, "synthesize");
      return continueMessage;
    }

    if (choice === "Finish brainstorming" || choice === "Finish debugging") {
      const text = await finishTask(orchestrator, ctx);
      return mode === "tool" ? text : "";
    }
  }
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any, mode: MenuMode = "command"): Promise<string | undefined> {
  if (!orchestrator.active) {
    return showNoActiveMenu(orchestrator, ctx);
  }
  const text = await showActiveTaskMenu(orchestrator, ctx, "Choose next action", mode);
  return text || undefined;
}
