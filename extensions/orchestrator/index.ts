import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, basename, relative, resolve } from "path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, deepMerge, type PiPiConfig, type VariantConfig } from "./config.js";
import {
  createTask, loadTask, saveTask, listTasks, lockTask, getActiveTask,
  taskName, taskAge, validateFromPath,
  type TaskType, type TaskState, type TaskInfo, type Phase,
} from "./state.js";
import { validateExitCriteria, nextPhase, phasePipeline } from "./phases/machine.js";
import { loadContextFiles, getPhaseArtifacts, loadAgentsMd } from "./context.js";
import { brainstormSystemPrompt } from "./phases/brainstorm.js";
import { planningSystemPrompt, spawnPlanners, spawnPlanReviewers } from "./phases/planning.js";
import { implementationSystemPrompt } from "./phases/implementation.js";
import { reviewSystemPrompt, spawnCodeReviewers } from "./phases/review.js";
import { runAfterEdit, runAfterImplement, autoCommit } from "./commands.js";
import { registerAgentDefinitions, unregisterAgentDefinitions, setExtensionOnlyMode } from "./agents/registry.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";

interface ActiveTask {
  dir: string;
  type: TaskType;
  state: TaskState;
  release: (() => Promise<void>) | null;
  taskId: string;
  modifiedFiles: Set<string>;
  reviewRound: number;
  description: string;
}

export default function (pi: ExtensionAPI) {
  let active: ActiveTask | null = null;
  let config: PiPiConfig;
  let cwd = "";
  const spawnedAgentIds = new Set<string>();
  const agentDescriptions = new Map<string, string>();

  pi.events.on("subagents:created", (data: any) => {
    if (!active || !data?.id) return;
    spawnedAgentIds.add(data.id);
    if (data.description) {
      agentDescriptions.set(data.id, data.description);
    }
  });

  pi.events.on("subagents:completed", (data: any) => {
    if (!active || !data?.id) return;
    spawnedAgentIds.delete(data.id);
    agentDescriptions.delete(data.id);

    const desc = data.description || data.type || data.id;
    const duration = data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : "";
    const tokens = data.tokens?.total ? `${data.tokens.total} tok` : "";
    const stats = [duration, tokens].filter(Boolean).join(", ");
    const resultPreview = truncateResult(data.result || "");

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
    if (!active || !data?.id) return;
    spawnedAgentIds.delete(data.id);
    const desc = agentDescriptions.get(data.id) || data.type || data.id;
    agentDescriptions.delete(data.id);

    pi.sendMessage(
      {
        customType: "pp-subagent-error",
        content: `**${desc}** failed: ${data.error || "unknown error"}`,
        display: true,
      },
      { deliverAs: "steer" },
    );
  });

  function truncateResult(result: string): string {
    const trimmed = result.trim();
    if (!trimmed) return "";
    const lines = trimmed.split("\n");
    if (lines.length <= 20 && trimmed.length <= 2000) return trimmed;
    const truncated = lines.slice(0, 20).join("\n").slice(0, 2000);
    return truncated + "\n…(truncated)";
  }

  async function switchModel(ctx: ExtensionContext, modelSpec: string, thinking: string): Promise<boolean> {
    const registry = ctx.modelRegistry;
    const allModels = registry.getAvailable();

    const slashIdx = modelSpec.indexOf("/");
    let resolved;
    if (slashIdx !== -1) {
      const provider = modelSpec.substring(0, slashIdx).trim().toLowerCase();
      const modelId = modelSpec.substring(slashIdx + 1).trim().toLowerCase();
      resolved = allModels.find(
        (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
      );
    }
    if (!resolved) {
      const pattern = modelSpec.toLowerCase();
      const matches = allModels.filter(
        (m) => m.id.toLowerCase() === pattern || m.id.toLowerCase().includes(pattern),
      );
      if (matches.length === 1) resolved = matches[0];
    }

    if (!resolved) return false;

    const ok = await pi.setModel(resolved);
    if (!ok) return false;

    const thinkingLevel = thinking as "off" | "low" | "medium" | "high";
    pi.setThinkingLevel(thinkingLevel);
    return true;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!active) {
      ctx.ui.setStatus("pi-pi", undefined);
      return;
    }
    ctx.ui.setStatus("pi-pi", `${active.state.phase} — ${active.description}`);
  }

  function createPhaseTasks(): void {
    if (!active || active.type !== "implement") return;

    const phases = phasePipeline(active.type).filter((p) => p !== "done");
    const lines = phases.map((p, i) => {
      const status = p === active!.state.phase ? "in_progress" : "pending";
      const blockedBy = i > 0 ? ` (blocked by #${i})` : "";
      return `${i + 1}. "${p}" (status: ${status})${blockedBy}`;
    });

    pi.sendMessage(
      {
        customType: "pp-task-init",
        content: `Create tracking tasks for the orchestration phases using TaskCreate:\n${lines.join("\n")}`,
        display: false,
      },
      { deliverAs: "steer" },
    );
  }

  function updatePhaseTasks(): void {
    if (!active || active.type !== "implement") return;

    pi.sendMessage(
      {
        customType: "pp-task-update",
        content: `Update tracking tasks: mark current phase "${active.state.phase}" as in_progress, mark previous phases as completed using TaskUpdate.`,
        display: false,
      },
      { deliverAs: "steer" },
    );
  }

  function getPhasePrompt(ctx: ExtensionContext): string {
    if (!active) return "";

    switch (active.state.phase) {
      case "brainstorm":
      case "active":
      case "diagnosing":
        return brainstormSystemPrompt(active.type, active.description, active.dir);
      case "planning":
        return planningSystemPrompt(active.dir, config.usePlannotator);
      case "implementation":
        return implementationSystemPrompt(active.dir);
      case "review":
        return reviewSystemPrompt(active.dir, active.reviewRound, config.usePlannotator);
      default:
        return "";
    }
  }

  function taskIdFromDir(dir: string): string {
    const name = basename(dir);
    return name.split("_")[0];
  }

  function persistReviewRound(): void {
    if (!active) return;
    active.state.reviewRound = active.reviewRound;
    saveTask(active.dir, active.state);
  }

  async function startTask(
    ctx: ExtensionCommandContext,
    type: TaskType,
    description: string,
    fromTaskDir?: string,
    skipBrainstorm?: boolean,
  ): Promise<void> {
    if (active) {
      ctx.ui.notify(
        `Task "${active.description}" is active (phase: ${active.state.phase}). Run /pp:done to finish it, or /pp:resume to continue.`,
        "error",
      );
      return;
    }

    try {
      config = loadConfig(cwd);
    } catch (err: any) {
      ctx.ui.notify(`Config error: ${err.message}`, "error");
      return;
    }

    ensureGitignore(cwd);

    const dir = createTask(cwd, type, description);
    const state = loadTask(dir);

    if (fromTaskDir) {
      const srcUr = join(fromTaskDir, "USER_REQUEST.md");
      const srcRes = join(fromTaskDir, "RESEARCH.md");
      if (existsSync(srcUr)) copyFileSync(srcUr, join(dir, "USER_REQUEST.md"));
      if (existsSync(srcRes)) copyFileSync(srcRes, join(dir, "RESEARCH.md"));
      state.from = relative(join(cwd, ".pp", "state"), fromTaskDir);
      if (skipBrainstorm && type === "implement") {
        state.phase = "planning";
      }
      saveTask(dir, state);
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockTask(dir, config.timeouts);
    } catch (err: any) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        console.error(`[pi-pi] Failed to clean up orphaned task dir: ${dir}`);
      }
      ctx.ui.notify(`Failed to lock task: ${err.message}`, "error");
      return;
    }

    active = {
      dir,
      type,
      state,
      release,
      taskId: taskIdFromDir(dir),
      modifiedFiles: new Set(),
      reviewRound: 1,
      description: state.description,
    };

    const modelConfig = config.mainModel[type === "debug" ? "debug" : type === "brainstorm" ? "brainstorm" : "implement"];
    const modelOk = await switchModel(ctx, modelConfig.model, modelConfig.thinking);
    if (!modelOk) {
      ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
    }

    registerAgents();
    pi.setSessionName(active.description.slice(0, 50));
    updateStatus(ctx);

    injectContextAndArtifacts(active.dir, active.state.phase);
    createPhaseTasks();
    pi.sendUserMessage(getPhasePrompt(ctx));

    if (active.state.phase === "planning") {
      spawnPlanners(pi, cwd, active.dir, active.taskId, config).catch((err) => {
        console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
      });
    }
  }



  function abortAllSubagents(): void {
    for (const agentId of spawnedAgentIds) {
      pi.events.emit("subagents:rpc:stop", {
        requestId: crypto.randomUUID(),
        agentId,
      });
    }
    spawnedAgentIds.clear();
  }

  async function cleanupActive(): Promise<void> {
    if (!active) return;
    if (active.release) {
      try {
        await active.release();
      } catch (err: any) {
        console.error(`[pi-pi] Failed to release lock for ${active.dir}: ${err.message}`);
      }
    }
    active = null;
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────

  const BUNDLED_TOOLS = new Set([
    "Agent", "get_subagent_result", "steer_subagent",
    "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute",
    "ask_user",
  ]);

  function checkForConflictingExtensions(): string[] {
    const allTools = pi.getAllTools();
    const seen = new Map<string, number>();
    for (const tool of allTools) {
      if (BUNDLED_TOOLS.has(tool.name)) {
        seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
      }
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    const duplicates = checkForConflictingExtensions();
    if (duplicates.length > 0) {
      const msg = `pi-pi bundles its own versions of pi-subagents, pi-tasks, and pi-ask-user. ` +
        `Duplicate tools detected: ${duplicates.join(", ")}. ` +
        `Remove the conflicting packages: pi remove npm:@tintinweb/pi-subagents npm:@tintinweb/pi-tasks npm:pi-ask-user`;
      ctx.ui.notify(msg, "error");
      console.error(`[pi-pi] FATAL: ${msg}`);
      return;
    }

    try {
      config = loadConfig(cwd);
    } catch (err: any) {
      console.error(`[pi-pi] Failed to load config on session start: ${err.message}`);
      return;
    }

    setExtensionOnlyMode(pi);

    const found = getActiveTask(cwd, config.timeouts.lockStale);
    if (found && !active) {
      try {
        const release = await lockTask(found.dir, config.timeouts);
        const reviewRound = found.state.reviewRound ?? 1;
        active = {
          dir: found.dir,
          type: found.type,
          state: found.state,
          release,
          taskId: taskIdFromDir(found.dir),
          modifiedFiles: new Set(),
          reviewRound,
          description: found.state.description,
        };
        registerAgents();
        updateStatus(ctx);
        ctx.ui.notify(`Restored task: "${taskName(found.dir)}" (phase: ${found.state.phase})`, "info");
      } catch (err: any) {
        console.error(`[pi-pi] Failed to restore task "${taskName(found.dir)}": ${err.message}`);
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!active || active.state.phase === "done") return;

    updateStatus(ctx);

    const phasePrompt = getPhasePrompt(ctx);
    const systemContextFiles = loadContextFiles(cwd, "main", "system");
    const systemSnippets = systemContextFiles.map((f) => f.content).join("\n\n");
    const agentsMd = config.injectAgentsMd ? loadAgentsMd(cwd) : null;

    const fullAddition = [systemSnippets, agentsMd, phasePrompt].filter(Boolean).join("\n\n");
    if (!fullAddition) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + fullAddition,
    };
  });

  function registerAgents(): void {
    if (!active) return;
    const explore = createExploreAgent(config);
    const librarian = createLibrarianAgent(config);
    const taskAgent = createTaskAgent(config, "{{subtask}}", { userRequest: "", synthesizedPlan: "" });
    registerAgentDefinitions(pi, active.taskId, [
      { type: "explore", variant: null, ...explore },
      { type: "librarian", variant: null, ...librarian },
      { type: "task", variant: null, ...taskAgent },
    ]);
  }

  function injectContextAndArtifacts(taskDir: string, phase: Phase): void {
    const contextFiles = loadContextFiles(cwd, "main", "context");
    for (const cf of contextFiles) {
      pi.sendMessage(
        { customType: "pp-context", content: cf.content, display: false },
        { deliverAs: "steer" },
      );
    }
    const artifacts = getPhaseArtifacts(taskDir, phase);
    for (const artifact of artifacts) {
      pi.sendMessage(
        { customType: "pp-artifact", content: `=== ${artifact.name} ===\n${artifact.content}`, display: false },
        { deliverAs: "steer" },
      );
    }
  }

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "Agent" && active) {
      const input = event.input as Record<string, unknown>;
      const requestedType = ((input.subagent_type as string) || "").toLowerCase();
      const isExplore = !requestedType || requestedType === "explore";
      const isLibrarian = requestedType === "librarian";

      if (isExplore) {
        input.subagent_type = `pp_${active.taskId}_explore`;
        input.model = config.agents.explore.model;
        input.thinking = config.agents.explore.thinking;
      } else if (isLibrarian) {
        input.subagent_type = `pp_${active.taskId}_librarian`;
        input.model = config.agents.librarian.model;
        input.thinking = config.agents.librarian.thinking;
      } else {
        input.subagent_type = `pp_${active.taskId}_task`;
        input.model = config.agents.task.model;
        input.thinking = config.agents.task.thinking;
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { file_path?: string; filePath?: string };
      const rawPath = input.file_path || input.filePath || "";
      const resolved = resolve(cwd, rawPath);
      const ppStateDir = resolve(cwd, ".pp", "state");
      const ppDir = resolve(cwd, ".pp");

      if (resolved.startsWith(ppStateDir + "/") || resolved === ppStateDir) {
        if (!resolved.endsWith(".md")) {
          return { block: true, reason: "Cannot write non-.md files in .pp/state/" };
        }
      }

      const fileName = basename(resolved);
      if (fileName === "state.json" && (resolved.startsWith(ppDir + "/") || resolved === ppDir)) {
        return { block: true, reason: "state.json is managed by the extension" };
      }

      if (fileName === "config.json" && (resolved.startsWith(ppDir + "/") || resolved === ppDir)) {
        return { block: true, reason: "config.json is managed by the user, not the LLM" };
      }
    }
    return;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!active || active.state.phase !== "implementation") return;

    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      const input = event.input as { file_path?: string; filePath?: string };
      const filePath = input.file_path || input.filePath;
      if (!filePath) return;

      if (filePath.includes(".pp/")) return;

      active.modifiedFiles.add(filePath);

      const afterEditResults = runAfterEdit(filePath, config, cwd);
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

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!active || active.state.phase === "done") return;

    const artifacts = getPhaseArtifacts(active.dir, active.state.phase);
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

  pi.on("turn_end", async (_event, ctx) => {
    if (!active || active.state.phase === "done") return;
    updateStatus(ctx);

    if (active.state.phase === "implementation" && config.autoCommit && active.modifiedFiles.size > 0) {
      const files = [...active.modifiedFiles];
      const result = autoCommit(files, active.description, cwd);
      if (result.ok) {
        active.modifiedFiles.clear();
      }
    }
  });

  // ─── Commands ────────────────────────────────────────────────────────────

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

        const validation = validateFromPath(cwd, fromPath);
        if (!validation.ok) {
          ctx.ui.notify(validation.reason, "error");
          return;
        }
        fromTaskDir = validation.dir;

        if (fromPath.startsWith("debug/")) {
          skipBrainstorm = true;
        }
      }

      await startTask(ctx, "implement", description, fromTaskDir, skipBrainstorm);
    },
  });

  pi.registerCommand("pp:debug", {
    description: "Start read-only diagnosis: analyze a problem and produce fix recommendations",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pp:debug <problem description>", "warning");
        return;
      }
      await startTask(ctx, "debug", args.trim());
    },
  });

  pi.registerCommand("pp:brainstorm", {
    description: "Start open-ended brainstorming conversation",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pp:brainstorm <topic>", "warning");
        return;
      }
      await startTask(ctx, "brainstorm", args.trim());
    },
  });

  pi.registerCommand("pp:done", {
    description: "Mark current task as done and release lock",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No active task.", "info");
        return;
      }

      abortAllSubagents();
      ctx.abort();
      await ctx.waitForIdle();

      const name = active.description;
      const type = active.type;
      const dir = active.dir;

      active.state.phase = "done";
      saveTask(active.dir, active.state);
      unregisterAgentDefinitions(pi, active.taskId);
      await cleanupActive();

      updateStatus(ctx);

      const urExists = existsSync(join(dir, "USER_REQUEST.md"));
      const resExists = existsSync(join(dir, "RESEARCH.md"));

      if ((type === "brainstorm" || type === "debug") && urExists && resExists) {
        const taskRelPath = relative(join(cwd, ".pp", "state"), dir);
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
      if (active) {
        ctx.ui.notify(`Task "${active.description}" is already active. Run /pp:done first.`, "warning");
        return;
      }

      const tasks = listTasks(cwd);
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
        config = loadConfig(cwd);
      } catch (err: any) {
        ctx.ui.notify(`Config error: ${err.message}`, "error");
        return;
      }

      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockTask(task.dir, config.timeouts);
      } catch (err: any) {
        ctx.ui.notify(`Failed to lock task: ${err.message}`, "error");
        return;
      }

      const reviewRound = task.state.reviewRound ?? 1;
      active = {
        dir: task.dir,
        type: task.type,
        state: task.state,
        release,
        taskId: taskIdFromDir(task.dir),
        modifiedFiles: new Set(),
        reviewRound,
        description: task.state.description,
      };

      const modelConfig = config.mainModel[task.type === "debug" ? "debug" : task.type === "brainstorm" ? "brainstorm" : "implement"];
      const modelOk = await switchModel(ctx, modelConfig.model, modelConfig.thinking);
      if (!modelOk) {
        ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
      }

      registerAgents();
      pi.setSessionName(active.description.slice(0, 50));
      updateStatus(ctx);

      injectContextAndArtifacts(active.dir, active.state.phase);
      pi.sendUserMessage(getPhasePrompt(ctx));
    },
  });

  pi.registerCommand("pp:status", {
    description: "Show current task status",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No active task.", "info");
        return;
      }
      const roundInfo = active.type === "implement" && active.state.phase === "review"
        ? ` | Review round: ${active.reviewRound}/${config.maxAutoReviewRounds}`
        : "";
      ctx.ui.notify(
        `Type: ${active.type} | Phase: ${active.state.phase} | Task: ${active.description} | Age: ${taskAge(active.state)}${roundInfo} | Dir: ${active.dir}`,
        "info",
      );
    },
  });

  pi.registerCommand("pp:next", {
    description: "Validate exit criteria and transition to next phase",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No active task.", "error");
        return;
      }

      const currentPhase = active.state.phase;
      if (currentPhase === "done") {
        ctx.ui.notify("Task is already done.", "info");
        return;
      }

      const exitCheck = validateExitCriteria(active.dir, active.type, currentPhase);
      if (!exitCheck.ok) {
        ctx.ui.notify(`Cannot advance: ${exitCheck.reason}`, "warning");
        pi.sendUserMessage(`/pp:next failed: ${exitCheck.reason}. Please address this before advancing.`);
        return;
      }

      const next = nextPhase(active.type, currentPhase);
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
          ctx.ui.notify("Implementation not approved. Continue reviewing.", "info");
          return;
        }
      }

      if (currentPhase === "implementation") {
        const afterResults = runAfterImplement(config, cwd);
        const failures = afterResults.filter((r) => !r.ok);
        if (failures.length > 0) {
          const failureText = failures.map((f) => `${f.command}: ${f.output}`).join("\n");
          ctx.ui.notify(`afterImplement commands failed:\n${failureText}`, "error");
          pi.sendUserMessage(`afterImplement failed:\n${failureText}\n\nFix these issues before advancing.`);
          return;
        }
      }

      active.state.phase = next;
      saveTask(active.dir, active.state);

      if (next === "done") {
        abortAllSubagents();
        unregisterAgentDefinitions(pi, active.taskId);
        await cleanupActive();
        updateStatus(ctx);
        ctx.ui.notify("Task completed!", "info");
        return;
      }

      updateStatus(ctx);
      updatePhaseTasks();
      injectContextAndArtifacts(active.dir, active.state.phase);
      pi.sendUserMessage(getPhasePrompt(ctx));

      if (next === "planning") {
        spawnPlanners(pi, cwd, active.dir, active.taskId, config).catch((err) => {
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
          if (active.reviewRound > config.maxAutoReviewRounds) {
            ctx.ui.notify(
              `Auto-review round limit reached (${config.maxAutoReviewRounds}). Switching to manual review.`,
              "warning",
            );
          } else {
            const deep = reviewChoice === "Deep auto-review (higher reasoning)";
            const reviewConfig = deep ? deepReviewConfig(config) : config;
            spawnCodeReviewers(pi, cwd, active.dir, active.taskId, reviewConfig, active.reviewRound).catch((err) => {
              console.error(`[pi-pi] spawnCodeReviewers failed: ${err.message}`);
            });
            active.reviewRound++;
            persistReviewRound();
          }
        }
      }
    },
  });
}

function deepReviewConfig(config: PiPiConfig): PiPiConfig {
  const THINKING_UPGRADE: Record<string, string> = { low: "medium", medium: "high", high: "high" };
  const upgraded: Record<string, VariantConfig> = {};
  for (const [name, variant] of Object.entries(config.codeReviewers)) {
    upgraded[name] = { ...variant, thinking: THINKING_UPGRADE[variant.thinking] ?? "high" };
  }
  return { ...config, codeReviewers: upgraded };
}

function ensureGitignore(cwd: string): void {
  const ppDir = join(cwd, ".pp");
  if (!existsSync(ppDir)) {
    mkdirSync(ppDir, { recursive: true });
  }

  const gitignorePath = join(ppDir, ".gitignore");
  const requiredEntries = ["state/", "config.json"];

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, requiredEntries.join("\n") + "\n", "utf-8");
  } else {
    let content = readFileSync(gitignorePath, "utf-8");
    for (const entry of requiredEntries) {
      if (!content.includes(entry)) {
        content = content.trimEnd() + "\n" + entry + "\n";
      }
    }
    writeFileSync(gitignorePath, content, "utf-8");
  }
}
