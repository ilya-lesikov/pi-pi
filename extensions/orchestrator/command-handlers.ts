import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
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
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pp:implement <task description> [--from <task-path>]", "warning");
        return;
      }

      let fromTaskDir: string | undefined;
      let skipBrainstorm = false;
      let description = args.trim();

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

      await orchestrator.startTask(ctx, "implement", description, fromTaskDir, skipBrainstorm);
    },
  });

  pi.registerCommand("pp:debug", {
    description: "Start read-only diagnosis: analyze a problem and produce fix recommendations",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pp:debug <problem description>", "warning");
        return;
      }
      await orchestrator.startTask(ctx, "debug", args.trim());
    },
  });

  pi.registerCommand("pp:brainstorm", {
    description: "Start open-ended brainstorming conversation",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pp:brainstorm <topic>", "warning");
        return;
      }
      await orchestrator.startTask(ctx, "brainstorm", args.trim());
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

      const tasks = listTasks(orchestrator.cwd);
      if (tasks.length === 0) {
        ctx.ui.notify("No paused tasks found.", "info");
        return;
      }

      const options = tasks.map((t) => {
        const name = taskName(t.dir);
        const age = taskAge(t.state);
        return `${t.type}/${name} — ${t.state.phase} (${age} old)`;
      });

      const choice = await ctx.ui.select("Select task to resume", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      if (idx < 0) return;

      const task = tasks[idx];

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
      pi.sendUserMessage(orchestrator.getPhasePrompt(ctx));

      if (orchestrator.active.state.phase === "planning") {
        spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config).catch((err: any) => {
          console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
        });
      }

      if (orchestrator.active.state.phase === "review") {
        const reviewChoice = await ctx.ui.select("Review mode", [
          "Normal auto-review",
          "Deep auto-review (higher reasoning)",
          "Manual review only",
        ]);

        if (reviewChoice !== "Manual review only") {
          const deep = reviewChoice === "Deep auto-review (higher reasoning)";
          const reviewConfig = deep ? deepReviewConfig(orchestrator.config) : orchestrator.config;
          spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err: any) => {
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
        ? ` | Review round: ${orchestrator.active.reviewRound}/${orchestrator.config.maxAutoReviewRounds}`
        : "";
      ctx.ui.notify(
        `Type: ${orchestrator.active.type} | Phase: ${orchestrator.active.state.phase} | Task: ${orchestrator.active.description} | Age: ${taskAge(orchestrator.active.state)}${roundInfo} | Dir: ${orchestrator.active.dir}`,
        "info",
      );
    },
  });

  pi.registerCommand("pp:next", {
    description: "Validate exit criteria and transition to next phase",
    handler: async (_args, ctx) => {
      if (!orchestrator.active) {
        ctx.ui.notify("No active task.", "error");
        return;
      }

      const currentPhase = orchestrator.active.state.phase;
      if (currentPhase === "done") {
        ctx.ui.notify("Task is already done.", "info");
        return;
      }

      const exitCheck = validateExitCriteria(orchestrator.active.dir, orchestrator.active.type, currentPhase);
      if (!exitCheck.ok) {
        ctx.ui.notify(`Cannot advance: ${exitCheck.reason}`, "warning");
        pi.sendUserMessage(`/pp:next failed: ${exitCheck.reason}. Please address this before advancing.`);
        return;
      }

      const next = nextPhase(orchestrator.active.type, currentPhase);
      if (!next) {
        ctx.ui.notify("No next phase available.", "error");
        return;
      }

      if (currentPhase === "planning") {
        const approved = await ctx.ui.confirm("Approve plan?", "The synthesized plan will be used for implementation.");
        if (!approved) {
          ctx.ui.notify("Plan not approved. Continue editing.", "info");
          return;
        }
      }

      if (currentPhase === "review") {
        const approved = await ctx.ui.confirm("Approve implementation?", "Mark the task as done?");
        if (!approved) {
          if (orchestrator.active.reviewRound > orchestrator.config.maxAutoReviewRounds) {
            ctx.ui.notify(
              `Auto-review round limit reached (${orchestrator.config.maxAutoReviewRounds}). Continue with manual review.`,
              "warning",
            );
            return;
          }

          const startNewRound = await ctx.ui.confirm(
            "Start another auto-review round?",
            `Round ${orchestrator.active.reviewRound} of ${orchestrator.config.maxAutoReviewRounds} max.`,
          );
          if (!startNewRound) {
            ctx.ui.notify("Continue with manual review.", "info");
            return;
          }

          spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config, orchestrator.active.reviewRound).catch((err) => {
            console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
          });
          orchestrator.active.reviewRound++;
          orchestrator.persistReviewRound();
          return;
        }
      }

      if (currentPhase === "implementation") {
        const afterResults = runAfterImplement(orchestrator.config, orchestrator.cwd);
        const failures = afterResults.filter((r) => !r.ok);
        if (failures.length > 0) {
          const failureText = failures.map((f) => `${f.command}: ${f.output}`).join("\n");
          ctx.ui.notify(`afterImplement commands failed:\n${failureText}`, "error");
          pi.sendUserMessage(`afterImplement failed:\n${failureText}\n\nFix these issues before advancing.`);
          return;
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
        return;
      }

      orchestrator.updateStatus(ctx);
      orchestrator.updatePhaseTasks();
      orchestrator.compactAndTransition(ctx, orchestrator.active.dir, orchestrator.active.state.phase);

      if (next === "planning") {
        spawnPlanners(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, orchestrator.config).catch((err) => {
          console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
        });
      }

      if (next === "review") {
        const reviewChoice = await ctx.ui.select("Review mode", [
          "Normal auto-review",
          "Deep auto-review (higher reasoning)",
          "Manual review only",
        ]);

        if (reviewChoice !== "Manual review only") {
          if (orchestrator.active.reviewRound > orchestrator.config.maxAutoReviewRounds) {
            ctx.ui.notify(
              `Auto-review round limit reached (${orchestrator.config.maxAutoReviewRounds}). Switching to manual review.`,
              "warning",
            );
          } else {
            const deep = reviewChoice === "Deep auto-review (higher reasoning)";
            const reviewConfig = deep ? deepReviewConfig(orchestrator.config) : orchestrator.config;
            spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err) => {
              console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
            });
            orchestrator.active.reviewRound++;
            orchestrator.persistReviewRound();
          }
        }
      }
    },
  });

  pi.registerCommand("pp:review-plan", {
    description: "Open the synthesized plan in Plannotator browser UI for visual review",
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

      let handled = false;
      const requestId = crypto.randomUUID();
      const responded = new Promise<void>((resolve) => {
        pi.events.emit("plannotator:request", {
          requestId,
          action: "plan-review",
          payload: {
            planContent,
            planFilePath: join(orchestrator.active!.dir, "plans"),
          },
          respond: (response: any) => {
            handled = true;
            if (response.status === "handled") {
              ctx.ui.notify("Plan review opened in browser", "info");
            } else {
              ctx.ui.notify(`Plannotator unavailable: ${response.error ?? "plannotator extension not loaded"}`, "error");
            }
            resolve();
          },
        });
      });

      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!handled) {
            ctx.ui.notify("Plannotator not responding — is the extension installed?", "error");
          }
          resolve();
        }, 5000);
      });

      await Promise.race([responded, timeout]);
    },
  });

  pi.registerCommand("pp:review-code", {
    description: "Open code changes in Plannotator code review browser UI",
    handler: async (_args, ctx) => {
      let handled = false;
      const requestId = crypto.randomUUID();
      const responded = new Promise<void>((resolve) => {
        pi.events.emit("plannotator:request", {
          requestId,
          action: "code-review",
          payload: {
            cwd: orchestrator.cwd,
            diffType: "branch",
          },
          respond: (response: any) => {
            handled = true;
            if (response.status === "handled") {
              if (response.result?.feedback) {
                pi.sendMessage(
                  { customType: "pp-code-review-feedback", content: response.result.feedback, display: true },
                  { deliverAs: "steer" },
                );
              }
            } else {
              ctx.ui.notify(`Plannotator unavailable: ${response.error ?? "plannotator extension not loaded"}`, "error");
            }
            resolve();
          },
        });
      });

      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!handled) {
            ctx.ui.notify("Plannotator not responding — is the extension installed?", "error");
          }
          resolve();
        }, 5000);
      });

      await Promise.race([responded, timeout]);
    },
  });
}
