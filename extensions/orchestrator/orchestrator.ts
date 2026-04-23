import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, basename, relative } from "path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, type PiPiConfig, type VariantConfig } from "./config.js";
import {
  createTask,
  loadTask,
  saveTask,
  lockTask,
  type TaskType,
  type TaskState,
  type Phase,
} from "./state.js";
import { phasePipeline } from "./phases/machine.js";
import { loadContextFiles, getPhaseArtifacts } from "./context.js";
import { brainstormSystemPrompt } from "./phases/brainstorm.js";
import { planningSystemPrompt, spawnPlanners } from "./phases/planning.js";
import { implementationSystemPrompt } from "./phases/implementation.js";
import { reviewSystemPrompt } from "./phases/review.js";
import { registerAgentDefinitions, unregisterAgentDefinitions } from "./agents/registry.js";
import { createExploreAgent } from "./agents/explore.js";
import { createLibrarianAgent } from "./agents/librarian.js";
import { createTaskAgent } from "./agents/task.js";

const BUNDLED_TOOLS = new Set([
  "Agent", "get_subagent_result", "steer_subagent",
  "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute",
  "ask_user",
]);

export interface ActiveTask {
  dir: string;
  type: TaskType;
  state: TaskState;
  release: (() => Promise<void>) | null;
  taskId: string;
  modifiedFiles: Set<string>;
  reviewRound: number;
  description: string;
}

export class Orchestrator {
  active: ActiveTask | null = null;
  config!: PiPiConfig;
  cwd = "";
  spawnedAgentIds = new Set<string>();
  agentDescriptions = new Map<string, string>();
  phaseCompactionPending = false;
  phaseCompactionResolve: (() => void) | null = null;
  nudgeTimestamps: number[] = [];
  cooldownHits: number[] = [];
  nudgeHalted = false;
  manualReview = false;

  constructor(readonly pi: ExtensionAPI) {}

  truncateResult(result: string): string {
    const trimmed = result.trim();
    if (!trimmed) return "";
    const lines = trimmed.split("\n");
    if (lines.length <= 20 && trimmed.length <= 2000) return trimmed;
    const truncated = lines.slice(0, 20).join("\n").slice(0, 2000);
    return truncated + "\n…(truncated)";
  }

  async switchModel(ctx: ExtensionContext, modelSpec: string, thinking: string): Promise<boolean> {
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

    const ok = await this.pi.setModel(resolved);
    if (!ok) return false;

    const thinkingLevel = thinking as "off" | "low" | "medium" | "high";
    this.pi.setThinkingLevel(thinkingLevel);
    return true;
  }

  updateStatus(ctx: ExtensionContext): void {
    if (!this.active) {
      ctx.ui.setStatus("pi-pi", undefined);
      return;
    }
    ctx.ui.setStatus("pi-pi", `${this.active.state.phase} — ${this.active.description}`);
  }

  createPhaseTasks(): void {
    if (!this.active || this.active.type !== "implement") return;

    const currentPhase = this.active.state.phase;
    const phases = phasePipeline(this.active.type).filter((p) => p !== "done");
    const currentIdx = phases.indexOf(currentPhase as typeof phases[number]);
    const lines = phases.map((p, i) => {
      const status = i < currentIdx ? "completed" : p === currentPhase ? "in_progress" : "pending";
      const blockedBy = i > currentIdx ? ` (blocked by #${i})` : "";
      return `${i + 1}. "${p}" (status: ${status})${blockedBy}`;
    });

    this.pi.sendMessage(
      {
        customType: "pp-task-init",
        content: `Create tracking tasks for the orchestration phases using TaskCreate:\n${lines.join("\n")}`,
        display: false,
      },
      { deliverAs: "steer" },
    );
  }

  updatePhaseTasks(): void {
    if (!this.active || this.active.type !== "implement") return;

    this.pi.sendMessage(
      {
        customType: "pp-task-update",
        content: `Update tracking tasks: mark current phase "${this.active.state.phase}" as in_progress, mark previous phases as completed using TaskUpdate.`,
        display: false,
      },
      { deliverAs: "steer" },
    );
  }

  getPhasePrompt(_ctx: ExtensionContext): string {
    if (!this.active) return "";

    switch (this.active.state.phase) {
      case "brainstorm":
      case "active":
      case "diagnosing":
        return brainstormSystemPrompt(this.active.type, this.active.description, this.active.dir);
      case "planning":
        return planningSystemPrompt(this.active.dir);
      case "implementation":
        return implementationSystemPrompt(this.active.dir);
      case "review":
        return reviewSystemPrompt(this.active.dir, this.active.reviewRound, this.manualReview);
      default:
        return "";
    }
  }

  taskIdFromDir(dir: string): string {
    const name = basename(dir);
    return name.split("_")[0];
  }

  persistReviewRound(): void {
    if (!this.active) return;
    this.active.state.reviewRound = this.active.reviewRound;
    saveTask(this.active.dir, this.active.state);
  }

  async startTask(
    ctx: ExtensionCommandContext,
    type: TaskType,
    description: string,
    fromTaskDir?: string,
    skipBrainstorm?: boolean,
  ): Promise<void> {
    if (this.active) {
      ctx.ui.notify(
        `Finishing previous task "${this.active.description}" (phase: ${this.active.state.phase})…`,
        "info",
      );
      this.abortAllSubagents();
      this.active.state.phase = "done";
      saveTask(this.active.dir, this.active.state);
      unregisterAgentDefinitions(this.pi);
      await this.cleanupActive();
    }

    try {
      this.config = loadConfig(this.cwd);
    } catch (err: any) {
      ctx.ui.notify(`Config error: ${err.message}`, "error");
      return;
    }

    ensureGitignore(this.cwd);

    const dir = createTask(this.cwd, type, description);
    const state = loadTask(dir);

    if (fromTaskDir) {
      const srcUr = join(fromTaskDir, "USER_REQUEST.md");
      const srcRes = join(fromTaskDir, "RESEARCH.md");
      if (existsSync(srcUr)) copyFileSync(srcUr, join(dir, "USER_REQUEST.md"));
      if (existsSync(srcRes)) copyFileSync(srcRes, join(dir, "RESEARCH.md"));
      state.from = relative(join(this.cwd, ".pp", "state"), fromTaskDir);
      if (skipBrainstorm && type === "implement") {
        state.phase = "planning";
      }
      saveTask(dir, state);
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockTask(dir, this.config.timeouts);
    } catch (err: any) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        console.error(`[pi-pi] Failed to clean up orphaned task dir: ${dir}`);
      }
      ctx.ui.notify(`Failed to lock task: ${err.message}`, "error");
      return;
    }

    this.active = {
      dir,
      type,
      state,
      release,
      taskId: this.taskIdFromDir(dir),
      modifiedFiles: new Set(),
      reviewRound: 1,
      description: state.description,
    };

    const modelConfig = this.config.mainModel[type === "debug" ? "debug" : type === "brainstorm" ? "brainstorm" : "implement"];
    const modelOk = await this.switchModel(ctx, modelConfig.model, modelConfig.thinking);
    if (!modelOk) {
      ctx.ui.notify(`Model "${modelConfig.model}" not found — using current model`, "warning");
    }

    this.registerAgents();
    this.pi.setSessionName(this.active.description.slice(0, 50));
    this.updateStatus(ctx);

    this.injectContextAndArtifacts(this.active.dir, this.active.state.phase);
    this.createPhaseTasks();
    this.pi.sendUserMessage(this.getPhasePrompt(ctx));

    if (this.active.state.phase === "planning") {
      spawnPlanners(this.pi, this.cwd, this.active.dir, this.active.taskId, this.config).catch((err) => {
        console.error(`[pi-pi] spawnPlanners failed: ${err.message}`);
      });
    }
  }

  abortAllSubagents(): void {
    for (const agentId of this.spawnedAgentIds) {
      this.pi.events.emit("subagents:rpc:stop", {
        requestId: crypto.randomUUID(),
        agentId,
      });
    }
    this.spawnedAgentIds.clear();
  }

  async cleanupActive(): Promise<void> {
    if (!this.active) return;
    if (this.active.release) {
      try {
        await this.active.release();
      } catch (err: any) {
        console.error(`[pi-pi] Failed to release lock for ${this.active.dir}: ${err.message}`);
      }
    }
    this.active = null;
  }

  registerAgents(): void {
    const explore = createExploreAgent(this.config);
    const librarian = createLibrarianAgent(this.config);
    const taskAgent = createTaskAgent(this.config, "{{subtask}}", { userRequest: "", synthesizedPlan: "" });
    registerAgentDefinitions(this.pi, [
      { type: "explore", variant: null, ...explore },
      { type: "librarian", variant: null, ...librarian },
      { type: "task", variant: null, ...taskAgent },
    ]);
  }

  injectContextAndArtifacts(taskDir: string, phase: Phase): void {
    const contextFiles = loadContextFiles(this.cwd, "main", "context");
    for (const cf of contextFiles) {
      this.pi.sendMessage(
        { customType: "pp-context", content: cf.content, display: false },
        { deliverAs: "steer" },
      );
    }
    const artifacts = getPhaseArtifacts(taskDir, phase);
    for (const artifact of artifacts) {
      this.pi.sendMessage(
        { customType: "pp-artifact", content: `=== ${artifact.name} ===\n${artifact.content}`, display: false },
        { deliverAs: "steer" },
      );
    }
  }

  compactAndTransition(ctx: ExtensionContext, taskDir: string, phase: Phase): void {
    this.phaseCompactionPending = true;
    ctx.compact({
      customInstructions: "Phase transition — discard all prior conversation. Produce a one-line summary: 'Previous phase completed.'",
      onComplete: () => {
        this.phaseCompactionPending = false;
        if (this.phaseCompactionResolve) {
          this.phaseCompactionResolve();
          this.phaseCompactionResolve = null;
        }
        this.injectContextAndArtifacts(taskDir, phase);
        this.pi.sendUserMessage(this.getPhasePrompt(ctx));
      },
      onError: (err) => {
        console.error(`[pi-pi] Phase compaction failed: ${err.message}`);
        this.phaseCompactionPending = false;
        if (this.phaseCompactionResolve) {
          this.phaseCompactionResolve();
          this.phaseCompactionResolve = null;
        }
        this.injectContextAndArtifacts(taskDir, phase);
        this.pi.sendUserMessage(this.getPhasePrompt(ctx));
      },
    });
  }

  checkForConflictingExtensions(): string[] {
    const allTools = this.pi.getAllTools();
    const seen = new Map<string, number>();
    for (const tool of allTools) {
      if (BUNDLED_TOOLS.has(tool.name)) {
        seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
      }
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  }
}

export function deepReviewConfig(config: PiPiConfig): PiPiConfig {
  const THINKING_UPGRADE: Record<string, string> = { low: "medium", medium: "high", high: "high" };
  const upgraded: Record<string, VariantConfig> = {};
  for (const [name, variant] of Object.entries(config.codeReviewers)) {
    upgraded[name] = { ...variant, thinking: THINKING_UPGRADE[variant.thinking] ?? "high" };
  }
  return { ...config, codeReviewers: upgraded };
}

export function ensureGitignore(cwd: string): void {
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
