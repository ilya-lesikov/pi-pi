import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { GLOBAL_CONFIG_PATH, mergeConfigLayers, readRawConfig, type NormalizedPiPiConfig } from "./config.js";
import { loadFlantSettings, readClaudeOAuthToken, readGatewayApiKey } from "./flant-infra.js";
import { resolveModel } from "./model-registry.js";
import { listLayeredSkills } from "./skills-manifest.js";
import type { Orchestrator } from "./orchestrator.js";

type Severity = "pass" | "warning" | "failure";

function statusSymbol(severity: Severity): string {
  if (severity === "pass") return "✓";
  if (severity === "warning") return "⚠";
  return "✗";
}

function which(bin: string): string | null {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(whichCmd, [bin], { encoding: "utf-8", stdio: "pipe" });
    return out.split("\n").map((line) => line.trim()).find((line) => line.length > 0) || null;
  } catch {
    return null;
  }
}

function listAvailableSpecs(ctx: any): Set<string> {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return new Set();
  return new Set(
    available.flatMap((model: any) =>
      typeof model?.provider === "string" && typeof model?.id === "string" ? [`${model.provider.trim()}/${model.id.trim()}`] : []),
  );
}

export async function runDoctor(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const lines: string[] = ["Doctor Results"];
  let pass = 0;
  let warn = 0;
  let fail = 0;
  const add = (severity: Severity, text: string) => {
    if (severity === "pass") pass += 1;
    else if (severity === "warning") warn += 1;
    else fail += 1;
    lines.push(`  ${statusSymbol(severity)} ${text}`);
  };
  const category = (name: string) => lines.push("", name);

  const config: NormalizedPiPiConfig = orchestrator.config;

  category("Config");
  try {
    mergeConfigLayers(readRawConfig(GLOBAL_CONFIG_PATH), readRawConfig(join(orchestrator.cwd, ".pp", "config.json")));
    add("pass", "Global and project config merge cleanly");
  } catch (error: any) {
    add("failure", `Config merge failed: ${error?.message ?? String(error)}`);
  }
  if (orchestrator.configError) add("failure", `Startup config error: ${orchestrator.configError}`);
  if (orchestrator.duplicateExtensionError) add("failure", "Duplicate extension copies detected (see startup notification)");

  category("Models");
  const availableSpecs = listAvailableSpecs(ctx);
  if (availableSpecs.size === 0) {
    add("warning", "Model registry unavailable — cannot verify agent model routing");
  } else {
    const roles: Array<{ label: string; model: string }> = [
      { label: "agents.main", model: config.agents.main.model },
      { label: "agents.subagents.simple.explore", model: config.agents.subagents.simple.explore.model },
      { label: "agents.subagents.simple.librarian", model: config.agents.subagents.simple.librarian.model },
      { label: "agents.subagents.simple.task", model: config.agents.subagents.simple.task.model },
    ];
    for (const pool of ["advisors", "reviewers", "deepDebuggers"] as const) {
      config.agents.subagents.pools[pool].forEach((entry, i) => {
        if (entry.enabled !== false) roles.push({ label: `pools.${pool}[${i}]`, model: entry.model });
      });
    }
    for (const role of roles) {
      const resolved = resolveModel(role.model);
      if (availableSpecs.has(resolved)) add("pass", `${role.label}: ${role.model} → ${resolved}`);
      else add("warning", `${role.label}: ${role.model} → ${resolved} is not in the available model list`);
    }
  }

  category("Flant");
  const flant = loadFlantSettings(orchestrator.cwd);
  if (!flant.enabled) {
    add("pass", "Flant disabled");
  } else {
    if (readGatewayApiKey()) add("pass", "Gateway API key present");
    else add("failure", "Flant enabled but no gateway key (set LLM_API_KEY or FLANT_API_KEY)");
    if (flant.subscription) {
      if (readClaudeOAuthToken()) add("pass", "Claude OAuth token present for the personal subscription");
      else add("failure", "Subscription enabled but no Claude OAuth token (run /login → Anthropic)");
    }
    if (flant.copilotEnabled && !process.env.COPILOT_GITHUB_TOKEN) add("warning", "Copilot tier enabled but COPILOT_GITHUB_TOKEN is missing");
    add(flant.lastUpdated ? "pass" : "warning", `Model list last updated: ${flant.lastUpdated ?? "never"}`);
  }

  category("Environment");
  add(which("git") ? "pass" : "failure", "git binary on PATH");
  add(existsSync(join(orchestrator.cwd, ".git")) ? "pass" : "warning", `Working directory is a git repository (${orchestrator.cwd})`);
  const skills = listLayeredSkills(orchestrator.cwd);
  add(skills.length > 0 ? "pass" : "warning", `${skills.length} skills discovered`);
  const subagentsReady = !!(globalThis as any)[Symbol.for("pi-subagents:manager")];
  add(subagentsReady ? "pass" : "warning", "pi-subagents worker manager registered");
  const lspReady = !!(globalThis as any)[Symbol.for("pi-lsp:api")];
  add(lspReady ? "pass" : "warning", "pi-lsp API registered");

  lines.push("", `Summary: ${pass} passed, ${warn} warnings, ${fail} failures`);
  ctx.ui?.notify?.(lines.join("\n"), fail > 0 ? "error" : warn > 0 ? "warning" : "info");
}
