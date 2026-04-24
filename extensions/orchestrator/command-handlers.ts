import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function openPlannotator(pi: ExtensionAPI, action: string, payload: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let handled = false;
    pi.events.emit("plannotator:request", {
      requestId: crypto.randomUUID(),
      action,
      payload,
      respond: (response: any) => {
        handled = true;
        resolve(response.status === "handled");
      },
    });
    setTimeout(() => { if (!handled) resolve(false); }, 5000);
  });
}

function waitForPlannotatorResult(pi: ExtensionAPI): Promise<{ approved: boolean; feedback?: string }> {
  return new Promise((resolve) => {
    const unsub = pi.events.on("plannotator:review-result", (data: any) => {
      unsub();
      resolve({ approved: !!data?.approved, feedback: data?.feedback });
    });
  });
}
import { loadConfig } from "./config.js";
import { runAfterImplement } from "./commands.js";
import { unregisterAgentDefinitions } from "./agents/registry.js";
import { spawnPlanners } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { validateExitCriteria, nextPhase } from "./phases/machine.js";
import { getLatestSynthesizedPlan } from "./context.js";
import {
  saveTask,
  listTasks,
  lockTask,
  taskName,
  taskAge,
  validateFromPath,
} from "./state.js";
import { Orchestrator, deepReviewConfig } from "./orchestrator.js";

export function registerCommandHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerCommand("pp:implement", {
    description: "Start implementation workflow: brainstorm → planning → implementation → review",
    handler: async (args, ctx) => {
      let fromTaskDir: string | undefined;
      let skipBrainstorm = false;
      let description = (args ?? "").trim();

      const fromMatch = description.match(/--from\s+(\S+)/);
      if (fromMatch) {
        const fromPath = fromMatch[1];
        description = description.replace(/--from\s+\S+/, "").trim();

        const validation = validateFromPath(orchestrator.cwd, fromPath);
        if (!validation.ok) {
          ctx.ui.notify(validation.reason, "error");
          return;
        }
        fromTaskDir = validation.dir;

        if (fromPath.startsWith("debug/")) {
          skipBrainstorm = true;
        }
      }

      if (!description) description = "implement";

      await orchestrator.startTask(ctx, "implement", description, fromTaskDir, skipBrainstorm);
    },
  });

  pi.registerCommand("pp:debug", {
    description: "Start read-only diagnosis: analyze a problem and produce fix recommendations",
    handler: async (args, ctx) => {
      const description = (args ?? "").trim() || "debug";
      await orchestrator.startTask(ctx, "debug", description);
    },
  });

  pi.registerCommand("pp:brainstorm", {
    description: "Start open-ended brainstorming conversation",
    handler: async (args, ctx) => {
      const description = (args ?? "").trim() || "brainstorm";
      await orchestrator.startTask(ctx, "brainstorm", description);
    },
  });

  pi.registerCommand("pp:done", {
    description: "Mark current task as done and release lock",
    handler: async (_args, ctx) => {
      if (!orchestrator.active) {
        ctx.ui.notify("No active task.", "info");
        return;
      }

      orchestrator.abortAllSubagents();
      ctx.abort();
      await ctx.waitForIdle();

      const name = orchestrator.active.description;
      const type = orchestrator.active.type;
      const dir = orchestrator.active.dir;

      orchestrator.active.state.phase = "done";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      unregisterAgentDefinitions(pi);
      await orchestrator.cleanupActive();

      orchestrator.updateStatus(ctx);

      const urExists = existsSync(join(dir, "USER_REQUEST.md"));
      const resExists = existsSync(join(dir, "RESEARCH.md"));

      if ((type === "brainstorm" || type === "debug") && urExists && resExists) {
        const taskRelPath = relative(join(orchestrator.cwd, ".pp", "state"), dir);
        ctx.ui.notify(
          `Task "${name}" completed. Artifacts saved.\nTo continue: /pp:implement --from ${taskRelPath} <description>`,
          "info",
        );
      } else {
        ctx.ui.notify(`Task "${name}" completed.`, "info");
      }
    },
  });

  pi.registerCommand("pp:resume", {
    description: "Resume a paused task",
    handler: async (_args, ctx) => {
      if (orchestrator.active) {
        ctx.ui.notify(`Task "${orchestrator.active.description}" is already active. Run /pp:done first.`, "warning");
        return;
      }

      const PAGE_SIZE = 10;
      const allTasks = listTasks(orchestrator.cwd);
      if (allTasks.length === 0) {
        ctx.ui.notify("No paused tasks found.", "info");
        return;
      }

      let choice: string | undefined;
      let page = 0;
      const totalPages = Math.ceil(allTasks.length / PAGE_SIZE);

      while (!choice) {
        const start = page * PAGE_SIZE;
        const pageTasks = allTasks.slice(start, start + PAGE_SIZE);

        const options = pageTasks.map((t) => {
          const name = taskName(t.dir);
          const age = taskAge(t.state);
          return `${t.type}/${name} — ${t.state.phase} (${age} old)`;
        });

        if (totalPages > 1) {
          if (page < totalPages - 1) options.push("→ Next page");
          if (page > 0) options.push("← Previous page");
        }

        const header = totalPages > 1
          ? `Select task to resume (page ${page + 1}/${totalPages})`
          : "Select task to resume";

        const selected = await ctx.ui.select(header, options);
        if (!selected) return;

        if (selected === "→ Next page") { page++; continue; }
        if (selected === "← Previous page") { page--; continue; }

        choice = selected;
      }
      if (!choice) return;

      const task = allTasks.find((t) => {
        const name = taskName(t.dir);
        const age = taskAge(t.state);
        return choice === `${t.type}/${name} — ${t.state.phase} (${age} old)`;
      });
      if (!task) return;

      try {
        orchestrator.config = loadConfig(orchestrator.cwd);
      } catch (err: any) {
        ctx.ui.notify(`Config error: ${err.message}`, "error");
        return;
      }

      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockTask(task.dir, orchestrator.config.timeouts);
      } catch (err: any) {
        ctx.ui.notify(`Failed to lock task: ${err.message}`, "error");
        return;
      }

      const reviewRound = task.state.reviewRound ?? 1;
      orchestrator.active = {
        dir: task.dir,
        type: task.type,
        state: task.state,
        release,
        taskId: orchestrator.taskIdFromDir(task.dir),
        modifiedFiles: new Set(),
        reviewRound,
        description: task.state.description,
      };

      const modelConfig = orchestrator.config.mainModel[task.type === "debug" ? "debug" : task.type === "brainstorm" ? "brainstorm" : "implement"];
      const modelOk = await orchestrator.switchModel(ctx, modelConfig.model, modelConfig.thinking);
      if (!modelOk) {
        ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
      }

      orchestrator.registerAgents();
      pi.setSessionName(orchestrator.active.description.slice(0, 50));
      orchestrator.updateStatus(ctx);

      orchestrator.injectContextAndArtifacts(orchestrator.active.dir, orchestrator.active.state.phase);
      pi.sendUserMessage(`[PI-PI] Resumed ${orchestrator.active.state.phase} phase. Continue working.`);

      if (orchestrator.active.state.phase === "planning") {
        const plansDir = join(orchestrator.active.dir, "plans");
        const hasPlans = existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
        if (!hasPlans) {
          orchestrator.pendingSubagentSpawns = Object.values(orchestrator.config.planners).filter((v) => v.enabled).length;
          spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config).catch((err: any) => {
            orchestrator.pendingSubagentSpawns = 0;
            console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
          });
        }
      }

      if (orchestrator.active.state.phase === "review") {
        const reviewsDir = join(orchestrator.active.dir, "reviews");
        const hasReviews = existsSync(reviewsDir) && readdirSync(reviewsDir).some((f) => f.endsWith(".md"));

        const options = [
          "Normal auto-review",
          "Deep auto-review (higher reasoning)",
          "Manual review only",
        ];
        if (hasReviews) {
          options.unshift("Continue with existing reviews");
        }

        const reviewChoice = await ctx.ui.select("Review mode", options);

        if (reviewChoice === "Continue with existing reviews") {
          // Don't spawn new reviewers — agent will synthesize existing outputs
        } else if (reviewChoice !== "Manual review only") {
          const deep = reviewChoice === "Deep auto-review (higher reasoning)";
          const reviewConfig = deep ? deepReviewConfig(orchestrator.config) : orchestrator.config;
          orchestrator.pendingSubagentSpawns = Object.values(reviewConfig.codeReviewers).filter((v) => v.enabled).length;
          spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err: any) => {
            orchestrator.pendingSubagentSpawns = 0;
            console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
          });
        }
      }
    },
  });

  pi.registerCommand("pp:status", {
    description: "Show current task status",
    handler: async (_args, ctx) => {
      if (!orchestrator.active) {
        ctx.ui.notify("No active task.", "info");
        return;
      }
      const roundInfo = orchestrator.active.type === "implement" && orchestrator.active.state.phase === "review"
        ? ` | Review round: ${orchestrator.active.reviewRound}`
        : "";
      ctx.ui.notify(
        `Type: ${orchestrator.active.type} | Phase: ${orchestrator.active.state.phase} | Task: ${orchestrator.active.description} | Age: ${taskAge(orchestrator.active.state)}${roundInfo} | Dir: ${orchestrator.active.dir}`,
        "info",
      );
    },
  });

  async function transitionToNextPhase(ctx: any): Promise<{ ok: boolean; error?: string }> {
    if (!orchestrator.active) return { ok: false, error: "No active task." };

    const currentPhase = orchestrator.active.state.phase;
    if (currentPhase === "done") return { ok: false, error: "Task is already done." };

    const exitCheck = validateExitCriteria(orchestrator.active.dir, orchestrator.active.type, currentPhase);
    if (!exitCheck.ok) {
      pi.sendUserMessage(`Phase transition blocked: ${exitCheck.reason}. Please address this before advancing.`);
      return { ok: false, error: exitCheck.reason };
    }

    const next = nextPhase(orchestrator.active.type, currentPhase);
    if (!next) return { ok: false, error: "No next phase available." };

    if (currentPhase === "implementation") {
      const afterResults = runAfterImplement(orchestrator.config, orchestrator.cwd);
      const failures = afterResults.filter((r) => !r.ok);
      if (failures.length > 0) {
        const failureText = failures.map((f) => `${f.command}: ${f.output}`).join("\n");
        ctx.ui.notify(`afterImplement commands failed:\n${failureText}`, "error");
        pi.sendUserMessage(`afterImplement failed:\n${failureText}\n\nFix these issues before advancing.`);
        return { ok: false, error: "afterImplement commands failed" };
      }
    }

    orchestrator.active.state.phase = next;
    saveTask(orchestrator.active.dir, orchestrator.active.state);

    if (next === "done") {
      orchestrator.abortAllSubagents();
      unregisterAgentDefinitions(pi);
      await orchestrator.cleanupActive();
      orchestrator.updateStatus(ctx);
      ctx.ui.notify("Task completed!", "info");
      return { ok: true };
    }

    orchestrator.updateStatus(ctx);
    orchestrator.updatePhaseTasks();

    if (next === "review") {
      const reviewChoice = await ctx.ui.select("Review mode", [
        "Normal auto-review",
        "Deep auto-review (higher reasoning)",
        "Manual review only",
      ]);

      orchestrator.manualReview = reviewChoice === "Manual review only";

      if (!orchestrator.manualReview) {
        const deep = reviewChoice === "Deep auto-review (higher reasoning)";
        const reviewConfig = deep ? deepReviewConfig(orchestrator.config) : orchestrator.config;
        orchestrator.pendingSubagentSpawns = Object.values(reviewConfig.codeReviewers).filter((v) => v.enabled).length;
        spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err) => {
          orchestrator.pendingSubagentSpawns = 0;
          console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
        });
      }
    }

    orchestrator.compactAndTransition(ctx, orchestrator.active.dir, orchestrator.active.state.phase);

    if (next === "planning") {
      orchestrator.pendingSubagentSpawns = Object.values(orchestrator.config.planners).filter((v) => v.enabled).length;
      spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config).catch((err) => {
        orchestrator.pendingSubagentSpawns = 0;
        console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
      });
    }

    return { ok: true };
  }

  orchestrator.transitionToNextPhase = transitionToNextPhase;

  pi.registerCommand("pp:next", {
    description: "Validate exit criteria and transition to next phase",
    handler: async (_args, ctx) => {
      if (!orchestrator.active) {
        ctx.ui.notify("No active task.", "error");
        return;
      }

      const currentPhase = orchestrator.active.state.phase;

      if (currentPhase === "planning") {
        const approved = await ctx.ui.confirm("Approve plan?", "The synthesized plan will be used for implementation.");
        if (!approved) {
          ctx.ui.notify("Plan not approved. Continue editing.", "info");
          return;
        }
      }

      if (currentPhase === "review") {
        const reviewChoice = await ctx.ui.select("Review result", [
          "Approve & finish",
          "Another review round",
          "Deep review round",
          "Continue with manual review",
        ]);

        if (reviewChoice === "Another review round" || reviewChoice === "Deep review round") {
          orchestrator.active.reviewRound++;
          orchestrator.persistReviewRound();
          const reviewConfig = reviewChoice === "Deep review round" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
          orchestrator.pendingSubagentSpawns = Object.values(reviewConfig.codeReviewers).filter((v) => v.enabled).length;
          spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err) => {
            orchestrator.pendingSubagentSpawns = 0;
            console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
          });
          ctx.ui.notify(`Starting review round ${orchestrator.active.reviewRound}${reviewChoice === "Deep review round" ? " (deep)" : ""}`, "info");
          return;
        }

        if (reviewChoice === "Continue with manual review") {
          ctx.ui.notify("Continue with manual review.", "info");
          return;
        }
      }

      const result = await transitionToNextPhase(ctx);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? "Transition failed.", "error");
      }
    },
  });

  pi.registerCommand("pp:review-plan", {
    description: "Open the synthesized plan in Plannotator for visual review (blocks until review completes)",
    handler: async (_args, ctx) => {
      if (!orchestrator.active) {
        ctx.ui.notify("No active task", "warning");
        return;
      }

      const planContent = getLatestSynthesizedPlan(orchestrator.active.dir);
      if (!planContent) {
        ctx.ui.notify("No synthesized plan found", "warning");
        return;
      }

      const opened = await openPlannotator(pi, "plan-review", {
        planContent,
        planFilePath: join(orchestrator.active.dir, "plans"),
      });
      if (!opened) {
        ctx.ui.notify("Plannotator not responding — is the extension installed?", "error");
        return;
      }

      ctx.ui.notify("Plan review opened in browser. Waiting for result...", "info");
      const result = await waitForPlannotatorResult(pi);

      if (result.approved) {
        pi.sendMessage(
          { customType: "pp-plannotator-result", content: "[Plannotator] Plan APPROVED.", display: false },
          { deliverAs: "steer" },
        );
      } else {
        const feedback = result.feedback ? `\n\nFeedback:\n${result.feedback}` : "";
        pi.sendMessage(
          { customType: "pp-plannotator-result", content: `[Plannotator] Plan DENIED.${feedback}`, display: false },
          { deliverAs: "steer" },
        );
      }
    },
  });

  pi.registerCommand("pp:review-code", {
    description: "Open code changes in Plannotator for visual review (blocks until review completes)",
    handler: async (_args, ctx) => {
      const opened = await openPlannotator(pi, "code-review", {
        cwd: orchestrator.cwd,
        diffType: "branch",
      });
      if (!opened) {
        ctx.ui.notify("Plannotator not responding — is the extension installed?", "error");
        return;
      }

      ctx.ui.notify("Code review opened in browser. Waiting for result...", "info");
      const result = await waitForPlannotatorResult(pi);

      if (result.approved) {
        pi.sendMessage(
          { customType: "pp-plannotator-result", content: "[Plannotator] Code review APPROVED.", display: false },
          { deliverAs: "steer" },
        );
      } else {
        const feedback = result.feedback ? `\n\nFeedback:\n${result.feedback}` : "";
        pi.sendMessage(
          { customType: "pp-plannotator-result", content: `[Plannotator] Code review DENIED.${feedback}`, display: false },
          { deliverAs: "steer" },
        );
      }
    },
  });
}
