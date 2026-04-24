import { resolve, basename, join } from "path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.js";
import { runAfterEdit, autoCommit } from "./commands.js";
import { taskName, getActiveTask, saveTask } from "./state.js";
import { loadContextFiles, getPhaseArtifacts, getLatestSynthesizedPlan } from "./context.js";
import { WORKING_PRINCIPLES, COMMUNICATION } from "./agents/tool-routing.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { setExtensionOnlyMode, unregisterAgentDefinitions } from "./agents/registry.js";
import { spawnPlanners } from "./phases/planning.js";
import { spawnCodeReviewers } from "./phases/review.js";
import { Orchestrator, deepReviewConfig } from "./orchestrator.js";

function registerOrchestratorTools(orchestrator: Orchestrator): void {
  registerPhaseCompleteTool(orchestrator);
  registerCommitTool(orchestrator);
  registerWaitTool(orchestrator);
}

function registerWaitTool(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.registerTool({
    name: "pp_wait",
    label: "pi-pi",
    description:
      "Block until all running subagents (planners, reviewers) complete. " +
      "Call this in planning and review phases instead of polling the directory. " +
      "Returns when all subagents have finished.",
    parameters: Type.Object({}),
    async execute() {
      if (orchestrator.spawnedAgentIds.size === 0) {
        return { content: [{ type: "text" as const, text: "No subagents running. Proceed." }], details: {} };
      }

      await new Promise<void>((resolve) => {
        const check = () => {
          if (orchestrator.spawnedAgentIds.size === 0) {
            resolve();
          } else {
            setTimeout(check, 1000);
          }
        };
        check();
      });

      return { content: [{ type: "text" as const, text: "All subagents completed. Read their outputs now." }], details: {} };
    },
  });
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

      const phase = orchestrator.active.state.phase;
      const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

      const options: string[] = [];
      if (phase === "brainstorm") {
        options.push("Approve & continue to planning", "Continue brainstorming");
      } else if (phase === "active") {
        options.push("Approve & start implementation", "Approve & finish brainstorm", "Continue brainstorming");
      } else if (phase === "diagnosing") {
        options.push("Approve & start implementation", "Approve & finish diagnosis", "Continue diagnosing");
      } else if (phase === "planning") {
        options.push("Approve plan & continue", "Review in Plannotator", "Let me review first");
      } else if (phase === "implementation") {
        options.push("Approve & start review", "Let me check first");
      } else if (phase === "review") {
        options.push("Approve & finish", "Another review round", "Deep review round", "Review in Plannotator", "Let me review first");
      } else {
        return ok("No dialog available for this phase.");
      }

      const choice = await ctx.ui.select(`${params.summary}`, options);

      if (choice === "Approve & start implementation") {
        const taskType = orchestrator.active!.type;
        const taskBasename = basename(orchestrator.active!.dir);
        const fromArg = `${taskType}/${taskBasename}`;

        const result = await orchestrator.transitionToNextPhase(ctx);
        if (!result.ok) {
          return ok(`Transition blocked: ${result.error}. Address the issue and try again.`);
        }

        pi.sendUserMessage(`/pp:implement --from ${fromArg}`);
        return ok("Starting implementation.");
      }

      if (choice?.startsWith("Approve")) {
        const result = await orchestrator.transitionToNextPhase(ctx);
        if (!result.ok) {
          return ok(`Transition blocked: ${result.error}. Address the issue and try again.`);
        }
        return ok("User approved. Transitioned to next phase.");
      }
      if (choice === "Another review round" || choice === "Deep review round") {
        if (!orchestrator.active) return ok("No active task.");
        orchestrator.active.reviewRound++;
        orchestrator.persistReviewRound();
        const reviewConfig = choice === "Deep review round" ? deepReviewConfig(orchestrator.config) : orchestrator.config;
        spawnCodeReviewers(pi, orchestrator.cwd, orchestrator.active.dir, orchestrator.active.taskId, reviewConfig, orchestrator.active.reviewRound).catch((err) => {
          console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
        });
        return ok(`Starting review round ${orchestrator.active.reviewRound}${choice === "Deep review round" ? " (deep)" : ""}. Call pp_wait to block until reviewers complete.`);
      }
      if (choice === "Review in Plannotator") {
        const reviewAction = phase === "review" ? "code-review" : "plan-review";
        let payload: Record<string, unknown>;
        if (reviewAction === "plan-review") {
          const planContent = getLatestSynthesizedPlan(orchestrator.active!.dir);
          if (!planContent) {
            return ok("No synthesized plan found. Write the plan first, then try again.");
          }
          payload = { planContent, planFilePath: join(orchestrator.active!.dir, "plans") };
        } else {
          payload = { cwd: orchestrator.cwd, diffType: "branch" };
        }

        const opened = await new Promise<boolean>((resolve) => {
          let handled = false;
          pi.events.emit("plannotator:request", {
            requestId: crypto.randomUUID(),
            action: reviewAction,
            payload,
            respond: (response: any) => {
              handled = true;
              resolve(response.status === "handled");
            },
          });
          setTimeout(() => { if (!handled) resolve(false); }, 5000);
        });

        if (!opened) {
          return ok("Plannotator is not available. Review manually or run /pp:review-plan.");
        }

        const reviewResult = await new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
          const unsub = pi.events.on("plannotator:review-result", (data: any) => {
            unsub();
            resolve({ approved: !!data?.approved, feedback: data?.feedback });
          });
        });

        if (reviewResult.approved) {
          const result = await orchestrator.transitionToNextPhase(ctx);
          if (!result.ok) {
            return ok(`Plannotator approved but transition blocked: ${result.error}`);
          }
          return ok("User approved in Plannotator. Transitioned to next phase.");
        }

        const feedback = reviewResult.feedback ? `\n\nFeedback:\n${reviewResult.feedback}` : "";
        return ok(`User denied in Plannotator. Make the requested changes.${feedback}`);
      }
      if (choice?.startsWith("Continue")) {
        return ok("User wants to continue the current phase. Keep working.");
      }
      return ok("User chose to review manually. Do not call any more tools or generate further output — stop immediately and wait for the user's next message.");
    },
  });
}

export function registerEventHandlers(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;

  pi.events.on("subagents:created", (data: any) => {
    if (!orchestrator.active || !data?.id) return;
    orchestrator.spawnedAgentIds.add(data.id);
    if (data.description) {
      orchestrator.agentDescriptions.set(data.id, data.description);
    }
  });

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
  });

  pi.on("session_before_switch" as any, async () => {
    if (!orchestrator.active) return;
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
    if (!orchestrator.active || orchestrator.active.state.phase !== "implementation") return;

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

    if (orchestrator.active.state.phase === "implementation" && orchestrator.config.autoCommit && orchestrator.active.modifiedFiles.size > 0) {
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
    if (phase === "active") return;

    const msg = event.message as any;
    const msgContent = typeof msg?.content === "string" ? msg.content : "";
    const hasToolResults = event.toolResults && event.toolResults.length > 0;
    const turnWasEmpty = !msgContent.trim() && !hasToolResults;

    if (!turnWasEmpty) return;
    if (orchestrator.nudgeHalted) return;
    if (orchestrator.spawnedAgentIds.size > 0) return;

    const now = Date.now();

    orchestrator.nudgeTimestamps.push(now);
    orchestrator.nudgeTimestamps = orchestrator.nudgeTimestamps.filter((t) => now - t < 60000);

    const sendNudge = () => {
      pi.sendMessage(
        {
          customType: "pp-continuation",
          content: `Your previous response was interrupted. Continue working on the current phase (${phase}). Pick up where you left off.`,
          display: false,
        },
        { deliverAs: "steer" },
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
