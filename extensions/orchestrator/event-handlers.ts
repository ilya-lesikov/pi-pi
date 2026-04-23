import { resolve, basename } from "path";
import { loadConfig } from "./config.js";
import { runAfterEdit, autoCommit } from "./commands.js";
import { taskName, getActiveTask } from "./state.js";
import { loadContextFiles, loadAgentsMd, getPhaseArtifacts } from "./context.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { setExtensionOnlyMode, unregisterAgentDefinitions } from "./agents/registry.js";
import { Orchestrator } from "./orchestrator.js";

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
    const resultPreview = orchestrator.truncateResult(data.result || "");

    if (resultPreview) {
      pi.sendMessage(
        {
          customType: "pp-subagent-result",
          content: `**${desc}**${stats ? ` (${stats})` : ""}:\n${resultPreview}`,
          display: true,
        },
        { deliverAs: "steer" },
      );
    }
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

    orchestrator.updateStatus(ctx);

    const phasePrompt = orchestrator.getPhasePrompt(ctx);
    const systemContextFiles = loadContextFiles(orchestrator.cwd, "main", "system");
    const systemSnippets = systemContextFiles.map((f) => f.content).join("\n\n");
    const agentsMd = orchestrator.config.injectAgentsMd ? loadAgentsMd(orchestrator.cwd) : null;

    const fullAddition = [systemSnippets, agentsMd, phasePrompt].filter(Boolean).join("\n\n");
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
      const files = [...orchestrator.active.modifiedFiles];
      const result = autoCommit(files, orchestrator.active.description, orchestrator.cwd);
      if (result.ok) {
        orchestrator.active.modifiedFiles.clear();
      }
    }

    const phase = orchestrator.active.state.phase;
    if (phase === "active") return;

    const msg = event.message as any;
    const msgContent = typeof msg?.content === "string" ? msg.content : "";
    const hasToolResults = event.toolResults && event.toolResults.length > 0;
    const turnWasEmpty = !msgContent.trim() && !hasToolResults;

    if (!turnWasEmpty) return;

    const now = Date.now();
    const RESET_AFTER_MS = 5 * 60 * 1000;
    const MAX_BACKOFF_MS = 60 * 1000;
    const HALT_WINDOW_MS = 30 * 60 * 1000;
    const MAX_BACKOFF_HITS_BEFORE_HALT = 3;

    const lastNudge = orchestrator.nudgeTimestamps[orchestrator.nudgeTimestamps.length - 1];
    if (lastNudge && now - lastNudge > RESET_AFTER_MS) {
      orchestrator.nudgeTimestamps = [];
      orchestrator.currentBackoffMs = 0;
    }

    orchestrator.nudgeTimestamps.push(now);
    const recentNudges = orchestrator.nudgeTimestamps.filter((t) => now - t < 60000);

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

    if (recentNudges.length <= 3) {
      orchestrator.currentBackoffMs = 0;
      sendNudge();
      return;
    }

    orchestrator.currentBackoffMs = orchestrator.currentBackoffMs === 0
      ? 1000
      : Math.min(orchestrator.currentBackoffMs * 3, MAX_BACKOFF_MS);

    if (orchestrator.currentBackoffMs >= MAX_BACKOFF_MS) {
      orchestrator.maxBackoffHits.push(now);
      orchestrator.maxBackoffHits = orchestrator.maxBackoffHits.filter((t) => now - t < HALT_WINDOW_MS);

      if (orchestrator.maxBackoffHits.length >= MAX_BACKOFF_HITS_BEFORE_HALT) {
        pi.sendMessage(
          {
            customType: "pp-continuation-halted",
            content: "Agent has been repeatedly interrupted and unable to make progress. This is likely a provider issue (content filter, rate limiting, or outage). Please check your provider status and retry manually.",
            display: true,
          },
          { deliverAs: "steer" },
        );
        orchestrator.nudgeTimestamps = [];
        orchestrator.currentBackoffMs = 0;
        orchestrator.maxBackoffHits = [];
        return;
      }
    }

    setTimeout(sendNudge, orchestrator.currentBackoffMs);
  });

  pi.events.on("plannotator:review-result", (data: any) => {
    if (!data) return;
    const parts: string[] = [];

    if (data.approved) {
      parts.push("[Plannotator] Plan APPROVED by user.");
    } else {
      parts.push("[Plannotator] Plan DENIED by user.");
    }

    if (data.feedback) {
      parts.push("", "User feedback:", data.feedback);
    }

    if (parts.length > 0) {
      pi.sendMessage(
        { customType: "pp-plannotator-result", content: parts.join("\n"), display: true },
        { deliverAs: "steer" },
      );
    }
  });
}
