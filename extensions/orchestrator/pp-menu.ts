import { isDeepStrictEqual } from "util";
import { join } from "path";
import { askUser, isCancel } from "../../3p/pi-ask-user/index.js";
import {
  GLOBAL_CONFIG_PATH,
  MAX_CONCURRENT_SUBAGENTS_CEILING,
  getDefaultConfig,
  loadConfig,
  mergeConfigLayers,
  parseDuration,
  readRawConfig,
  removeConfigValue,
  writeConfigValue,
  type PiPiConfig,
  type PoolEntry,
  type PoolKey,
} from "./config.js";
import {
  clearFlantGeneratedConfig,
  getFlantGeneratedConfig,
  loadFlantSettings,
  readClaudeOAuthToken,
  readCopilotOAuthToken,
  readGatewayApiKey,
  syncProviderTiers,
  unregisterFlantProviders,
  updateFlantInfra,
  SUB_MODEL_PREFIX,
  type FlantSettings,
} from "./flant-infra.js";
import {
  clearAllTierDemotions,
  getAllAliases,
  getModelFamilies,
  listTierDemotions,
  resolveModel,
  updateRegistryFromAvailableModels,
} from "./model-registry.js";
import { compareModelVersion } from "./model-version.js";
import { listLayeredSkills } from "./skills-manifest.js";
import { buildPoolRoster, unregisterAgentDefinitions } from "./agents/registry.js";
import { setLogLevel } from "./log.js";
import type { Orchestrator } from "./orchestrator.js";

type Scope = "global" | "project";
type OptionInput = string | { title: string; description?: string };
type SimpleRole = keyof PiPiConfig["agents"]["subagents"]["simple"];

const BACK = "Back";
const CLOSE = "Close";

interface ConfigSourceInfo {
  activeValue: any;
  defaultValue: any;
  flantValue: any | undefined;
  globalValue: any | undefined;
  projectValue: any | undefined;
  source: "default" | "flant" | "global" | "project";
}

const SIMPLE_ROLES: Array<{ role: SimpleRole; label: string; description: string }> = [
  { role: "explore", label: "Explore", description: "agents.subagents.simple.explore" },
  { role: "librarian", label: "Librarian", description: "agents.subagents.simple.librarian" },
  { role: "task", label: "Task", description: "agents.subagents.simple.task" },
];

const POOL_ITEMS: Array<{ pool: PoolKey; label: string }> = [
  { pool: "advisors", label: "Advisors" },
  { pool: "reviewers", label: "Reviewers" },
  { pool: "deepDebuggers", label: "Deep debuggers" },
];

const TIMEOUT_ITEMS: Array<{ path: string[]; label: string }> = [
  { path: ["performance", "commands", "afterEdit"], label: "Command after file edit" },
  { path: ["performance", "internals", "subagentStale"], label: "Subagent stale" },
  { path: ["performance", "internals", "mainTurnStale"], label: "Main turn stale" },
];

async function selectOption(ctx: any, question: string, options: OptionInput[]): Promise<string | undefined> {
  const orchestrator = OrchestratorRef.current;
  if (orchestrator) orchestrator.interactivePromptOpen = true;
  try {
    const result = await askUser(ctx, { question, options, allowFreeform: false, allowComment: false, allowMultiple: false });
    if (!result || isCancel(result) || result.kind !== "selection") return undefined;
    return result.selections[0];
  } finally {
    if (orchestrator) orchestrator.interactivePromptOpen = false;
  }
}

const OrchestratorRef: { current: Orchestrator | null } = { current: null };

function opt(title: string, description: string): OptionInput {
  return { title, description };
}

function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pp", "config.json");
}

function getScopeConfigPath(orchestrator: Orchestrator, scope: Scope): string {
  return scope === "global" ? GLOBAL_CONFIG_PATH : getProjectConfigPath(orchestrator.cwd);
}

function hasNestedKey(obj: unknown, keyPath: string[]): boolean {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

function getNestedValue(obj: unknown, keyPath: string[]): any {
  let cursor: any = obj;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setNestedValue(obj: Record<string, any>, keyPath: string[], value: any): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) cursor[key] = {};
    cursor = cursor[key] as Record<string, any>;
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
}

function deleteNestedValue(obj: Record<string, any>, keyPath: string[]): void {
  if (keyPath.length === 0) return;
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const current = cursor[keyPath[i]!];
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    cursor = current;
  }
  delete cursor[keyPath[keyPath.length - 1]!];
}

function formatInlineValue(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tagsString(tags: string[]): string {
  return tags.length > 0 ? `(${tags.join(", ")})` : "";
}

function withTags(label: string, tags: string): string {
  return tags ? `${label} ${tags}` : label;
}

function isEmptyOverride(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

function hasLayerOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): boolean {
  const raw = readRawConfig(getScopeConfigPath(orchestrator, scope));
  if (!hasNestedKey(raw, keyPath)) return false;
  return !isEmptyOverride(getNestedValue(raw, keyPath));
}

function getLayerOverrideValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  return getNestedValue(readRawConfig(getScopeConfigPath(orchestrator, scope)), keyPath);
}

function getOwnedScopes(orchestrator: Orchestrator, keyPath: string[]): Scope[] {
  const out: Scope[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) out.push("global");
  if (hasLayerOverride(orchestrator, "project", keyPath)) out.push("project");
  return out;
}

export function getConfigSourceInfo(orchestrator: Orchestrator, keyPath: string[]): ConfigSourceInfo {
  const globalConfig = readRawConfig(GLOBAL_CONFIG_PATH);
  const projectConfig = readRawConfig(getProjectConfigPath(orchestrator.cwd));
  const flantConfig = getFlantGeneratedConfig() as Record<string, any> | null;
  const source = hasNestedKey(projectConfig, keyPath)
    ? "project"
    : hasNestedKey(globalConfig, keyPath)
    ? "global"
    : flantConfig && hasNestedKey(flantConfig, keyPath)
    ? "flant"
    : "default";
  return {
    activeValue: getNestedValue(orchestrator.config as Record<string, any>, keyPath),
    defaultValue: getNestedValue(getDefaultConfig() as Record<string, any>, keyPath),
    flantValue: flantConfig ? getNestedValue(flantConfig, keyPath) : undefined,
    globalValue: hasNestedKey(globalConfig, keyPath) ? getNestedValue(globalConfig, keyPath) : undefined,
    projectValue: hasNestedKey(projectConfig, keyPath) ? getNestedValue(projectConfig, keyPath) : undefined,
    source,
  };
}

export function formatSourceTags(currentValue: any, info: ConfigSourceInfo): string {
  const tags: string[] = [];
  if (isDeepStrictEqual(currentValue, info.activeValue)) tags.push("active");
  if (isDeepStrictEqual(currentValue, info.defaultValue)) tags.push("default");
  if (info.flantValue !== undefined && isDeepStrictEqual(currentValue, info.flantValue)) tags.push("flant");
  if (info.globalValue !== undefined && isDeepStrictEqual(currentValue, info.globalValue)) tags.push("global");
  if (info.projectValue !== undefined && isDeepStrictEqual(currentValue, info.projectValue)) tags.push("project");
  return tagsString(tags);
}

export function buildResetOptions(orchestrator: Orchestrator, keyPath: string[]): OptionInput[] {
  const options: OptionInput[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) {
    options.push(opt("Reset global setting", formatInlineValue(getLayerOverrideValue(orchestrator, "global", keyPath))));
  }
  if (hasLayerOverride(orchestrator, "project", keyPath)) {
    options.push(opt("Reset project setting", formatInlineValue(getLayerOverrideValue(orchestrator, "project", keyPath))));
  }
  return options;
}

function tryApplyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    setNestedValue(scope === "global" ? nextGlobal : nextProject, keyPath, value);
    mergeConfigLayers(nextGlobal, nextProject);
    writeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath, value);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function tryClearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): { ok: boolean; error?: string } {
  try {
    const nextGlobal = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const nextProject = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    deleteNestedValue(scope === "global" ? nextGlobal : nextProject, keyPath);
    mergeConfigLayers(nextGlobal, nextProject);
    removeConfigValue(getScopeConfigPath(orchestrator, scope), keyPath);
    orchestrator.config = loadConfig(orchestrator.cwd);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function refreshRuntimeAfterConfigChange(orchestrator: Orchestrator, keyPath: string[]): void {
  if (keyPath[0] === "agents") {
    unregisterAgentDefinitions(orchestrator.pi);
    orchestrator.registerAgents();
    if (keyPath[1] === "maxConcurrentSubagents") orchestrator.applySubagentConcurrency();
    return;
  }
  if (keyPath.join(".") === "performance.internals.subagentStale" && orchestrator.staleAgentTimer) {
    clearInterval(orchestrator.staleAgentTimer);
    orchestrator.staleAgentTimer = null;
  }
}

function applyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): void {
  const result = tryApplyConfigChange(orchestrator, scope, keyPath, value);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify?.(`Config update rejected: ${result.error}`, "error");
    return;
  }
  const available = orchestrator.lastCtx?.modelRegistry?.getAvailable?.();
  if (Array.isArray(available)) {
    updateRegistryFromAvailableModels(available.flatMap((m: any) => (m?.provider && m?.id ? [`${m.provider}/${m.id}`] : [])));
  }
  refreshRuntimeAfterConfigChange(orchestrator, keyPath);
}

function clearConfigOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): void {
  const result = tryClearConfigOverride(orchestrator, scope, keyPath);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify?.(`Config update rejected: ${result.error}`, "error");
    return;
  }
  refreshRuntimeAfterConfigChange(orchestrator, keyPath);
}

// Writes that match the effective default for the chosen scope clear the
// override instead of pinning a redundant value.
function applyScopeChoice(orchestrator: Orchestrator, keyPath: string[], value: any, scope: Scope | null): void {
  if (!scope) return;
  try {
    const globalConfig = structuredClone(readRawConfig(GLOBAL_CONFIG_PATH));
    const projectConfig = structuredClone(readRawConfig(getProjectConfigPath(orchestrator.cwd)));
    const mergedWithoutScope = scope === "global"
      ? (() => {
        deleteNestedValue(globalConfig, keyPath);
        return mergeConfigLayers(globalConfig, null);
      })()
      : (() => {
        deleteNestedValue(projectConfig, keyPath);
        return mergeConfigLayers(globalConfig, projectConfig);
      })();
    if (isDeepStrictEqual(value, getNestedValue(mergedWithoutScope, keyPath))) {
      clearConfigOverride(orchestrator, scope, keyPath);
      return;
    }
  } catch {}
  applyConfigChange(orchestrator, scope, keyPath, value);
}

async function pickScope(ctx: any, orchestrator: Orchestrator): Promise<Scope | null> {
  const choice = await selectOption(ctx, "Scope", [
    opt("Set globally", GLOBAL_CONFIG_PATH),
    opt("Set for project", getProjectConfigPath(orchestrator.cwd)),
    opt(BACK, "Return to the previous menu"),
  ]);
  if (choice === "Set globally") return "global";
  if (choice === "Set for project") return "project";
  return null;
}

async function pickScopeFromOwned(ctx: any, orchestrator: Orchestrator, keyPath: string[]): Promise<Scope | null> {
  const scopes = getOwnedScopes(orchestrator, keyPath);
  if (scopes.length === 0) return null;
  if (scopes.length === 1) return scopes[0]!;
  const choice = await selectOption(ctx, "Choose override scope", [
    opt("Global override", GLOBAL_CONFIG_PATH),
    opt("Project override", getProjectConfigPath(orchestrator.cwd)),
    opt(BACK, "Return to the previous menu"),
  ]);
  if (!choice || choice === BACK) return null;
  return choice === "Global override" ? "global" : "project";
}

async function maybeHandleResetChoice(orchestrator: Orchestrator, ctx: any, choice: string, keyPath: string[]): Promise<boolean> {
  const scope: Scope | null = choice === "Reset global setting" ? "global" : choice === "Reset project setting" ? "project" : null;
  if (!scope) return false;
  const confirm = await selectOption(ctx, "Confirm reset?", [
    opt("Yes, reset", `Reset ${scope} override ${formatInlineValue(getLayerOverrideValue(orchestrator, scope, keyPath))}`),
    opt(BACK, "Cancel"),
  ]);
  if (confirm === "Yes, reset") clearConfigOverride(orchestrator, scope, keyPath);
  return true;
}

function makeUniqueTitle(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base} (${index})`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    deepseek: "DeepSeek",
    "x-ai": "xAI",
    qwen: "Qwen",
    "pp-flant-anthropic": "Flant Anthropic",
    "pp-flant-anthropic-sub": "Flant Claude (subscription)",
    "pp-flant-openai": "Flant OpenAI",
    "github-copilot": "GitHub Copilot",
  };
  return labels[provider] ?? provider;
}

function providerOrder(provider: string): number {
  const order = ["pp-flant-anthropic-sub", "pp-flant-anthropic", "pp-flant-openai", "github-copilot", "anthropic", "openai", "google", "deepseek", "x-ai", "qwen"];
  const index = order.indexOf(provider);
  return index === -1 ? 99 : index;
}

function listAvailableModels(ctx: any): Array<{ provider: string; id: string; spec: string }> {
  const available = ctx?.modelRegistry?.getAvailable?.();
  if (!Array.isArray(available)) return [];
  const seen = new Set<string>();
  const models: Array<{ provider: string; id: string; spec: string }> = [];
  for (const model of available) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const spec = `${provider}/${id}`;
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id, spec });
  }
  models.sort((a, b) => {
    const byOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byOrder !== 0) return byOrder;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return compareModelVersion(b.id, a.id);
  });
  return models;
}

async function pickModel(ctx: any, currentModel?: string): Promise<string | null> {
  const aliasMap = getAllAliases();
  const families = getModelFamilies();
  const availableModels = listAvailableModels(ctx);
  const availableSpecs = new Set(availableModels.map((m) => m.spec));
  const currentResolved = currentModel ? resolveModel(currentModel) : null;
  const visibleAliases = new Set(
    Object.entries(aliasMap)
      .filter(([, resolved]) => availableSpecs.has(resolved))
      .map(([alias]) => alias),
  );
  const options: OptionInput[] = [];
  const selectionToModel = new Map<string, string>();
  const usedTitles = new Set<string>();

  if (currentModel && !visibleAliases.has(currentModel)) {
    const tags = ["active"];
    if (!(currentResolved && availableSpecs.has(currentResolved))) tags.push("unavailable");
    const title = makeUniqueTitle(withTags(currentModel, tagsString(tags)), usedTitles);
    options.push(opt(title, "Current model"));
    selectionToModel.set(title, currentModel);
  }

  const aliasEntries: Array<{ provider: string; displayName: string; alias: string }> = [];
  for (const family of families) {
    for (const alias of family.aliases) {
      if (!visibleAliases.has(alias)) continue;
      aliasEntries.push({ provider: alias.split("/")[0] ?? "", displayName: family.displayName, alias });
    }
  }
  aliasEntries.sort((a, b) => {
    const byOrder = providerOrder(a.provider) - providerOrder(b.provider);
    if (byOrder !== 0) return byOrder;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return a.displayName.localeCompare(b.displayName);
  });
  for (const entry of aliasEntries) {
    const tags = entry.alias === currentModel ? tagsString(["active"]) : "";
    const title = makeUniqueTitle(withTags(`${normalizeProviderLabel(entry.provider)} — ${entry.displayName} (latest)`, tags), usedTitles);
    options.push(opt(title, entry.alias));
    selectionToModel.set(title, entry.alias);
  }
  for (const model of availableModels) {
    if (currentModel && model.spec === currentModel) continue;
    const title = makeUniqueTitle(`${normalizeProviderLabel(model.provider)} — ${model.id}`, usedTitles);
    options.push(opt(title, model.spec));
    selectionToModel.set(title, model.spec);
  }
  options.push(opt(BACK, "Return to the previous menu"));

  for (;;) {
    const choice = await selectOption(ctx, "Model", options);
    if (!choice || choice === BACK) return null;
    const selected = selectionToModel.get(choice);
    if (selected) return selected;
  }
}

function thinkingLabel(value: string): string {
  const labels: Record<string, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };
  return labels[value] ?? value;
}

async function pickThinking(ctx: any, orchestrator?: Orchestrator, keyPath?: string[]): Promise<string | null> {
  const values = ["xhigh", "high", "medium", "low", "off"];
  const info = orchestrator && keyPath ? getConfigSourceInfo(orchestrator, keyPath) : null;
  const byTitle = new Map<string, string>();
  const usedTitles = new Set<string>();
  const options: OptionInput[] = values.map((value) => {
    const title = makeUniqueTitle(withTags(thinkingLabel(value), info ? formatSourceTags(value, info) : ""), usedTitles);
    byTitle.set(title, value);
    return title;
  });
  options.push(opt(BACK, "Return to the previous menu"));
  const choice = await selectOption(ctx, "Thinking level", options);
  if (!choice || choice === BACK) return null;
  return byTitle.get(choice) ?? null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatElapsedDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

async function promptRequiredInput(ctx: any, label: string): Promise<string | null> {
  const value = await ctx.ui?.input?.(label);
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

async function showBooleanSetting(
  orchestrator: Orchestrator,
  ctx: any,
  title: string,
  keyPath: string[],
  yesDescription = "Turn this setting on",
  noDescription = "Turn this setting off",
): Promise<void> {
  for (;;) {
    const info = getConfigSourceInfo(orchestrator, keyPath);
    const yesTitle = withTags("Yes", formatSourceTags(true, info));
    const noTitle = withTags("No", formatSourceTags(false, info));
    const choice = await selectOption(ctx, title, [
      { title: yesTitle, description: yesDescription },
      { title: noTitle, description: noDescription },
      ...buildResetOptions(orchestrator, keyPath),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice === yesTitle) {
      applyScopeChoice(orchestrator, keyPath, true, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === noTitle) {
      applyScopeChoice(orchestrator, keyPath, false, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath);
  }
}

function logLevelLabel(value: string): string {
  const labels: Record<string, string> = { debug: "Debug", info: "Info", warn: "Warning", error: "Error" };
  return labels[value] ?? value;
}

async function showLogLevelSetting(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const levels: Array<{ value: PiPiConfig["general"]["logLevel"]; label: string; description: string }> = [
    { value: "debug", label: "Debug", description: "Log everything, including detailed diagnostics" },
    { value: "info", label: "Info", description: "Log normal activity plus warnings and errors" },
    { value: "warn", label: "Warning", description: "Log only warnings and errors" },
    { value: "error", label: "Error", description: "Log only errors" },
  ];
  for (;;) {
    const info = getConfigSourceInfo(orchestrator, ["general", "logLevel"]);
    const options: OptionInput[] = levels.map((entry) => ({ title: withTags(entry.label, formatSourceTags(entry.value, info)), description: entry.description }));
    options.push(...buildResetOptions(orchestrator, ["general", "logLevel"]));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Log level", options);
    if (!choice || choice === BACK) return;
    const picked = levels.find((entry) => choice.startsWith(entry.label));
    if (picked) {
      applyScopeChoice(orchestrator, ["general", "logLevel"], picked.value, await pickScope(ctx, orchestrator));
    } else {
      await maybeHandleResetChoice(orchestrator, ctx, choice, ["general", "logLevel"]);
    }
    setLogLevel(orchestrator.config.general.logLevel);
  }
}

async function showGeneralSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const choice = await selectOption(ctx, "General", [
      opt(`Log level: ${logLevelLabel(orchestrator.config.general.logLevel)}`, "Logging verbosity"),
      opt(`Tracing: ${orchestrator.config.general.tracing ? "Yes" : "No"}`, "Capture full session traces to .pp/logs/traces/"),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Log level:")) await showLogLevelSetting(orchestrator, ctx);
    else if (choice.startsWith("Tracing:")) await showBooleanSetting(orchestrator, ctx, "Tracing", ["general", "tracing"], "Capture full session traces to .pp/logs/traces/", "Do not record session traces");
  }
}

function turnLimitLabel(maxTurns: number | undefined): string {
  return maxTurns ? String(maxTurns) : "Unlimited";
}

async function promptTurnLimit(ctx: any, current: number | undefined): Promise<number | null> {
  const input = await promptRequiredInput(ctx, `Turn limit [${turnLimitLabel(current)}] (0 = unlimited)`);
  if (!input) return null;
  if (!/^\d+$/.test(input)) {
    ctx.ui?.notify?.("Enter a non-negative integer (0 means unlimited).", "warning");
    return null;
  }
  return Number.parseInt(input, 10);
}

async function showAgentEditor(orchestrator: Orchestrator, ctx: any, basePath: string[], label: string, getCurrent: () => { model: string; thinking: string; maxTurns?: number }, allowTurnLimit = false): Promise<void> {
  for (;;) {
    const current = getCurrent();
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${current.model}`, "Choose the model for this agent"),
      opt(`Thinking: ${thinkingLabel(current.thinking)}`, "Choose how much this agent thinks before acting"),
      ...(allowTurnLimit ? [opt(`Turn limit: ${turnLimitLabel(current.maxTurns)}`, "Limit agentic turns; unlimited by default")] : []),
      ...buildResetOptions(orchestrator, basePath),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, current.model);
      if (!model) continue;
      applyScopeChoice(orchestrator, [...basePath, "model"], model, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx, orchestrator, [...basePath, "thinking"]);
      if (!thinking) continue;
      applyScopeChoice(orchestrator, [...basePath, "thinking"], thinking, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Turn limit:")) {
      const maxTurns = await promptTurnLimit(ctx, current.maxTurns);
      if (maxTurns === null) continue;
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      applyScopeChoice(orchestrator, [...basePath, "maxTurns"], maxTurns, scope);
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, basePath);
  }
}

// Pools are arrays: deepMerge replaces them wholesale, so every edit rewrites
// the WHOLE effective array into the chosen scope. A global write under an
// existing project override would be silently masked — surface that instead.
async function writePool(orchestrator: Orchestrator, ctx: any, pool: PoolKey, next: PoolEntry[]): Promise<boolean> {
  const keyPath = ["agents", "subagents", "pools", pool];
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return false;
  if (scope === "global" && hasLayerOverride(orchestrator, "project", keyPath)) {
    ctx.ui?.notify?.(`A project override for this pool exists and would mask the global edit. Edit the project scope instead, or reset the project override first.`, "warning");
    return false;
  }
  applyConfigChange(orchestrator, scope, keyPath, next);
  return true;
}

async function showPoolEntryEditor(orchestrator: Orchestrator, ctx: any, pool: PoolKey, index: number): Promise<void> {
  for (;;) {
    const entries = orchestrator.config.agents.subagents.pools[pool] ?? [];
    const entry = entries[index];
    if (!entry) return;
    const choice = await selectOption(ctx, `${pool === "deepDebuggers" ? "deep-debugger" : pool.replace(/s$/, "")} entry`, [
      opt(`Enabled: ${entry.enabled === false ? "No" : "Yes"}`, "Toggle whether this model registers as a subagent"),
      opt(`Model: ${entry.model}`, "Choose the model for this pool entry"),
      opt(`Thinking: ${thinkingLabel(entry.thinking)}`, "Choose how much this agent thinks before acting"),
      opt(`Turn limit: ${turnLimitLabel(entry.maxTurns)}`, "Limit agentic turns; unlimited by default"),
      opt("Delete", "Remove this entry from the pool"),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Model:")) {
      const model = await pickModel(ctx, entry.model);
      if (!model) continue;
      const next = structuredClone(entries);
      next[index] = { ...next[index], model };
      await writePool(orchestrator, ctx, pool, next);
      continue;
    }
    if (choice.startsWith("Thinking:")) {
      const thinking = await pickThinking(ctx);
      if (!thinking) continue;
      const next = structuredClone(entries);
      next[index] = { ...next[index], thinking };
      await writePool(orchestrator, ctx, pool, next);
      continue;
    }
    if (choice.startsWith("Enabled:")) {
      const next = structuredClone(entries);
      next[index] = { ...next[index], enabled: entry.enabled === false };
      await writePool(orchestrator, ctx, pool, next);
      continue;
    }
    if (choice.startsWith("Turn limit:")) {
      const maxTurns = await promptTurnLimit(ctx, entry.maxTurns);
      if (maxTurns === null) continue;
      const next = structuredClone(entries);
      next[index] = { ...next[index], maxTurns };
      await writePool(orchestrator, ctx, pool, next);
      continue;
    }
    const confirm = await selectOption(ctx, "Confirm delete?", [opt("Yes, delete", "This cannot be undone"), opt(BACK, "Cancel")]);
    if (confirm !== "Yes, delete") continue;
    const next = structuredClone(entries);
    next.splice(index, 1);
    if (await writePool(orchestrator, ctx, pool, next)) return;
  }
}

async function showPoolSettings(orchestrator: Orchestrator, ctx: any, pool: PoolKey, label: string): Promise<void> {
  for (;;) {
    const entries = orchestrator.config.agents.subagents.pools[pool] ?? [];
    const options: OptionInput[] = [];
    const byTitle = new Map<string, number>();
    const usedTitles = new Set<string>();
    entries.forEach((entry, i) => {
      const tag = entry.enabled === false ? " (disabled)" : "";
      const title = makeUniqueTitle(`${entry.model}${tag}`, usedTitles);
      options.push(opt(title, `thinking ${thinkingLabel(entry.thinking)}`));
      byTitle.set(title, i);
    });
    options.push(opt("New entry", `Add a model to the ${label.toLowerCase()} pool`));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, label, options);
    if (!choice || choice === BACK) return;
    if (choice === "New entry") {
      const model = await pickModel(ctx);
      if (!model) continue;
      const thinking = await pickThinking(ctx);
      if (!thinking) continue;
      const next = structuredClone(entries);
      next.push({ enabled: true, model, thinking });
      await writePool(orchestrator, ctx, pool, next);
      continue;
    }
    const idx = byTitle.get(choice);
    if (idx !== undefined) await showPoolEntryEditor(orchestrator, ctx, pool, idx);
  }
}

async function showMaxConcurrentSetting(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const keyPath = ["agents", "maxConcurrentSubagents"];
  for (;;) {
    const current = orchestrator.config.agents.maxConcurrentSubagents;
    const action = await selectOption(ctx, `Max concurrent subagents: ${current}`, [
      opt("Edit", "Set the maximum number of concurrent background subagents"),
      ...buildResetOptions(orchestrator, keyPath),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!action || action === BACK) return;
    if (action === "Edit") {
      const input = await promptRequiredInput(ctx, `Max concurrent subagents (1-${MAX_CONCURRENT_SUBAGENTS_CEILING}) [${current}]`);
      if (!input) continue;
      if (!/^\d+$/.test(input)) {
        ctx.ui?.notify?.(`Enter a positive integer between 1 and ${MAX_CONCURRENT_SUBAGENTS_CEILING}.`, "warning");
        continue;
      }
      const parsed = Number.parseInt(input, 10);
      if (parsed < 1 || parsed > MAX_CONCURRENT_SUBAGENTS_CEILING) {
        ctx.ui?.notify?.(`Enter a positive integer between 1 and ${MAX_CONCURRENT_SUBAGENTS_CEILING}.`, "warning");
        continue;
      }
      applyScopeChoice(orchestrator, keyPath, parsed, await pickScope(ctx, orchestrator));
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, action, keyPath);
  }
}

async function showAgentsSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const config = orchestrator.config.agents;
    const options: OptionInput[] = [
      opt("Main", `${config.main.model} / ${thinkingLabel(config.main.thinking)} — identity for the primary session agent`),
      ...SIMPLE_ROLES.map(({ role, label, description }) => {
        const current = config.subagents.simple[role];
        return opt(label, `${current.model} / ${thinkingLabel(current.thinking)} — ${description}`);
      }),
      ...POOL_ITEMS.map((item) => {
        const pool = config.subagents.pools[item.pool] ?? [];
        const enabled = pool.filter((entry) => entry.enabled !== false).length;
        return opt(item.label, `${enabled}/${pool.length} enabled — on-demand model pool`);
      }),
      opt(`Max concurrent subagents: ${config.maxConcurrentSubagents}`, "Max background subagents run at once; extras queue"),
      opt(BACK, "Return to the previous menu"),
    ];
    const choice = await selectOption(ctx, "Agents", options);
    if (!choice || choice === BACK) return;
    if (choice === "Main") {
      await showAgentEditor(orchestrator, ctx, ["agents", "main"], "Main", () => orchestrator.config.agents.main);
      continue;
    }
    const simple = SIMPLE_ROLES.find((item) => item.label === choice);
    if (simple) {
      await showAgentEditor(orchestrator, ctx, ["agents", "subagents", "simple", simple.role], simple.label, () => orchestrator.config.agents.subagents.simple[simple.role], true);
      continue;
    }
    const pool = POOL_ITEMS.find((item) => item.label === choice);
    if (pool) {
      await showPoolSettings(orchestrator, ctx, pool.pool, pool.label);
      continue;
    }
    if (choice.startsWith("Max concurrent subagents:")) await showMaxConcurrentSetting(orchestrator, ctx);
  }
}

async function showContextSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const rows: Array<{ key: keyof PiPiConfig["contextInjection"]; label: string; desc: string }> = [
    { key: "globalAgents", label: "Global AGENTS.md (~/.pi/agent)", desc: "Inject the global ~/.pi/agent/AGENTS.md" },
    { key: "globalClaude", label: "Global CLAUDE.md (~/.pi/agent)", desc: "Inject the global ~/.pi/agent/CLAUDE.md" },
    { key: "ancestorAgents", label: "Ancestor AGENTS.md", desc: "Inject AGENTS.md from every ancestor directory above the project" },
    { key: "ancestorClaude", label: "Ancestor CLAUDE.md", desc: "Inject CLAUDE.md from every ancestor directory above the project" },
    { key: "projectAgents", label: "Project AGENTS.md (cwd)", desc: "Inject the working repo's root AGENTS.md" },
    { key: "projectClaude", label: "Project CLAUDE.md (cwd)", desc: "Inject the working repo's root CLAUDE.md" },
  ];
  for (;;) {
    const ci = orchestrator.config.contextInjection;
    const options: OptionInput[] = rows.map((row) => opt(`${row.label}: ${ci[row.key] ? "ON" : "OFF"}`, row.desc));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Context", options);
    if (!choice || choice === BACK) return;
    const row = rows.find((entry) => choice.startsWith(`${entry.label}:`));
    if (row) await showBooleanSetting(orchestrator, ctx, row.label, ["contextInjection", row.key], row.desc, `Do not inject ${row.label}`);
  }
}

async function showSkillsSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const layers: Array<{ key: keyof PiPiConfig["skills"]; label: string; desc: string }> = [
    { key: "loadBundled", label: "Load bundled skills", desc: "Skills shipped with pi-pi" },
    { key: "loadGlobal", label: "Load global skills", desc: "Skills under ~/.pi/skills" },
    { key: "loadProject", label: "Load project skills", desc: "Skills under <project>/.pi/skills" },
  ];
  for (;;) {
    const enabled = orchestrator.config.skills;
    const skills = listLayeredSkills(orchestrator.cwd).filter((skill) =>
      (skill.layer === "bundled" && enabled.loadBundled)
      || (skill.layer === "global" && enabled.loadGlobal)
      || (skill.layer === "project" && enabled.loadProject));
    const options: OptionInput[] = [
      ...layers.map((layer) => opt(`${layer.label}: ${enabled[layer.key] ? "ON" : "OFF"}`, layer.desc)),
      opt("List skills", `${skills.length} skills available to the agent`),
      opt(BACK, "Return to the previous menu"),
    ];
    const choice = await selectOption(ctx, "Skills", options);
    if (!choice || choice === BACK) return;
    const layer = layers.find((entry) => choice.startsWith(`${entry.label}:`));
    if (layer) {
      await showBooleanSetting(orchestrator, ctx, layer.label, ["skills", layer.key], layer.desc, `Do not ${layer.label.toLowerCase()}`);
      continue;
    }
    if (choice === "List skills") {
      ctx.ui?.notify?.(skills.map((skill) => `${skill.name} (${skill.layer}): ${skill.description}${skill.shadows.length ? ` — shadows ${skill.shadows.join(", ")}` : ""}`).join("\n") || "No skills available.", "info");
    }
  }
}

async function runManualCompaction(orchestrator: Orchestrator, ctx: any): Promise<void> {
  if (orchestrator.manualCompactionPending) {
    ctx.ui?.notify?.("A manual compaction is already in progress.", "warning");
    return;
  }
  if (typeof ctx?.compact !== "function") {
    ctx.ui?.notify?.("Compaction is not available in this session.", "error");
    return;
  }
  const sel = await selectOption(ctx, "Compact context now", [
    opt("VCC (default)", "Deterministic pi-pi summarizer; keeps vcc_recall able to resolve the summarized range"),
    opt("builtin (LLM-based)", "Let the host summarize the discarded messages with the model"),
    opt(BACK, "Return to the previous menu"),
  ]);
  if (!sel || sel === BACK) return;
  orchestrator.manualCompactionUseBuiltin = sel === "builtin (LLM-based)";
  orchestrator.manualCompactionPending = true;
  // compact() resolves asynchronously and its callbacks can outlive the request
  // that initiated it, so settle only the request this call owns.
  const requestId = (orchestrator.manualCompactionRequestId += 1);
  const settle = (): boolean => {
    if (orchestrator.manualCompactionRequestId !== requestId) return false;
    orchestrator.manualCompactionPending = false;
    orchestrator.manualCompactionUseBuiltin = false;
    return true;
  };
  ctx.compact({
    onComplete: () => {
      if (settle()) ctx.ui?.notify?.("Context compacted.", "info");
    },
    onError: (err: any) => {
      if (settle()) ctx.ui?.notify?.(`Compaction failed: ${err?.message ?? String(err)}`, "error");
    },
  });
}

async function showCompactionSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const pickers: Array<{ prefix: string; key: string; question: string; choices: Array<{ title: string; description: string }>; parse: (title: string) => number }> = [
    {
      prefix: "Trigger fraction:",
      key: "fraction",
      question: "Trigger fraction",
      choices: [
        { title: "20%", description: "Compact earlier (smaller working context)" },
        { title: "30%", description: "Default" },
        { title: "40%", description: "Compact later" },
        { title: "50%", description: "Compact much later" },
      ],
      parse: (title) => Number(title.replace("%", "")) / 100,
    },
    {
      prefix: "Floor:",
      key: "floorTokens",
      question: "Floor (tokens)",
      choices: [
        { title: "150K", description: "Lower floor" },
        { title: "250K", description: "Default" },
        { title: "400K", description: "Higher floor" },
      ],
      parse: (title) => Number(title.replace("K", "")) * 1000,
    },
    {
      prefix: "Headroom fraction:",
      key: "headroomFraction",
      question: "Headroom fraction",
      choices: [
        { title: "8%", description: "Less working room" },
        { title: "12%", description: "Default" },
        { title: "20%", description: "More working room" },
        { title: "30%", description: "Much more working room" },
      ],
      parse: (title) => Number(title.replace("%", "")) / 100,
    },
    {
      prefix: "Headroom floor:",
      key: "headroomFloorTokens",
      question: "Headroom floor (tokens)",
      choices: [
        { title: "20K", description: "Lower headroom floor" },
        { title: "40K", description: "Default" },
        { title: "80K", description: "Higher headroom floor" },
        { title: "120K", description: "Much higher headroom floor" },
      ],
      parse: (title) => Number(title.replace("K", "")) * 1000,
    },
  ];
  for (;;) {
    const c = orchestrator.config.compaction;
    const options: OptionInput[] = [
      opt(`Enable automatic compaction: ${c.enabled ? "ON" : "OFF"}`, "Proactively compact context when it grows past the threshold"),
    ];
    if (c.enabled) {
      options.push(
        opt(`Trigger fraction: ${Math.round(c.fraction * 100)}% of context window`, "Compact once estimated context exceeds this fraction of the model's window"),
        opt(`Floor: ${Math.round(c.floorTokens / 1000)}K tokens`, "Never trigger below this token count even if the fraction is smaller"),
        opt(`Headroom fraction: ${Math.round(c.headroomFraction * 100)}% of context window`, "Working room kept above the post-compaction size"),
        opt(`Headroom floor: ${Math.round(c.headroomFloorTokens / 1000)}K tokens`, "Minimum working room kept above the post-compaction size"),
      );
    }
    options.push(opt("Compact context now", "Compact the current session immediately, choosing the summarizer"));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Compaction", options);
    if (!choice || choice === BACK) return;
    if (choice === "Compact context now") {
      await runManualCompaction(orchestrator, ctx);
      continue;
    }
    if (choice.startsWith("Enable automatic compaction:")) {
      await showBooleanSetting(orchestrator, ctx, "Enable automatic compaction", ["compaction", "enabled"], "Proactively compact context when it grows past the threshold", "Never auto-compact");
      continue;
    }
    const picker = pickers.find((entry) => choice.startsWith(entry.prefix));
    if (!picker) continue;
    const sel = await selectOption(ctx, picker.question, [...picker.choices, opt(BACK, "Return to the previous menu")]);
    if (!sel || sel === BACK) continue;
    const value = picker.parse(sel);
    if (Number.isFinite(value) && value > 0) {
      applyScopeChoice(orchestrator, ["compaction", picker.key], value, await pickScope(ctx, orchestrator));
    }
  }
}

async function setFlantConfigValue(orchestrator: Orchestrator, ctx: any, key: string, value: any): Promise<Scope | null> {
  const scope = await pickScope(ctx, orchestrator);
  if (!scope) return null;
  applyScopeChoice(orchestrator, ["flant", key], value, scope);
  return scope;
}

// A higher-precedence scope (project over a global edit) can still govern the
// effective value, making the click appear to do nothing — surface that.
function warnIfFlantEditMasked(ctx: any, label: string, scope: Scope, intended: unknown, effective: unknown): boolean {
  if (intended === effective) return false;
  const other = scope === "global" ? "project" : "global";
  ctx.ui?.notify?.(`A higher-precedence (${other}) override still governs "${label}"; your ${scope} change had no effect on the active value.`, "warning");
  return true;
}

function countFlantProviders(settings: FlantSettings): { openai: number; sub: number } {
  const models = settings.cachedFlantModels ?? [];
  const bareClaude = models.filter((m) => m.startsWith("claude-")).length;
  const subConfirmed = models.filter((m) => m.startsWith(SUB_MODEL_PREFIX)).length;
  const sub = subConfirmed > 0 ? subConfirmed : bareClaude;
  return { openai: Math.max(0, models.length - bareClaude - subConfirmed), sub };
}

function collectRoleAssignments(config: Partial<PiPiConfig> | null): string[] {
  if (!config) return [];
  const out: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (typeof value === "string" && value.length > 0) out.push(`${key} = ${value}`);
  };
  add("agents.main", config.agents?.main?.model);
  add("agents.subagents.simple.explore", config.agents?.subagents?.simple?.explore?.model);
  add("agents.subagents.simple.librarian", config.agents?.subagents?.simple?.librarian?.model);
  add("agents.subagents.simple.task", config.agents?.subagents?.simple?.task?.model);
  for (const poolKey of ["advisors", "reviewers", "deepDebuggers"] as const) {
    const pool = config.agents?.subagents?.pools?.[poolKey];
    if (!Array.isArray(pool)) continue;
    pool.forEach((entry: any, i: number) => {
      if (entry?.enabled !== false) add(`agents.subagents.pools.${poolKey}[${i}]`, entry?.model);
    });
  }
  return out;
}

function flantStatusText(settings: FlantSettings): string {
  const providers = countFlantProviders(settings);
  const assignments = collectRoleAssignments(getFlantGeneratedConfig());
  const lines = [
    `Enabled: ${settings.enabled ? "yes" : "no"}`,
    `Auto-update: ${settings.autoUpdate ? "yes" : "no"}`,
    `Last updated: ${settings.lastUpdated ?? "never"}`,
    `Providers: pp-flant-openai (${providers.openai} models); Claude routes ONLY via the personal subscription (sub/)`,
  ];
  if (settings.subscription) {
    const hasOAuth = !!readClaudeOAuthToken();
    const hasGatewayKey = !!readGatewayApiKey();
    const subActive = hasOAuth && hasGatewayKey;
    lines.push(`Personal subscription: on (${subActive ? `active — pp-flant-anthropic-sub, ${providers.sub} models` : "inactive"})`);
    lines.push(`Rate-limit switch-back check: every ${settings.switchBackIntervalMinutes} min`);
    if (!subActive) {
      if (!hasOAuth) lines.push("  - missing Claude OAuth token (run pi /login for Anthropic)");
      if (!hasGatewayKey) lines.push("  - missing gateway key (set LLM_API_KEY or FLANT_API_KEY)");
    }
  } else {
    lines.push("Personal subscription: off");
  }
  if (assignments.length === 0) {
    lines.push("Role assignments: none");
  } else {
    lines.push("Role assignments:");
    for (const assignment of assignments) lines.push(`- ${assignment}`);
  }
  const demotions = listTierDemotions();
  if (demotions.length > 0) lines.push(`Monthly-cap tier demotions (active): ${demotions.join(", ")}`);
  return lines.join("\n");
}

function describeUpdateResult(result: { ok: boolean; error?: string; models?: string[] }): { text: string; kind: "info" | "error" } {
  if (!result.ok) return { text: `Flant update failed: ${result.error ?? "unknown error"}`, kind: "error" };
  const models = result.models ?? [];
  const sub = models.filter((m) => m.startsWith(SUB_MODEL_PREFIX) || m.startsWith("claude-")).length;
  return { text: `Flant update completed: ${models.length} models (subscription Claude: ${sub}, pp-flant-openai: ${Math.max(0, models.length - sub)}).`, kind: "info" };
}

async function showFlantMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const settings = loadFlantSettings(orchestrator.cwd);
    const enableLabel = `Enable: ${settings.enabled ? "ON" : "OFF"}`;
    const subscriptionLabel = `Personal Claude subscription: ${settings.subscription ? "ON" : "OFF"}`;
    const options: OptionInput[] = [
      opt(enableLabel, "Turn the Flant AI model providers on or off"),
    ];
    if (settings.enabled) {
      options.push(
        opt(subscriptionLabel, "Route Claude roles through your personal Claude subscription instead of the gateway"),
        opt(`Auto-update on startup: ${settings.autoUpdate ? "ON" : "OFF"}`, "Refresh the available model list automatically each time pi starts"),
        opt(`Cache period: ${settings.cacheTTLDays} ${settings.cacheTTLDays === 1 ? "day" : "days"}`, "How long the fetched model list is reused before it is refreshed"),
        opt(`Automatic fallback on rate limit: ${settings.autoRateLimitFallback ? "ON" : "OFF"}`, "On a rate limit, switch to the next provider tier automatically"),
      );
      if (settings.subscription) {
        options.push(opt(`Rate-limit switch-back check: every ${settings.switchBackIntervalMinutes} min`, "How often to retry your subscription after it was rate-limited"));
      }
      options.push(
        opt("Update now", "Fetch the latest model list from Flant right away"),
        opt("Current status", "Show the current Flant configuration, providers, and model counts"),
      );
    }
    const demotions = listTierDemotions();
    if (demotions.length > 0) {
      options.push(opt(`Clear provider tier demotions (${demotions.length})`, `Restore tiers demoted by a monthly usage cap: ${demotions.join(", ")}`));
    }
    options.push(opt(BACK, "Return to the previous menu"));

    const choice = await selectOption(ctx, "Flant", options);
    if (!choice || choice === BACK) return;

    if (choice.startsWith("Clear provider tier demotions")) {
      const cleared = clearAllTierDemotions();
      ctx.ui?.notify?.(cleared.length > 0 ? `Cleared ${cleared.length} provider tier demotion(s): ${cleared.join(", ")}.` : "No provider tier demotions to clear.", "info");
      continue;
    }

    if (choice === enableLabel) {
      const intended = !settings.enabled;
      if (intended && !process.env.FLANT_API_KEY && !process.env.LLM_API_KEY) {
        ctx.ui?.notify?.("Set FLANT_API_KEY (or LLM_API_KEY) environment variable first.", "warning");
        continue;
      }
      const scope = await setFlantConfigValue(orchestrator, ctx, "enabled", intended);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Enable", scope, intended, eff.enabled)) continue;
      if (eff.enabled) {
        const result = await updateFlantInfra(orchestrator.pi, { cwd: orchestrator.cwd });
        const message = describeUpdateResult(result);
        ctx.ui?.notify?.(message.text, message.kind);
      } else {
        unregisterFlantProviders(orchestrator.pi);
        clearFlantGeneratedConfig();
        ctx.ui?.notify?.("Flant disabled.", "info");
      }
      continue;
    }

    if (choice === subscriptionLabel) {
      const turningOn = !settings.subscription;
      if (turningOn) {
        if (!readClaudeOAuthToken()) {
          ctx.ui?.notify?.("No Claude OAuth token found. Log in to your personal Claude subscription in pi first (/login → Anthropic), then retry.", "warning");
          continue;
        }
        if (!readGatewayApiKey()) {
          ctx.ui?.notify?.("Set LLM_API_KEY (or FLANT_API_KEY) for the gateway first.", "warning");
          continue;
        }
      }
      const scope = await setFlantConfigValue(orchestrator, ctx, "subscription", turningOn);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Personal Claude subscription", scope, turningOn, eff.subscription)) continue;
      const result = await updateFlantInfra(orchestrator.pi, { cwd: orchestrator.cwd });
      ctx.ui?.notify?.(
        result.ok
          ? eff.subscription
            ? "Personal Claude subscription ON — Claude roles now route through sub/claude-* (billed to your subscription)."
            : "Personal Claude subscription OFF — Claude models are unavailable (the paid gateway no longer serves Claude)."
          : `Personal subscription ${eff.subscription ? "enable" : "disable"} failed: ${result.error ?? "unknown error"}`,
        result.ok ? "info" : "error",
      );
      continue;
    }

    if (choice.startsWith("Auto-update on startup:")) {
      const intended = !settings.autoUpdate;
      const scope = await setFlantConfigValue(orchestrator, ctx, "autoUpdate", intended);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Auto-update on startup", scope, intended, eff.autoUpdate)) continue;
      ctx.ui?.notify?.(`Auto-update on startup: ${eff.autoUpdate ? "ON" : "OFF"}`, "info");
      continue;
    }

    if (choice.startsWith("Automatic fallback on rate limit:")) {
      const intended = !settings.autoRateLimitFallback;
      const scope = await setFlantConfigValue(orchestrator, ctx, "autoRateLimitFallback", intended);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Automatic fallback on rate limit", scope, intended, eff.autoRateLimitFallback)) continue;
      ctx.ui?.notify?.(eff.autoRateLimitFallback ? "Automatic fallback ON — rate limits switch provider tier without asking." : "Automatic fallback OFF — rate limits only warn; switch models manually with /model.", "info");
      continue;
    }

    if (choice.startsWith("Rate-limit switch-back check:")) {
      const selected = await selectOption(ctx, "Switch-back check interval", [
        opt("10 min", "Default — probe the subscription limit every 10 minutes"),
        opt("15 min", "Probe every 15 minutes"),
        opt("30 min", "Probe every 30 minutes"),
        opt("60 min", "Probe hourly"),
        opt("120 min", "Probe every two hours"),
        opt(BACK, "Return to the previous menu"),
      ]);
      if (!selected || selected === BACK) continue;
      const mins = Number(selected.split(" ")[0]);
      if (!Number.isFinite(mins) || mins <= 0) continue;
      const scope = await setFlantConfigValue(orchestrator, ctx, "switchBackIntervalMinutes", mins);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Switch-back check interval", scope, mins, eff.switchBackIntervalMinutes)) continue;
      ctx.ui?.notify?.(`Switch-back check interval set to ${eff.switchBackIntervalMinutes} min.`, "info");
      continue;
    }

    if (choice.startsWith("Cache period:")) {
      const selected = await selectOption(ctx, "Cache period", [
        opt("1 day", "Refresh model metadata daily"),
        opt("3 days", "Default — refresh every three days"),
        opt("7 days", "Refresh model metadata weekly"),
        opt("14 days", "Refresh model metadata every two weeks"),
        opt("30 days", "Refresh model metadata monthly"),
        opt(BACK, "Return to the previous menu"),
      ]);
      if (!selected || selected === BACK) continue;
      const days = Number(selected.split(" ")[0]);
      if (!Number.isFinite(days) || days <= 0) continue;
      const scope = await setFlantConfigValue(orchestrator, ctx, "cacheTTLDays", days);
      if (!scope) continue;
      const eff = loadFlantSettings(orchestrator.cwd);
      if (warnIfFlantEditMasked(ctx, "Cache period", scope, days, eff.cacheTTLDays)) continue;
      ctx.ui?.notify?.(`Cache period set to ${eff.cacheTTLDays} ${eff.cacheTTLDays === 1 ? "day" : "days"}.`, "info");
      continue;
    }

    if (choice === "Update now") {
      const result = await updateFlantInfra(orchestrator.pi, { force: true, cwd: orchestrator.cwd });
      const message = describeUpdateResult(result);
      ctx.ui?.notify?.(message.text, message.kind);
      continue;
    }

    ctx.ui?.notify?.(flantStatusText(settings), "info");
  }
}

async function showCopilotMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const settings = loadFlantSettings(orchestrator.cwd);
    const tokenPresent = !!(process.env.COPILOT_GITHUB_TOKEN || readCopilotOAuthToken());
    const enableLabel = `Enable Copilot tier: ${settings.copilotEnabled ? "ON" : "OFF"}`;
    const statusLine = settings.copilotEnabled
      ? tokenPresent
        ? "Active — Claude falls here when the subscription is rate-limited (its only automatic fallback)."
        : "Enabled but Copilot credentials are missing — run /login → GitHub Copilot or set COPILOT_GITHUB_TOKEN."
      : "Disabled — a rate-limited Claude subscription has no automatic fallback and waits for the limit to clear.";
    const choice = await selectOption(ctx, "Copilot", [
      opt(enableLabel, "Use Copilot as the automatic fallback when the Claude subscription is rate-limited"),
      opt("Current status", statusLine),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Current status") {
      ctx.ui?.notify?.(statusLine, "info");
      continue;
    }
    const turningOn = !settings.copilotEnabled;
    if (turningOn && !tokenPresent) {
      ctx.ui?.notify?.("Run /login → GitHub Copilot or set COPILOT_GITHUB_TOKEN first.", "warning");
      continue;
    }
    const scope = await setFlantConfigValue(orchestrator, ctx, "copilotEnabled", turningOn);
    if (!scope) continue;
    const eff = loadFlantSettings(orchestrator.cwd);
    syncProviderTiers(eff);
    if (warnIfFlantEditMasked(ctx, "Copilot", scope, turningOn, eff.copilotEnabled)) continue;
    ctx.ui?.notify?.(turningOn ? "Copilot tier ON — a rate-limited Claude subscription now falls back to Copilot." : "Copilot tier OFF — a rate-limited Claude subscription waits for the limit to clear.", "info");
  }
}

function parseCommaSeparated(input: string): string[] {
  return input.split(",").map((item) => item.trim()).filter(Boolean);
}

function commandIdFromRun(run: string): string {
  const base = run.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "command";
}

function ensureUniqueCommandId(existing: Record<string, unknown>, base: string): string {
  if (!Object.prototype.hasOwnProperty.call(existing, base)) return base;
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(existing, `${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

async function showCommandEditor(orchestrator: Orchestrator, ctx: any, id: string): Promise<void> {
  const commandPath = ["commands", "afterEdit", id];
  for (;;) {
    const command = orchestrator.config.commands.afterEdit[id];
    if (!command) return;
    const choice = await selectOption(ctx, `Command "${id}"`, [
      opt("Edit command", command.run),
      opt("Edit triggers", `${(command.globs ?? []).length} glob patterns: ${(command.globs ?? []).join(", ") || "(all files)"}`),
      opt(`Enabled: ${command.enabled === false ? "No" : "Yes"}`, "Toggle command"),
      opt("Delete command", "Remove this command"),
      opt(BACK, "Return to previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Edit command") {
      const run = await promptRequiredInput(ctx, `Command (current: ${command.run})`);
      if (!run) continue;
      applyScopeChoice(orchestrator, [...commandPath, "run"], run, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice === "Edit triggers") {
      const globInput = await promptRequiredInput(ctx, `Glob patterns, comma-separated (current: ${(command.globs ?? []).join(", ") || "(all files)"})`);
      if (!globInput) continue;
      const patterns = parseCommaSeparated(globInput);
      if (patterns.length === 0) {
        ctx.ui?.notify?.("At least one file pattern is required.", "warning");
        continue;
      }
      applyScopeChoice(orchestrator, [...commandPath, "globs"], patterns, await pickScope(ctx, orchestrator));
      continue;
    }
    if (choice.startsWith("Enabled:")) {
      await showBooleanSetting(orchestrator, ctx, "Enabled", [...commandPath, "enabled"], "Run this command when its triggers fire", "Keep this command configured but stop running it");
      continue;
    }
    const confirm = await selectOption(ctx, "Confirm delete?", [opt("Yes, delete", "This cannot be undone"), opt(BACK, "Cancel")]);
    if (confirm !== "Yes, delete") continue;
    const scope = await pickScopeFromOwned(ctx, orchestrator, commandPath);
    if (!scope) {
      ctx.ui?.notify?.("This command has no removable override in your config scopes.", "info");
      continue;
    }
    clearConfigOverride(orchestrator, scope, commandPath);
    return;
  }
}

async function showCommandsSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const commands = orchestrator.config.commands.afterEdit;
    const entries = Object.entries(commands);
    const options: OptionInput[] = [];
    const byTitle = new Map<string, string>();
    const usedTitles = new Set<string>();
    for (const [id, cmd] of entries) {
      const enabledTag = cmd.enabled === false ? " [disabled]" : "";
      const title = makeUniqueTitle(`Command "${id}"${enabledTag}`, usedTitles);
      options.push(opt(title, `${(cmd.globs ?? []).length} patterns — ${cmd.run}`));
      byTitle.set(title, id);
    }
    options.push(opt("New command", "Add a command to run after a file edit (e.g. a formatter or linter)"));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, `After file edit: ${entries.length} commands`, options);
    if (!choice || choice === BACK) return;
    if (choice === "New command") {
      const run = await promptRequiredInput(ctx, "Command to run (supports ${file} and ${dir})");
      if (!run) continue;
      const globInput = await promptRequiredInput(ctx, "Glob patterns (comma-separated, e.g. *.ts,src/**)");
      if (!globInput) {
        ctx.ui?.notify?.("At least one file pattern is required.", "warning");
        continue;
      }
      const patterns = parseCommaSeparated(globInput);
      if (patterns.length === 0) {
        ctx.ui?.notify?.("At least one file pattern is required.", "warning");
        continue;
      }
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      const id = ensureUniqueCommandId(commands, commandIdFromRun(run));
      applyConfigChange(orchestrator, scope, ["commands", "afterEdit", id], { run, globs: patterns, enabled: true });
      continue;
    }
    const id = byTitle.get(choice);
    if (id) await showCommandEditor(orchestrator, ctx, id);
  }
}

async function showTimeoutsSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const options: OptionInput[] = TIMEOUT_ITEMS.map((item) => {
      const value = getNestedValue(orchestrator.config, item.path);
      return opt(`${item.label}: ${formatDuration(value)}`, "Change this time limit");
    });
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Timeouts", options);
    if (!choice || choice === BACK) return;
    const item = TIMEOUT_ITEMS.find((entry) => choice.startsWith(`${entry.label}:`));
    if (!item) continue;
    for (;;) {
      const current = getNestedValue(orchestrator.config, item.path);
      if (typeof current !== "number") break;
      const action = await selectOption(ctx, `${item.label}: ${formatDuration(current)}`, [
        opt("Edit", "Set timeout value"),
        ...buildResetOptions(orchestrator, item.path),
        opt(BACK, "Return to the previous menu"),
      ]);
      if (!action || action === BACK) break;
      if (action === "Edit") {
        const input = await promptRequiredInput(ctx, `New value (current: ${formatDuration(current)}, e.g. 30s, 5m, 1h, or milliseconds)`);
        if (!input) continue;
        const parsed = parseDuration(input);
        if (parsed === null) {
          ctx.ui?.notify?.("Invalid duration format.", "warning");
          continue;
        }
        applyScopeChoice(orchestrator, item.path, parsed, await pickScope(ctx, orchestrator));
        continue;
      }
      await maybeHandleResetChoice(orchestrator, ctx, action, item.path);
    }
  }
}

export function showUsage(ctx: any): void {
  const tracker = (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] as
    | {
        getTotalInputTokens(): number; getTotalOutputTokens(): number;
        getTotalCacheReadTokens(): number; getTotalCacheWriteTokens(): number;
        getTotalProcessedInputTokens(): number;
        getTotalCost(): number; getCacheHitRate(): number;
        getMainInputTokens(): number; getMainOutputTokens(): number;
        getMainCacheReadTokens(): number; getMainCacheWriteTokens(): number;
        getMainCost(): number;
        getPerModelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; turns: number; subscription: boolean }>;
        getSubagentList(): Array<{ description: string; agentType: string; modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number; subscription: boolean }>;
      }
    | undefined;

  if (!tracker) {
    ctx.ui?.notify?.("No usage data available.", "info");
    return;
  }

  const hitRate = (uncached: number, cacheRead: number, cacheWrite: number): number => {
    const processed = uncached + cacheRead + cacheWrite;
    return processed > 0 ? cacheRead / processed : 0;
  };
  const inputPart = (uncached: number, cacheRead: number, cacheWrite: number, cacheSupported: boolean): string => {
    const processed = uncached + cacheRead + cacheWrite;
    const head = `↑${formatTokenCount(processed)}`;
    if (!cacheSupported) return head;
    return `${head} (u${formatTokenCount(uncached)} r${formatTokenCount(cacheRead)} w${formatTokenCount(cacheWrite)})`;
  };

  const mainCost = tracker.getMainCost();
  const models = tracker.getPerModelUsage();
  const subagents = tracker.getSubagentList();

  const byModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cacheSupported: boolean; cost: number; subscription: boolean }>();
  const mainModelEntries = Object.entries(models);
  // Subscription (flat-rate) models contribute no dollars, so exclude their
  // tokens from the proportional-share denominator.
  const mainTotalTokens = mainModelEntries.reduce((s, [, u]) => s + (u.subscription ? 0 : u.inputTokens + u.outputTokens), 0);
  for (const [modelId, usage] of mainModelEntries) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const modelCostShare = usage.subscription || mainTotalTokens <= 0 ? 0 : mainCost * (modelTokens / mainTotalTokens);
    byModel.set(modelId, {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, cacheSupported: usage.cacheSupported, cost: modelCostShare,
      subscription: usage.subscription,
    });
  }
  for (const sa of subagents) {
    const key = sa.modelId !== "unknown" ? sa.modelId : `subagent:${sa.description}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
      if (sa.subscription) existing.subscription = true;
    } else {
      byModel.set(key, {
        input: sa.inputTokens, output: sa.outputTokens,
        cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens, cacheSupported: sa.cacheSupported, cost: sa.cost,
        subscription: sa.subscription,
      });
    }
  }

  const lines: string[] = ["Session usage (total):"];
  lines.push(`  Input: ${formatTokenCount(tracker.getTotalProcessedInputTokens())} tokens`);
  lines.push(`    • uncached:    ${formatTokenCount(tracker.getTotalInputTokens())}`);
  lines.push(`    • cache read:  ${formatTokenCount(tracker.getTotalCacheReadTokens())}`);
  lines.push(`    • cache write: ${formatTokenCount(tracker.getTotalCacheWriteTokens())}`);
  lines.push(`  Output: ${formatTokenCount(tracker.getTotalOutputTokens())} tokens`);
  if (tracker.getTotalCacheReadTokens() > 0) lines.push(`  Cache: ⚡${Math.round(tracker.getCacheHitRate() * 100)}% hit rate`);
  lines.push(`  Cost: $${tracker.getTotalCost().toFixed(2)}`);

  if (byModel.size > 0) {
    lines.push("");
    lines.push("By model:");
    for (const [modelId, m] of byModel) {
      const cr = Math.round(hitRate(m.input, m.cacheRead, m.cacheWrite) * 100);
      const parts = [inputPart(m.input, m.cacheRead, m.cacheWrite, m.cacheSupported), `↓${formatTokenCount(m.output)}`];
      if (m.cacheSupported) parts.push(`⚡${cr}%`);
      if (m.subscription) parts.push("subscription");
      else if (m.cost > 0) parts.push(`$${m.cost.toFixed(2)}`);
      lines.push(`  ${modelId}: ${parts.join("  ")}`);
    }
  }

  lines.push("");
  lines.push("By agent:");
  const agentModelNames = Object.keys(models);
  if (agentModelNames.length > 0) {
    const mainCacheSupported = mainModelEntries.some(([, u]) => u.cacheSupported);
    const mainAllSubscription = mainModelEntries.every(([, u]) => u.subscription);
    const mainInput = tracker.getMainInputTokens();
    const mainCacheRead = tracker.getMainCacheReadTokens();
    const mainCacheWrite = tracker.getMainCacheWriteTokens();
    const mainParts = [inputPart(mainInput, mainCacheRead, mainCacheWrite, mainCacheSupported), `↓${formatTokenCount(tracker.getMainOutputTokens())}`];
    if (mainCacheSupported) mainParts.push(`⚡${Math.round(hitRate(mainInput, mainCacheRead, mainCacheWrite) * 100)}%`);
    if (mainAllSubscription) mainParts.push("subscription");
    else if (mainCost > 0) mainParts.push(`$${mainCost.toFixed(2)}`);
    lines.push(`  Main (${agentModelNames.join(", ")}): ${mainParts.join("  ")}`);
  }
  const byAgentType = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cacheSupported: boolean; cost: number; durationMs: number; toolUses: number; count: number; subscriptionRuns: number }>();
  for (const sa of subagents) {
    const key = sa.agentType || sa.description;
    const existing = byAgentType.get(key);
    if (existing) {
      existing.input += sa.inputTokens;
      existing.output += sa.outputTokens;
      existing.cacheRead += sa.cacheReadTokens;
      existing.cacheWrite += sa.cacheWriteTokens;
      if (sa.cacheSupported) existing.cacheSupported = true;
      existing.cost += sa.cost;
      existing.durationMs += sa.durationMs;
      existing.toolUses += sa.toolUses;
      existing.count += 1;
      if (sa.subscription) existing.subscriptionRuns += 1;
    } else {
      byAgentType.set(key, {
        input: sa.inputTokens, output: sa.outputTokens, cacheRead: sa.cacheReadTokens, cacheWrite: sa.cacheWriteTokens,
        cacheSupported: sa.cacheSupported, cost: sa.cost, durationMs: sa.durationMs, toolUses: sa.toolUses, count: 1,
        subscriptionRuns: sa.subscription ? 1 : 0,
      });
    }
  }
  for (const [agentType, agg] of byAgentType) {
    const parts = [inputPart(agg.input, agg.cacheRead, agg.cacheWrite, agg.cacheSupported), `↓${formatTokenCount(agg.output)}`];
    if (agg.cacheSupported) parts.push(`⚡${Math.round(hitRate(agg.input, agg.cacheRead, agg.cacheWrite) * 100)}%`);
    if (agg.subscriptionRuns === agg.count) parts.push("subscription");
    else if (agg.cost > 0) parts.push(`$${agg.cost.toFixed(2)}`);
    if (agg.durationMs > 0) parts.push(formatElapsedDuration(agg.durationMs));
    if (agg.toolUses > 0) parts.push(`${agg.toolUses} tools`);
    const countSuffix = agg.count > 1 ? ` (×${agg.count})` : "";
    lines.push(`  ${agentType}${countSuffix}: ${parts.join("  ")}`);
  }

  ctx.ui?.notify?.(lines.join("\n"), "info");
}

async function showLspSettings(ctx: any): Promise<void> {
  for (;;) {
    const choice = await selectOption(ctx, "LSP", [
      opt("Restart all servers", "Stop all servers. They reinitialize on next use"),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    const api = (globalThis as any)[Symbol.for("pi-lsp:api")] as { restart?: (menuCtx: any) => Promise<void> } | undefined;
    if (!api?.restart) {
      ctx.ui?.notify?.("LSP API is not available.", "warning");
      continue;
    }
    try {
      await api.restart(ctx);
    } catch (error: any) {
      ctx.ui?.notify?.(`Failed to restart LSP servers: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
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
    const choice = await selectOption(ctx, "Workers", [
      opt("Open worker dashboard", `${active.length} active, ${records.length} recorded`),
      ...(active.length ? [opt("Stop all active workers", "Abort bounded background work; the main session continues.")] : []),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Open worker dashboard") {
      const menu = (globalThis as any)[Symbol.for("pi-subagents:menu")] as { showFleet?: (ctx: any) => Promise<void> } | undefined;
      if (typeof menu?.showFleet === "function") {
        await menu.showFleet(ctx);
      } else {
        ctx.ui?.notify?.(records.length ? records.map((r) => `${r.status}: ${r.description ?? r.type ?? r.id}`).join("\n") : "No workers recorded.", "info");
      }
      continue;
    }
    if (choice === "Stop all active workers") orchestrator.abortAllSubagents();
  }
}

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function sessionStatus(orchestrator: Orchestrator, ctx: any): string {
  const usage = ctx.getContextUsage?.();
  const records = workerRecords();
  const active = records.filter((record) => record.status === "running" || record.status === "queued");
  const settings = loadFlantSettings(orchestrator.cwd);
  const tracker = (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] as { getTotalCost?: () => number } | undefined;
  const cost = tracker?.getTotalCost?.();
  const contextLine = usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0
    ? `${formatTokenCount(usage.tokens ?? 0)} / ${formatTokenCount(usage.contextWindow)} tokens (${Math.round(((usage.tokens ?? 0) / usage.contextWindow) * 100)}%)`
    : "unavailable";
  const lines = [
    `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} · thinking ${orchestrator.config.agents.main.thinking}`,
    `Context: ${contextLine}`,
    ...(typeof cost === "number" && cost > 0 ? [`Session cost: $${cost.toFixed(2)}`] : []),
    `Flant: ${settings.enabled ? `on · subscription ${settings.subscription ? (readClaudeOAuthToken() ? (readGatewayApiKey() ? "active" : "MISSING GATEWAY KEY") : "MISSING TOKEN") : "off"}` : "off"}`,
    ...(orchestrator.subFallbackActive ? ["⚠ Subscription rate-limited — waiting for the limit to clear"] : []),
    ...(orchestrator.continuationHalted ? ["⚠ Automatic continuation paused (repeated stalls) — send a message to resume"] : []),
    ...(orchestrator.configError ? [`⚠ Config error: ${orchestrator.configError}`] : []),
  ];
  if (active.length > 0) {
    lines.push(`Workers (${active.length} active):`);
    for (const record of active.slice(0, 6)) {
      const age = orchestrator.agentSpawnTimes.get(record.id);
      lines.push(`  • ${record.status}: ${record.description ?? record.type ?? record.id}${age ? ` (${formatAge(Date.now() - age)})` : ""}`);
    }
  }
  return lines.join("\n");
}

async function showReportMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const { collectReportFiles, writeReportBundle } = await import("./report.js");
  orchestrator.interactivePromptOpen = true;
  let note: string | undefined;
  try {
    const res = await askUser(ctx, {
      question: "Describe the issue or feedback (this stays local — nothing is sent anywhere):",
      options: [],
      allowFreeform: true,
      allowComment: false,
      allowMultiple: false,
    });
    if (res && !isCancel(res) && res.kind === "freeform") note = res.text;
  } finally {
    orchestrator.interactivePromptOpen = false;
  }
  if (!note || !note.trim()) {
    ctx.ui?.notify?.("Report cancelled — a note is required.", "info");
    return;
  }
  const files = collectReportFiles(orchestrator.cwd);
  const confirm = await selectOption(ctx, `Write report bundle (${files.length + 1} files)?`, [
    opt("Write report", ["note.md", ...files.map((file) => file.archivePath)].slice(0, 12).join(", ") + (files.length > 11 ? ", …" : "")),
    opt(BACK, "Cancel"),
  ]);
  if (confirm !== "Write report") return;
  const written = writeReportBundle(orchestrator.cwd, note, files);
  ctx.ui?.notify?.(`Report written to ${written.reportDir} (${written.captured.length} files). Nothing was sent anywhere.`, "info");
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  OrchestratorRef.current = orchestrator;
  for (;;) {
    const choice = await selectOption(ctx, "/pp · session control panel", [
      opt("Status", "Model, context, providers, workers, and warnings"),
      opt("Workers", "Inspect or stop bounded background workers"),
      opt("Usage", "Session token usage and cost breakdown"),
      opt("Agents", "Main agent, worker models, pools, and concurrency"),
      opt("Flant", "Provider routing and Claude subscription"),
      opt("Copilot", "GitHub Copilot provider tier"),
      opt("Skills", "Bundled/global/project skill sources and catalog"),
      opt("Context", "AGENTS.md / CLAUDE.md injection (global/ancestor/project)"),
      opt("Compaction", "Automatic compaction thresholds and manual compact"),
      opt("Commands", "Shell commands to run after file edits (formatters, linters)"),
      opt("General", "Log level and tracing"),
      opt("Performance", "Stale-turn and stale-worker time limits"),
      opt("LSP", "Language server controls"),
      opt("Report", "Bundle a local feedback report (note + logs)"),
      opt("Doctor", "Run diagnostic checks"),
      opt(CLOSE, "Return to the prompt"),
    ]);
    if (!choice || choice === CLOSE) return;
    if (choice === "Status") ctx.ui?.notify?.(sessionStatus(orchestrator, ctx), "info");
    else if (choice === "Workers") await showWorkers(orchestrator, ctx);
    else if (choice === "Usage") showUsage(ctx);
    else if (choice === "Agents") await showAgentsSettings(orchestrator, ctx);
    else if (choice === "Flant") await showFlantMenu(orchestrator, ctx);
    else if (choice === "Copilot") await showCopilotMenu(orchestrator, ctx);
    else if (choice === "Skills") await showSkillsSettings(orchestrator, ctx);
    else if (choice === "Context") await showContextSettings(orchestrator, ctx);
    else if (choice === "Compaction") await showCompactionSettings(orchestrator, ctx);
    else if (choice === "Commands") await showCommandsSettings(orchestrator, ctx);
    else if (choice === "General") await showGeneralSettings(orchestrator, ctx);
    else if (choice === "Performance") await showTimeoutsSettings(orchestrator, ctx);
    else if (choice === "LSP") await showLspSettings(ctx);
    else if (choice === "Report") await showReportMenu(orchestrator, ctx);
    else if (choice === "Doctor") {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(orchestrator, ctx);
    }
  }
}
