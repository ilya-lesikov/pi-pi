import { existsSync, readdirSync } from "fs";
import { resolve, basename, join } from "path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.js";
import { runAfterEdit, autoCommit } from "./commands.js";
import { taskName, getActiveTask, saveTask } from "./state.js";
import { loadContextFiles, getPhaseArtifacts, getLatestSynthesizedPlan, loadReviewOutputs } from "./context.js";
import { WORKING_PRINCIPLES, COMMUNICATION } from "./agents/tool-routing.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { setExtensionOnlyMode, unregisterAgentDefinitions } from "./agents/registry.js";
import { spawnPlanners } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { openPlannotator, waitForPlannotatorResult, cancelPendingPlannotatorWait } from "./plannotator.js";
import { Orchestrator, deepReviewConfig, type ActiveTask } from "./orchestrator.js";

function setStep(orchestrator: Orchestrator, step: string): void {
  if (!orchestrator.active) return;
  orchestrator.active.state.step = step;
  saveTask(orchestrator.active.dir, orchestrator.active.state);
}

async function enterReviewCycle(orchestrator: Orchestrator, ctx: any, kind: "auto" | "auto-deep" | "plannotator") {
  if (!orchestrator.active) return "No active task.";
  const pi = orchestrator.pi;
  const pass = orchestrator.active.state.reviewPass + 1;
  orchestrator.active.state.reviewCycle = { kind, step: "spawn_reviewers", pass };
  saveTask(orchestrator.active.dir, orchestrator.active.state);

  if (kind === "plannotator") {
    const isPlan = orchestrator.active.state.phase === "plan";
    let payload: Record<string, unknown>;
    if (isPlan) {
      const planContent = getLatestSynthesizedPlan(orchestrator.active.dir);
      if (!planContent) {
        orchestrator.active.state.reviewCycle = null;
        saveTask(orchestrator.active.dir, orchestrator.active.state);
        return "No synthesized plan found. Write the plan first, then try again.";
      }
      payload = { planContent, planFilePath: join(orchestrator.active.dir, "plans") };
    } else {
      payload = { cwd: orchestrator.cwd, diffType: "branch" };
    }

    const { opened, requestId } = await openPlannotator(pi, isPlan ? "plan-review" : "code-review", payload);
    if (!opened) {
      orchestrator.active.state.reviewCycle = null;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return "Plannotator is not available. Try another review mode.";
    }

    let result: { approved: boolean; feedback?: string };
    try {
      result = await waitForPlannotatorResult(orchestrator, requestId);
    } catch {
      orchestrator.active.state.reviewCycle = null;
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return "Plannotator review cancelled.";
    }
    orchestrator.active.state.reviewCycle = null;
    if (result.approved) {
      orchestrator.active.state.reviewPass += 1;
      orchestrator.active.reviewPass = orchestrator.active.state.reviewPass;
      orchestrator.active.state.step = "user_gate";
      saveTask(orchestrator.active.dir, orchestrator.active.state);
      return "Plannotator approved. Returned to user gate.";
    }

    orchestrator.active.state.step = orchestrator.active.state.phase === "plan" ? "synthesize" : "llm_work";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    const feedback = result.feedback ? `\n\nFeedback:\n${result.feedback}` : "";
    return `Plannotator requested changes.${feedback}\n\nUser wants to continue. Run /pp:next when ready to advance.`;
  }

  const config = kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
  const enabledCount = Object.values(config.codeReviewers).filter((v) => v.enabled).length;
  if (enabledCount === 0) {
    orchestrator.active.state.reviewCycle = null;
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    return "No code reviewers enabled. Choose another review mode or review manually.";
  }

  orchestrator.pendingSubagentSpawns = enabledCount;
  spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, config, pass).catch((err) => {
    orchestrator.pendingSubagentSpawns = 0;
    console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
  });

  orchestrator.active.state.reviewCycle.step = "await_reviewers";
  saveTask(orchestrator.active.dir, orchestrator.active.state);
  return `Started review cycle pass ${pass} (${kind}). Awaiting reviewers.`;
}

function finalizeReviewCycle(task: ActiveTask): void {
  if (!task.state.reviewCycle) return;
  task.state.reviewPass = task.state.reviewCycle.pass;
  task.reviewPass = task.state.reviewPass;
  task.state.reviewCycle = null;
  task.state.step = "user_gate";
  saveTask(task.dir, task.state);
}

export async function runUserGateDialog(orchestrator: Orchestrator, ctx: any, summary: string): Promise<string> {
  if (!orchestrator.active) return "No active task.";
  const pi = orchestrator.pi;
  const phase = orchestrator.active.state.phase;
  const task = orchestrator.active;

  if (orchestrator.spawnedAgentIds.size > 0 || orchestrator.pendingSubagentSpawns > 0) {
    const count = orchestrator.spawnedAgentIds.size + orchestrator.pendingSubagentSpawns;
    return `${count} subagent(s) still running or spawning.`;
  }

  const pendingPass = task.state.reviewCycle?.pass ?? 0;
  const nextPass = Math.max(task.state.reviewPass, pendingPass) + 1;
  const autoLabel = nextPass > 1 ? `Automatic review (pass ${nextPass})` : "Automatic review";
  const deepLabel = nextPass > 1 ? `Automatic deep review (pass ${nextPass})` : "Automatic deep review";

  const continueMessage = "User wants to continue. Run /pp:next when ready to advance.";

  if (phase === "brainstorm" && task.type === "implement") {
    const choice = await ctx.ui.select(summary, ["Approve brainstorm", "Continue brainstorming"]);
    if (choice === "Approve brainstorm") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      return result.ok ? "Brainstorm approved. Transitioned to plan." : `Transition blocked: ${result.error}`;
    }
    setStep(orchestrator, "llm_work");
    return continueMessage;
  }

  if (phase === "brainstorm" && task.type === "brainstorm") {
    const canStartImpl = existsSync(join(task.dir, "USER_REQUEST.md")) && existsSync(join(task.dir, "RESEARCH.md"));
    const options = ["Continue brainstorming", "Finish brainstorming"];
    if (canStartImpl) options.unshift("Start implementation");
    const choice = await ctx.ui.select(summary, options);
    if (choice === "Start implementation") {
      const fromArg = `${task.type}/${basename(task.dir)}`;
      pi.sendUserMessage(`/pp:implement --from ${fromArg}`);
      return "Starting implementation from brainstorm artifacts.";
    }
    if (choice === "Finish brainstorming") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      return result.ok ? "Brainstorm finished." : `Transition blocked: ${result.error}`;
    }
    setStep(orchestrator, "llm_work");
    return continueMessage;
  }

  if (phase === "debug") {
    const choice = await ctx.ui.select(summary, ["Implement a fix", "Continue debugging", "Finish debugging"]);
    if (choice === "Implement a fix") {
      const fromArg = `${task.type}/${basename(task.dir)}`;
      pi.sendUserMessage(`/pp:implement --from ${fromArg}`);
      return "Starting implementation from debug artifacts.";
    }
    if (choice === "Finish debugging") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      return result.ok ? "Debugging finished." : `Transition blocked: ${result.error}`;
    }
    setStep(orchestrator, "llm_work");
    return continueMessage;
  }

  if (phase === "plan") {
    const choice = await ctx.ui.select(summary, [
      "Approve plan",
      autoLabel,
      deepLabel,
      "Review in Plannotator",
      "Review on my own",
      "Continue planning",
    ]);
    finalizeReviewCycle(task);
    if (choice === "Approve plan") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      return result.ok ? "Plan approved. Transitioned to implement." : `Transition blocked: ${result.error}`;
    }
    if (choice === autoLabel) return enterReviewCycle(orchestrator, ctx, "auto");
    if (choice === deepLabel) return enterReviewCycle(orchestrator, ctx, "auto-deep");
    if (choice === "Review in Plannotator") return enterReviewCycle(orchestrator, ctx, "plannotator");
    setStep(orchestrator, "synthesize");
    return continueMessage;
  }

  if (phase === "implement") {
    const choice = await ctx.ui.select(summary, [
      "Approve implementation",
      autoLabel,
      deepLabel,
      "Review in Plannotator",
      "Review on my own",
      "Continue implementation",
    ]);
    finalizeReviewCycle(task);
    if (choice === "Approve implementation") {
      const result = await orchestrator.transitionToNextPhase(ctx);
      return result.ok ? "Implementation approved. Task completed." : `Transition blocked: ${result.error}`;
    }
    if (choice === autoLabel) return enterReviewCycle(orchestrator, ctx, "auto");
    if (choice === deepLabel) return enterReviewCycle(orchestrator, ctx, "auto-deep");
    if (choice === "Review in Plannotator") return enterReviewCycle(orchestrator, ctx, "plannotator");
    setStep(orchestrator, "llm_work");
    return continueMessage;
  }

  return "No dialog available for this phase.";
}

function registerOrchestratorTools(orchestrator: Orchestrator): void {
  registerPhaseCompleteTool(orchestrator);
  registerCommitTool(orchestrator);
}

function registerCommitTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_commit",
    label: "pi-pi",
    description:
      "Commit modified files with a descriptive message. Call after completing a logical " +
      "unit of work (e.g. implementing one plan item, fixing a bug, adding a test). " +
      "The message should describe WHAT changed and WHY, not list files.",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message describing the change (max 72 chars for first line)" }),
    }),
    async execute(_toolCallId, params: any) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      if (!orchestrator.config.autoCommit) {
        return { content: [{ type: "text" as const, text: "autoCommit is disabled in config." }], details: {} };
      }
      if (orchestrator.active.modifiedFiles.size === 0) {
        return { content: [{ type: "text" as const, text: "No modified files to commit." }], details: {} };
      }

      const files = [...orchestrator.active.modifiedFiles];
      const result = autoCommit(files, params.message, orchestrator.cwd);
      if (result.ok) {
        orchestrator.active.modifiedFiles.clear();
        return { content: [{ type: "text" as const, text: `Committed ${files.length} file(s): ${result.commitHash ?? "ok"}` }], details: {} };
      }
      return { content: [{ type: "text" as const, text: `Commit failed: ${result.error}` }], isError: true as const, details: {} };
    },
  });
}

function registerPhaseCompleteTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_phase_complete",
    label: "pi-pi",
    description:
      "Call when the current phase is complete. Shows a dialog to the user for " +
      "approval. The user's choice is returned — act on it accordingly.",
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of what was accomplished in this phase" }),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      if (!orchestrator.active) {
        return { content: [{ type: "text" as const, text: "No active task." }], isError: true as const, details: {} };
      }
      const text = await runUserGateDialog(orchestrator, ctx, params.summary);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.events.on("subagents:created", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    orchestrator.spawnedAgentIds.add(data.id);
    if (orchestrator.pendingSubagentSpawns > 0) orchestrator.pendingSubagentSpawns--;
    if (data.description) {
      orchestrator.agentDescriptions.set(data.id, data.description);
    }
  });

  function checkPlannerCompletion(): void {
    if (
      !orchestrator.active ||
      orchestrator.active.state.phase !== "plan" ||
      orchestrator.active.state.step !== "await_planners" ||
      orchestrator.spawnedAgentIds.size > 0 ||
      orchestrator.pendingSubagentSpawns > 0
    ) return;

    orchestrator.active.state.step = "synthesize";
    saveTask(orchestrator.active.dir, orchestrator.active.state);
    pi.sendUserMessage("[PI-PI] All planners completed. Read their outputs and synthesize the plan.", { deliverAs: "followUp" });
  }

  function checkReviewCycleCompletion(): void {
    if (
      !orchestrator.active?.state.reviewCycle ||
      orchestrator.active.state.reviewCycle.step !== "await_reviewers" ||
      orchestrator.spawnedAgentIds.size > 0 ||
      orchestrator.pendingSubagentSpawns > 0
    ) return;

    const cycle = orchestrator.active.state.reviewCycle;
    cycle.step = "apply_feedback";
    orchestrator.active.state.step = "apply_feedback";
    saveTask(orchestrator.active.dir, orchestrator.active.state);

    const outputs = loadReviewOutputs(orchestrator.active.dir, cycle.pass);
    const rendered = outputs.length
      ? outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n")
      : "No reviewer outputs found. Continue with manual review of current implementation.";

    pi.sendMessage(
      {
        customType: "pp-review-ready",
        content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`,
        display: false,
      },
      { deliverAs: "followUp" },
    );
    pi.sendUserMessage("[PI-PI] Review cycle is ready for apply_feedback. Read reviewer outputs and proceed.", { deliverAs: "followUp" });
  }

  pi.events.on("subagents:completed", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    orchestrator.spawnedAgentIds.delete(data.id);
    orchestrator.agentDescriptions.delete(data.id);

    const desc = data.description || data.type || data.id;
    const duration = data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : "";
    const tokens = data.tokens?.total ? `${data.tokens.total} tok` : "";
    const stats = [duration, tokens].filter(Boolean).join(", ");

    pi.sendMessage(
      {
        customType: "pp-subagent-result",
        content: `${desc} completed${stats ? ` (${stats})` : ""}. Use get_subagent_result to read the output.`,
        display: false,
      },
      { deliverAs: "steer" },
    );

    checkPlannerCompletion();
    checkReviewCycleCompletion();
  });

  pi.events.on("subagents:failed", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    orchestrator.spawnedAgentIds.delete(data.id);
    const desc = orchestrator.agentDescriptions.get(data.id) || data.type || data.id;
    orchestrator.agentDescriptions.delete(data.id);

    pi.sendMessage(
      {
        customType: "pp-subagent-error",
        content: `**${desc}** failed: ${data.error || "unknown error"}`,
        display: true,
      },
      { deliverAs: "steer" },
    );

    checkPlannerCompletion();
    checkReviewCycleCompletion();
  });

  pi.on("session_before_switch" as any, async () => {
    if (!orchestrator.active) return;
    cancelPendingPlannotatorWait(orchestrator);
    orchestrator.abortAllSubagents();
    unregisterAgentDefinitions(pi);
    await orchestrator.cleanupActive();
  });

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.cwd = ctx.cwd;

    const duplicates = orchestrator.checkForConflictingExtensions();
    if (duplicates.length > 0) {
      const msg = `pi-pi bundles its own versions of pi-subagents, pi-tasks, and pi-ask-user. ` +
        `Duplicate tools detected: ${duplicates.join(", ")}. ` +
        `Remove the conflicting packages: pi remove npm:@tintinweb/pi-subagents npm:@tintinweb/pi-tasks npm:pi-ask-user`;
      ctx.ui.notify(msg, "error");
      console.error(`[pi-pi] FATAL: ${msg}`);
      return;
    }

    try {
      orchestrator.config = loadConfig(orchestrator.cwd);
    } catch (err: any) {
      console.error(`[pi-pi] Failed to load config on session start: ${err.message}`);
      return;
    }

    registerCbmTools(pi, orchestrator.cwd);
    registerExaTools(pi);
    registerAstSearchTool(pi, orchestrator.cwd);
    registerOrchestratorTools(orchestrator);
    setExtensionOnlyMode(pi);
    orchestrator.registerAgents();

    const found = getActiveTask(orchestrator.cwd, orchestrator.config.timeouts.lockStale);
    if (found) {
      ctx.ui.notify(
        `Paused task: "${taskName(found.dir)}" (${found.type}, phase: ${found.state.phase}). Run /pp:resume to continue.`,
        "info",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;

    orchestrator.nudgeHalted = false;
    orchestrator.updateStatus(ctx);

    const phasePrompt = orchestrator.getPhasePrompt(ctx);
    const systemContextFiles = loadContextFiles(orchestrator.cwd, "main", "system");
    const systemSnippets = systemContextFiles.map((f) => f.content).join("\n\n");

    const fullAddition = [WORKING_PRINCIPLES, COMMUNICATION, systemSnippets, phasePrompt].filter(Boolean).join("\n\n");
    if (!fullAddition) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + fullAddition,
    };
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "Agent" && orchestrator.active) {
      const input = event.input as Record<string, unknown>;
      const requestedType = ((input.subagent_type as string) || "").toLowerCase();
      const isExplore = !requestedType || requestedType === "explore";
      const isLibrarian = requestedType === "librarian";

      if (isExplore) {
        input.subagent_type = "explore";
        input.model = orchestrator.config.agents.explore.model;
        input.thinking = orchestrator.config.agents.explore.thinking;
      } else if (isLibrarian) {
        input.subagent_type = "librarian";
        input.model = orchestrator.config.agents.librarian.model;
        input.thinking = orchestrator.config.agents.librarian.thinking;
      } else {
        input.subagent_type = "task";
        input.model = orchestrator.config.agents.task.model;
        input.thinking = orchestrator.config.agents.task.thinking;
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { file_path?: string; filePath?: string; path?: string };
      const rawPath = input.file_path || input.filePath || input.path || "";
      const resolvedPath = resolve(orchestrator.cwd, rawPath);
      const ppStateDir = resolve(orchestrator.cwd, ".pp", "state");
      const ppDir = resolve(orchestrator.cwd, ".pp");

      if (resolvedPath.startsWith(ppStateDir + "/") || resolvedPath === ppStateDir) {
        if (!resolvedPath.endsWith(".md")) {
          return { block: true, reason: "Cannot write non-.md files in .pp/state/" };
        }
      }

      const fileName = basename(resolvedPath);
      if (fileName === "state.json" && (resolvedPath.startsWith(ppDir + "/") || resolvedPath === ppDir)) {
        return { block: true, reason: "state.json is managed by the extension" };
      }

      if (fileName === "config.json" && (resolvedPath.startsWith(ppDir + "/") || resolvedPath === ppDir)) {
        return { block: true, reason: "config.json is managed by the user, not the LLM" };
      }
    }
    return;
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!orchestrator.active || orchestrator.active.state.phase !== "implement") return;

    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      const input = event.input as { file_path?: string; filePath?: string; path?: string };
      const filePath = input.file_path || input.filePath || input.path;
      if (!filePath) return;

      if (filePath.includes(".pp/")) return;

      orchestrator.active.modifiedFiles.add(filePath);

      const afterEditResults = runAfterEdit(filePath, orchestrator.config, orchestrator.cwd);
      const failures = afterEditResults.filter((r) => !r.ok);

      if (failures.length > 0) {
        const failureText = failures
          .map((f) => `afterEdit command failed: ${f.command}\n${f.output}`)
          .join("\n\n");
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n\n<afterEdit>\n${failureText}\n</afterEdit>` },
          ],
        };
      }

      const lspAvailable = pi.getAllTools().some((t) => t.name === "lsp");
      if (lspAvailable) {
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n\nRun lsp diagnostics on ${filePath} to check for errors.` },
          ],
        };
      }
    }
    return;
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;

    if (orchestrator.phaseCompactionPending) {
      return {
        compaction: {
          summary: `Previous phase (${orchestrator.active.state.phase}) completed. Transitioning to next phase.`,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    }

    const artifacts = getPhaseArtifacts(orchestrator.active.dir, orchestrator.active.state.phase);
    if (artifacts.length === 0) return;

    const artifactText = artifacts
      .map((a) => `=== ${a.name} ===\n${a.content}`)
      .join("\n\n");

    pi.sendMessage(
      {
        customType: "pp-artifact-reinject",
        content: `[PI-PI ARTIFACTS — re-injected after compaction]\n\n${artifactText}`,
        display: false,
      },
      { deliverAs: "steer" },
    );

    return;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!orchestrator.active || orchestrator.active.state.phase === "done") return;
    orchestrator.updateStatus(ctx);

    if (orchestrator.active.state.phase === "implement" && orchestrator.config.autoCommit && orchestrator.active.modifiedFiles.size > 0) {
      pi.sendMessage(
        {
          customType: "pp-commit-reminder",
          content: `You have ${orchestrator.active.modifiedFiles.size} uncommitted file(s). If you've completed a logical unit of work, call pp_commit with a descriptive message.`,
          display: false,
        },
        { deliverAs: "steer" },
      );
    }

    const phase = orchestrator.active.state.phase;

    const msg = event.message as any;
    if (msg?.stopReason === "error") {
      const errorMsg = msg.errorMessage || "unknown error";
      console.error(`[pi-pi] Turn ended with error: ${errorMsg}`);
      orchestrator.errorRetryCount = (orchestrator.errorRetryCount ?? 0) + 1;
      if (orchestrator.errorRetryCount <= 3) {
        ctx.ui.notify(`API error (attempt ${orchestrator.errorRetryCount}/3): ${errorMsg}. Retrying...`, "warning");
        pi.sendMessage(
          {
            customType: "pp-error-retry",
            content: `[PI-PI] Previous request failed due to an API error. Continue working on the current phase (${phase}).`,
            display: false,
          },
          { deliverAs: "followUp" },
        );
      } else {
        ctx.ui.notify(`API error persisted after 3 retries: ${errorMsg}. Stopping auto-retry.`, "error");
        orchestrator.errorRetryCount = 0;
      }
      return;
    }
    orchestrator.errorRetryCount = 0;

    if (orchestrator.active.state.step === "await_planners" || orchestrator.active.state.step === "await_reviewers") {
      if (!orchestrator.awaitPollTimer) {
        orchestrator.awaitPollTimer = setInterval(() => {
          if (!orchestrator.active) {
            clearInterval(orchestrator.awaitPollTimer!);
            orchestrator.awaitPollTimer = null;
            return;
          }
          const taskDir = orchestrator.active.dir;
          if (orchestrator.active.state.step === "await_planners") {
            const plansDir = join(taskDir, "plans");
            const plannerCount = Object.values(orchestrator.config.planners).filter((v) => v.enabled).length;
            if (existsSync(plansDir)) {
              const planFiles = readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.includes("synthesized") && !f.includes("review_"));
              if (planFiles.length >= plannerCount) {
                clearInterval(orchestrator.awaitPollTimer!);
                orchestrator.awaitPollTimer = null;
                orchestrator.active.state.step = "synthesize";
                saveTask(orchestrator.active.dir, orchestrator.active.state);
                pi.sendUserMessage("[PI-PI] All planners completed. Read their outputs and synthesize the plan.");
              }
            }
          } else if (orchestrator.active.state.step === "await_reviewers" && orchestrator.active.state.reviewCycle) {
            const cycle = orchestrator.active.state.reviewCycle;
            const reviewConfig = cycle.kind === "auto-deep" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
            const reviewerCount = Object.values(reviewConfig.codeReviewers).filter((v) => v.enabled).length;
            const outputs = loadReviewOutputs(taskDir, cycle.pass);
            if (outputs.length >= reviewerCount) {
              clearInterval(orchestrator.awaitPollTimer!);
              orchestrator.awaitPollTimer = null;
              cycle.step = "apply_feedback";
              orchestrator.active.state.step = "apply_feedback";
              saveTask(orchestrator.active.dir, orchestrator.active.state);
              const rendered = outputs.map((o) => `=== ${o.name} ===\n${o.content}`).join("\n\n");
              pi.sendMessage(
                { customType: "pp-review-ready", content: `[PI-PI] Reviewer outputs are ready.\n\n${rendered}`, display: false },
                { deliverAs: "followUp" },
              );
              pi.sendUserMessage("[PI-PI] Review cycle is ready for apply_feedback. Read reviewer outputs and proceed.");
            }
          } else {
            clearInterval(orchestrator.awaitPollTimer!);
            orchestrator.awaitPollTimer = null;
          }
        }, 5000);
      }
      return;
    }
    if (orchestrator.awaitPollTimer) {
      clearInterval(orchestrator.awaitPollTimer);
      orchestrator.awaitPollTimer = null;
    }

    if (orchestrator.active.type === "brainstorm" && phase === "brainstorm") return;

    const contentParts = Array.isArray(msg?.content) ? msg.content : [];
    const hasText = contentParts.some((c: any) => c.type === "text" && c.text?.trim());
    const hasToolCalls = contentParts.some((c: any) => c.type === "toolCall");
    const hasToolResults = event.toolResults && event.toolResults.length > 0;
    const turnWasEmpty = !hasText && !hasToolCalls && !hasToolResults;

    if (!turnWasEmpty) return;
    if (orchestrator.nudgeHalted) return;
    if (orchestrator.spawnedAgentIds.size > 0 || orchestrator.pendingSubagentSpawns > 0) return;

    const step = orchestrator.active.state.step;
    if (step === "await_planners" || step === "await_reviewers") return;

    const now = Date.now();

    orchestrator.nudgeTimestamps.push(now);
    orchestrator.nudgeTimestamps = orchestrator.nudgeTimestamps.filter((t) => now - t < 60000);

    const sendNudge = () => {
      pi.sendMessage(
        {
          customType: "pp-continuation",
          content: `[PI-PI] Your previous response was interrupted. Continue working on the current phase (${phase}). Pick up where you left off.`,
          display: false,
        },
        { deliverAs: "followUp" },
      );
    };

    if (orchestrator.nudgeTimestamps.length <= 3) {
      sendNudge();
      return;
    }

    if (orchestrator.nudgeTimestamps.length >= 5) {
      orchestrator.cooldownHits.push(now);
      orchestrator.cooldownHits = orchestrator.cooldownHits.filter((t) => now - t < 20 * 60 * 1000);

      if (orchestrator.cooldownHits.length >= 5) {
        orchestrator.nudgeHalted = true;
        orchestrator.nudgeTimestamps = [];
        orchestrator.cooldownHits = [];
        pi.sendMessage(
          {
            customType: "pp-continuation-halted",
            content: "Agent has been repeatedly interrupted. Auto-continuation paused. Send any message to resume nudging.",
            display: true,
          },
          { deliverAs: "steer" },
        );
        return;
      }

      pi.sendMessage(
        {
          customType: "pp-continuation-cooldown",
          content: "Agent interrupted repeatedly. Waiting 60 seconds before retrying.",
          display: true,
        },
        { deliverAs: "steer" },
      );
      orchestrator.nudgeTimestamps = [];
      setTimeout(sendNudge, 60000);
      return;
    }

    sendNudge();
  });


}
