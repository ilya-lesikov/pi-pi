import { execFileSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  readRawConfig,
  GLOBAL_CONFIG_PATH,
  loadConfig,
  resolvePreset,
  type NormalizedPiPiConfig,
  type PiPiConfig,
  PRESET_GROUPS,
} from "./config.js";
import { resolveModel, getAllAliases } from "./model-registry.js";
import { discoverFlantModels, fetchOpenRouterMetadata, loadFlantSettings } from "./flant-infra.js";
import type { Orchestrator } from "./orchestrator.js";

type Severity = "pass" | "warning" | "failure";

interface CheckLine {
  severity: Severity;
  text: string;
}

interface AvailableModel {
  provider: string;
  id: string;
  spec: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

function flantCacheDir(): string {
  return join(resolveAgentDir(), "extensions", "pp", "cache");
}

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf-8", stdio: "pipe" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function commandBinary(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^("[^"]+"|'[^']+'|`[^`]+`|\S+)/);
  if (!match) return null;
  return match[1]?.replace(/^['"`]|['"`]$/g, "") ?? null;
}

function listAvailableModels(ctx: any): AvailableModel[] {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return [];
  const seen = new Set<string>();
  const out: AvailableModel[] = [];
  for (const model of available) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const spec = `${provider}/${id}`;
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, id, spec });
  }
  return out;
}

function collectEmptyObjects(value: unknown, basePath: string, out: string[]): void {
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length === 0) {
    out.push(basePath);
    return;
  }
  for (const key of keys) {
    const nestedPath = `${basePath}.${key}`;
    collectEmptyObjects((value as Record<string, unknown>)[key], nestedPath, out);
  }
}

function statusSymbol(severity: Severity): string {
  if (severity === "pass") return "✓";
  if (severity === "warning") return "⚠";
  return "✗";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runDoctor(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const reportLines: string[] = ["Doctor Results"];
  let passCount = 0;
  let warningCount = 0;
  let failureCount = 0;

  const addCategory = (name: string): void => {
    reportLines.push("", name);
  };

  const addLine = (line: CheckLine): void => {
    if (line.severity === "pass") passCount += 1;
    else if (line.severity === "warning") warningCount += 1;
    else failureCount += 1;
    reportLines.push(`  ${statusSymbol(line.severity)} ${line.text}`);
  };

  const safeCheck = async (run: () => void | Promise<void>, onError: string): Promise<void> => {
    try {
      await run();
    } catch (error) {
      addLine({ severity: "failure", text: `${onError}: ${toErrorMessage(error)}` });
    }
  };

  const projectConfigPath = join(orchestrator.cwd, ".pp", "config.json");
  let availableModels: AvailableModel[] = [];
  let availableSet = new Set<string>();
  const config: NormalizedPiPiConfig = orchestrator.config;

  addCategory("Config");

  await safeCheck(() => {
    const paths = [
      { label: "global", path: GLOBAL_CONFIG_PATH },
      { label: "project", path: projectConfigPath },
    ];
    const errors: string[] = [];
    for (const entry of paths) {
      try {
        readRawConfig(entry.path);
      } catch (error) {
        errors.push(`${entry.label}: ${toErrorMessage(error)}`);
      }
    }
    if (errors.length > 0) {
      addLine({ severity: "failure", text: `Config files parseable: ${errors.join("; ")}` });
      return;
    }
    addLine({ severity: "pass", text: "Config files parseable" });
  }, "Config files parseable check failed");

  await safeCheck(() => {
    loadConfig(orchestrator.cwd);
    addLine({ severity: "pass", text: "4-layer merge OK" });
  }, "4-layer merge failed");

  await safeCheck(() => {
    const knownTopLevelKeys = new Set(["general", "agents", "commands", "performance"]);
    const unknown: string[] = [];
    const files = [
      { label: "global", path: GLOBAL_CONFIG_PATH },
      { label: "project", path: projectConfigPath },
    ];
    for (const file of files) {
      const raw = readRawConfig(file.path);
      if (!isObject(raw)) continue;
      for (const key of Object.keys(raw)) {
        if (!knownTopLevelKeys.has(key)) unknown.push(`${file.label}.${key}`);
      }
    }
    if (unknown.length === 0) {
      addLine({ severity: "pass", text: "No legacy/unknown top-level keys" });
      return;
    }
    addLine({ severity: "warning", text: `Unknown top-level keys: ${unknown.join(", ")}` });
  }, "Legacy/unknown key check failed");

  await safeCheck(() => {
    const emptyPaths: string[] = [];
    const files = [
      { label: "global", path: GLOBAL_CONFIG_PATH },
      { label: "project", path: projectConfigPath },
    ];
    for (const file of files) {
      const raw = readRawConfig(file.path);
      if (!isObject(raw)) continue;
      collectEmptyObjects(raw, file.label, emptyPaths);
    }
    if (emptyPaths.length === 0) {
      addLine({ severity: "pass", text: "No empty overrides" });
      return;
    }
    addLine({ severity: "warning", text: `Empty override objects: ${emptyPaths.join(", ")}` });
  }, "Empty override check failed");

  addCategory("Models");

  await safeCheck(() => {
    availableModels = listAvailableModels(ctx);
    availableSet = new Set(availableModels.map((m) => m.spec));
    addLine({ severity: "pass", text: `${availableSet.size} models available` });
  }, "Available models listing failed");

  await safeCheck(() => {
    const missing: string[] = [];
    for (const [role, roleConfig] of Object.entries(config.agents.orchestrators)) {
      const resolved = resolveModel(roleConfig.model);
      if (!availableSet.has(resolved)) {
        missing.push(`${role} → ${roleConfig.model} resolved to ${resolved}`);
      }
    }
    if (missing.length === 0) {
      addLine({ severity: "pass", text: "All orchestrator models available" });
      return;
    }
    for (const item of missing) {
      addLine({ severity: "failure", text: `Orchestrator model missing: ${item}` });
    }
  }, "Orchestrator model availability check failed");

  await safeCheck(() => {
    const missing: string[] = [];
    for (const [role, roleConfig] of Object.entries(config.agents.subagents.simple)) {
      const resolved = resolveModel(roleConfig.model);
      if (!availableSet.has(resolved)) {
        missing.push(`${role} → ${roleConfig.model} resolved to ${resolved}`);
      }
    }
    if (missing.length === 0) {
      addLine({ severity: "pass", text: "All subagent models available" });
      return;
    }
    for (const item of missing) {
      addLine({ severity: "failure", text: `Subagent model missing: ${item}` });
    }
  }, "Subagent model availability check failed");

  await safeCheck(() => {
    const missing: string[] = [];
    for (const group of PRESET_GROUPS) {
      const groupConfig = config.agents.subagents.presetGroups[group];
      for (const [presetName, preset] of Object.entries(groupConfig.presets)) {
        if (preset.enabled === false) continue;
        for (const [agentName, agent] of Object.entries(preset.agents)) {
          if (agent.enabled === false) continue;
          const resolved = resolveModel(agent.model);
          if (!availableSet.has(resolved)) {
            missing.push(`Preset "${presetName}" group "${group}" agent "${agentName}" → ${resolved} not available`);
          }
        }
      }
    }
    if (missing.length === 0) {
      addLine({ severity: "pass", text: "All enabled preset agent models available" });
      return;
    }
    for (const item of missing) {
      addLine({ severity: "warning", text: item });
    }
  }, "Preset model availability check failed");

  await safeCheck(() => {
    const aliasCount = Object.keys(getAllAliases()).length;
    addLine({ severity: "pass", text: `Model alias registry loaded (${aliasCount} aliases)` });
  }, "Model alias registry check failed");

  addCategory("Presets");

  await safeCheck(() => {
    for (const group of PRESET_GROUPS) {
      const groupConfig = config.agents.subagents.presetGroups[group];
      const defaultPresetName = groupConfig.default;
      const defaultPreset = groupConfig.presets[defaultPresetName];
      if (!defaultPreset) {
        addLine({ severity: "failure", text: `${group}: default preset "${defaultPresetName}" is missing` });
        continue;
      }
      if (defaultPreset.enabled === false) {
        addLine({ severity: "failure", text: `${group}: default preset "${defaultPresetName}" is disabled` });
        continue;
      }
      const totalAgents = Object.keys(defaultPreset.agents).length;
      const enabledAgents = Object.values(defaultPreset.agents).filter((agent) => agent.enabled !== false).length;
      if (enabledAgents === 0) {
        addLine({ severity: "failure", text: `${group}: default preset "${defaultPresetName}" has no enabled agents` });
        continue;
      }
      const resolved = resolvePreset(config as PiPiConfig, group);
      addLine({
        severity: "pass",
        text: `${group}: default="${defaultPresetName}", total agents=${totalAgents}, enabled agents=${enabledAgents}, resolved agents=${Object.keys(resolved).length}`,
      });
    }
  }, "Preset consistency checks failed");

  addCategory("Tools");

  await safeCheck(() => {
    const cbmBin = which("codebase-memory-mcp");
    if (cbmBin) addLine({ severity: "pass", text: `codebase-memory-mcp: ${cbmBin}` });
    else addLine({ severity: "warning", text: "codebase-memory-mcp: not found" });

    if (!cbmBin) {
      addLine({ severity: "warning", text: "CBM daemon: skipped (binary not found)" });
      return;
    }

    const daemon = (globalThis as any)[Symbol.for("pi-pi:cbm-daemon")] as { proc?: unknown } | null | undefined;
    if (daemon && daemon.proc !== null && daemon.proc !== undefined) {
      addLine({ severity: "pass", text: "CBM daemon: initialized" });
      return;
    }
    addLine({ severity: "warning", text: "CBM daemon: not initialized" });
  }, "CBM checks failed");

  await safeCheck(() => {
    const sgBin = which("sg");
    if (sgBin) addLine({ severity: "pass", text: `sg (ast-grep): ${sgBin}` });
    else addLine({ severity: "warning", text: "sg (ast-grep): not found" });
  }, "ast-grep check failed");

  addCategory("Commands");

  await safeCheck(() => {
    const afterEditEntries = Object.entries(config.commands.afterEdit);
    if (afterEditEntries.length === 0) {
      addLine({ severity: "pass", text: "No afterEdit commands configured" });
    }
    for (const [name, command] of afterEditEntries) {
      const bin = commandBinary(command.run);
      if (!bin) {
        addLine({ severity: "failure", text: `afterEdit.${name}: cannot determine binary from "${command.run}"` });
      } else {
        const binaryPath = which(bin);
        if (binaryPath) addLine({ severity: "pass", text: `afterEdit.${name}: ${bin} found at ${binaryPath}` });
        else addLine({ severity: "failure", text: `afterEdit.${name}: ${bin} not found in PATH` });
      }

      if (command.globs !== undefined) {
        const invalidGlob = command.globs.find((glob) => typeof glob !== "string" || glob.trim().length === 0);
        if (invalidGlob !== undefined) {
          addLine({ severity: "warning", text: `afterEdit.${name}: invalid glob pattern` });
        } else {
          addLine({ severity: "pass", text: `afterEdit.${name}: glob patterns valid (${command.globs.length})` });
        }
      }
    }

    const afterImplementEntries = Object.entries(config.commands.afterImplement);
    if (afterImplementEntries.length === 0) {
      addLine({ severity: "pass", text: "No afterImplement commands configured" });
    }
    for (const [name, command] of afterImplementEntries) {
      const bin = commandBinary(command.run);
      if (!bin) {
        addLine({ severity: "failure", text: `afterImplement.${name}: cannot determine binary from "${command.run}"` });
        continue;
      }
      const binaryPath = which(bin);
      if (binaryPath) addLine({ severity: "pass", text: `afterImplement.${name}: ${bin} found at ${binaryPath}` });
      else addLine({ severity: "failure", text: `afterImplement.${name}: ${bin} not found in PATH` });
    }
  }, "Command checks failed");

  addCategory("Flant");

  await safeCheck(async () => {
    const settings = loadFlantSettings();
    const shouldCheck = Boolean(process.env.FLANT_API_KEY) || settings.enabled || !!settings.cachedFlantModels || !!settings.cachedOpenRouterData;
    if (!shouldCheck) {
      addLine({ severity: "pass", text: "Skipped: FLANT_API_KEY not set and no Flant configuration detected" });
      return;
    }

    const apiKey = process.env.FLANT_API_KEY;
    if (apiKey) addLine({ severity: "pass", text: "FLANT_API_KEY is present" });
    else addLine({ severity: "failure", text: "FLANT_API_KEY is missing" });

    const cacheDir = flantCacheDir();
    const probePath = join(cacheDir, `doctor-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      writeFileSync(probePath, "ok", "utf-8");
      unlinkSync(probePath);
      addLine({ severity: "pass", text: `Flant cache directory writable: ${cacheDir}` });
    } catch (error) {
      addLine({ severity: "failure", text: `Flant cache directory is not writable: ${toErrorMessage(error)}` });
    }

    if (apiKey) {
      const started = Date.now();
      try {
        const models = await withTimeout(discoverFlantModels(apiKey), 15000, "discoverFlantModels");
        addLine({ severity: "pass", text: `Flant API reachable (${Date.now() - started}ms, ${models.length} models)` });
      } catch (error) {
        addLine({ severity: "failure", text: `Flant API probe failed: ${toErrorMessage(error)}` });
      }
    } else {
      addLine({ severity: "failure", text: "Flant API probe failed: FLANT_API_KEY is required" });
    }

    const openRouterStarted = Date.now();
    try {
      await withTimeout(fetchOpenRouterMetadata([]), 15000, "fetchOpenRouterMetadata");
      addLine({ severity: "pass", text: `OpenRouter probe completed (${Date.now() - openRouterStarted}ms)` });
    } catch (error) {
      addLine({ severity: "failure", text: `OpenRouter probe failed: ${toErrorMessage(error)}` });
    }
  }, "Flant checks failed");

  addCategory("LSP");

  await safeCheck(async () => {
    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as { status?: (menuCtx: any) => Promise<void> | void } | undefined;
    if (!api) {
      addLine({ severity: "warning", text: "LSP API: not available" });
      addLine({ severity: "warning", text: "LSP status details are not programmatically exposed in Doctor" });
      return;
    }
    if (typeof api.status === "function") {
      await api.status(ctx);
      addLine({ severity: "pass", text: "LSP API: available (status method callable)" });
    } else {
      addLine({ severity: "pass", text: "LSP API: available" });
    }
    addLine({ severity: "warning", text: "LSP status details are not programmatically exposed in Doctor" });
  }, "LSP checks failed");

  addCategory("Connectivity");

  await safeCheck(async () => {
    const started = Date.now();
    const timeoutSignal = (AbortSignal as any).timeout ? (AbortSignal as any).timeout(10000) : undefined;
    const response = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      signal: timeoutSignal,
    });
    const latency = Date.now() - started;
    if (!response.ok) {
      addLine({ severity: "failure", text: `Exa MCP probe failed with HTTP ${response.status} (${latency}ms)` });
      return;
    }
    addLine({ severity: "pass", text: `Exa MCP reachable (${latency}ms)` });
  }, "Connectivity checks failed");

  addCategory("Repos");

  await safeCheck(() => {
    if (!orchestrator.active) {
      addLine({ severity: "pass", text: "No active task; repo checks skipped" });
      return;
    }

    const repos = orchestrator.active.state.repos ?? [];
    if (repos.length === 0) {
      addLine({ severity: "warning", text: "No repositories registered in active task" });
      return;
    }

    for (const repo of repos) {
      const exists = existsSync(repo.path);
      if (!exists) {
        addLine({ severity: "failure", text: `${repo.path}: path does not exist` });
        continue;
      }
      addLine({ severity: "pass", text: `${repo.path}: path exists` });

      let isGitRepo = existsSync(join(repo.path, ".git"));
      if (!isGitRepo) {
        try {
          execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo.path, encoding: "utf-8", stdio: "pipe" });
          isGitRepo = true;
        } catch {
          isGitRepo = false;
        }
      }
      if (isGitRepo) addLine({ severity: "pass", text: `${repo.path}: git repository detected` });
      else {
        addLine({ severity: "failure", text: `${repo.path}: not a git repository` });
        continue;
      }

      if (!repo.baseBranch) {
        addLine({ severity: "warning", text: `${repo.path}: base branch is not configured` });
        continue;
      }

      let baseBranchValid = false;
      try {
        execFileSync("git", ["show-ref", "--verify", `refs/remotes/${repo.baseBranch}`], { cwd: repo.path, encoding: "utf-8", stdio: "pipe" });
        baseBranchValid = true;
      } catch {
        try {
          execFileSync("git", ["show-ref", "--verify", `refs/heads/${repo.baseBranch}`], { cwd: repo.path, encoding: "utf-8", stdio: "pipe" });
          baseBranchValid = true;
        } catch {
          baseBranchValid = false;
        }
      }

      if (baseBranchValid) addLine({ severity: "pass", text: `${repo.path}: base branch "${repo.baseBranch}" is valid` });
      else addLine({ severity: "failure", text: `${repo.path}: base branch "${repo.baseBranch}" is invalid` });
    }
  }, "Repo checks failed");

  reportLines.push("", `Summary: ${passCount} passed, ${warningCount} warnings, ${failureCount} failures`);
  ctx.ui.notify(reportLines.join("\n"), "info");
}
