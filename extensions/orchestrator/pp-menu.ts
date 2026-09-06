import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";
import { GLOBAL_CONFIG_PATH, loadConfig, writeConfigValue } from "./config.js";
import { listLayeredSkills } from "./skills-manifest.js";
import { buildPoolRoster } from "./agents/registry.js";
import type { Orchestrator } from "./orchestrator.js";

interface Option {
  title: string;
  description?: string;
}

const BACK = "Back";
const CLOSE = "Close";

async function select(orchestrator: Orchestrator, ctx: any, question: string, options: Option[]): Promise<string | undefined> {
  orchestrator.interactivePromptOpen = true;
  try {
    const result = await askUser(ctx, { question, options, allowFreeform: false, allowComment: false, allowMultiple: false });
    if (!result || isCancel(result) || result.kind !== "selection") return undefined;
    return result.selections[0];
  } finally {
    orchestrator.interactivePromptOpen = false;
  }
}

function workerRecords(): any[] {
  const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  const records = manager?.listAgents?.();
  return Array.isArray(records) ? records : [];
}

async function showWorkers(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const records = workerRecords();
    const active = records.filter((record) => record.status === "running" || record.status === "queued");
    const choice = await select(orchestrator, ctx, "Workers", [
      { title: "Open worker dashboard", description: `${active.length} active, ${records.length} recorded` },
      ...(active.length ? [{ title: "Stop all active workers", description: "Abort bounded background work; the main session continues." }] : []),
      { title: BACK },
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Open worker dashboard") {
      try {
        await ctx.ui.executeCommand?.("subagents");
      } catch {
        ctx.ui?.notify?.(records.length ? records.map((r) => `${r.status}: ${r.description ?? r.type ?? r.id}`).join("\n") : "No workers recorded.", "info");
      }
      continue;
    }
    if (choice === "Stop all active workers") orchestrator.abortAllSubagents();
  }
}

async function showSkills(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const enabled = orchestrator.config.skills;
    const skills = listLayeredSkills(orchestrator.cwd).filter((skill) =>
      (skill.layer === "bundled" && enabled.loadBundled)
      || (skill.layer === "global" && enabled.loadGlobal)
      || (skill.layer === "project" && enabled.loadProject));
    const choice = await select(orchestrator, ctx, "Skills", [
      { title: "Catalog", description: `${skills.length} skills available to the agent` },
      { title: "Source settings", description: `bundled ${enabled.loadBundled ? "on" : "off"} · global ${enabled.loadGlobal ? "on" : "off"} · project ${enabled.loadProject ? "on" : "off"}` },
      { title: BACK },
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Source settings") {
      await showSkillSettings(orchestrator, ctx);
      continue;
    }
    if (choice === "Catalog") ctx.ui?.notify?.(skills.map((skill) => `${skill.name} (${skill.layer}): ${skill.description}`).join("\n") || "No skills available.", "info");
  }
}

async function showSkillSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const labels = { loadBundled: "Bundled", loadGlobal: "Global", loadProject: "Project" } as const;
  for (;;) {
    const choice = await select(orchestrator, ctx, "Skill sources", [
      ...Object.entries(labels).map(([key, label]) => ({ title: label, description: orchestrator.config.skills[key as keyof typeof labels] ? "enabled" : "disabled" })),
      { title: BACK },
    ]);
    if (!choice || choice === BACK) return;
    const entry = Object.entries(labels).find(([, label]) => label === choice);
    if (!entry) continue;
    const key = entry[0] as keyof typeof labels;
    writeConfigValue(GLOBAL_CONFIG_PATH, ["skills", key], !orchestrator.config.skills[key]);
    orchestrator.config = loadConfig(orchestrator.cwd);
  }
}

function showMemory(orchestrator: Orchestrator, ctx: any): void {
  const usage = ctx.getContextUsage?.();
  const context = usage && typeof usage.contextWindow === "number"
    ? `${usage.tokens ?? "?"} / ${usage.contextWindow} tokens${typeof usage.percent === "number" ? ` (${usage.percent.toFixed(1)}%)` : ""}`
    : "Context usage unavailable";
  ctx.ui?.notify?.(`${context}\nAutomatic compaction: ${orchestrator.config.compaction.enabled ? "VCC enabled" : "disabled"}\nSession history is searchable by the agent with vcc_recall.`, "info");
}

async function showAgents(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const config = orchestrator.config.agents;
  const lines = [
    `Main: ${config.main.model} · ${config.main.thinking}`,
    `Explore: ${config.subagents.simple.explore.model} · ${config.subagents.simple.explore.thinking}`,
    `Librarian: ${config.subagents.simple.librarian.model} · ${config.subagents.simple.librarian.thinking}`,
    `Task: ${config.subagents.simple.task.model} · ${config.subagents.simple.task.thinking}`,
    `Advisors: ${buildPoolRoster(orchestrator.config, "advisors").map((entry) => entry.model).join(", ") || "none"}`,
    `Reviewers: ${buildPoolRoster(orchestrator.config, "reviewers").map((entry) => entry.model).join(", ") || "none"}`,
    `Deep debuggers: ${buildPoolRoster(orchestrator.config, "deepDebuggers").map((entry) => entry.model).join(", ") || "none"}`,
    `Concurrency: ${config.maxConcurrentSubagents}`,
  ];
  ctx.ui?.notify?.(lines.join("\n"), "info");
}

function sessionStatus(orchestrator: Orchestrator, ctx: any): string {
  const usage = ctx.getContextUsage?.();
  const active = workerRecords().filter((record) => record.status === "running" || record.status === "queued").length;
  return [
    `Session: ${ctx.sessionManager?.getSessionName?.() || ctx.sessionManager?.getSessionId?.() || "current"}`,
    `Directory: ${orchestrator.cwd}`,
    `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
    `Context: ${usage?.tokens ?? "?"} / ${usage?.contextWindow ?? "?"} tokens`,
    `Workers: ${active} active`,
    `Skills: ${listLayeredSkills(orchestrator.cwd).length} discovered`,
    "Mode: direct session ownership (no phases or isolated tasks)",
  ].join("\n");
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const choice = await select(orchestrator, ctx, "/pp · session control panel", [
      { title: "Status", description: "Session, model, context, workers, and skills" },
      { title: "Workers", description: "Inspect or stop bounded background workers" },
      { title: "Skills", description: "Inspect available bundled, global, and project guidance" },
      { title: "Memory", description: "Automatic compaction and recall status" },
      { title: "Agents", description: "Current main and worker model configuration" },
      { title: "Provider settings", description: "Use /model for the live model; scoped config remains in .pp/config.json" },
      { title: CLOSE },
    ]);
    if (!choice || choice === CLOSE) return;
    if (choice === "Status") ctx.ui?.notify?.(sessionStatus(orchestrator, ctx), "info");
    else if (choice === "Workers") await showWorkers(orchestrator, ctx);
    else if (choice === "Skills") await showSkills(orchestrator, ctx);
    else if (choice === "Memory") showMemory(orchestrator, ctx);
    else if (choice === "Agents") await showAgents(orchestrator, ctx);
    else if (choice === "Provider settings") ctx.ui?.notify?.("Use /model to change the live model. Configure persistent main/worker routing in global or project .pp/config.json.", "info");
  }
}
