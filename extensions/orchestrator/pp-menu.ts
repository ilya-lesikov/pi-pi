import { isDeepStrictEqual } from "util";
import { join } from "path";
import { askUser, isCancel } from "./ask/index.js";
import { migrateConfigLayer } from "./config-migration.js";
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
  hasClaudeSubCredential,
  hasCodexCredential,
  isClaudeSubInUse,
  loadLlmApiCache,
  readCopilotOAuthToken,
  readGatewayApiKey,
  updateFlantInfra,
} from "./flant-infra.js";
import {
  FAMILIES,
  FAMILY_LABEL,
  PROVIDER_LABEL,
  catalogModelsOf,
  catalogProviders,
  concreteProviderLabel,
  describePauseKey,
  formatSlotRef,
  isSlotRef,
  listPauses,
  overrideModelFor,
  parseRef,
  pinnedRoleSpecs,
  refLabel,
  resolveRef,
  slotsOf,
  splitSpec,
  type ClaudeSubRoute,
  type FamilyName,
  type ProviderName,
  type SlotName,
} from "./routing.js";
import { compareModelVersion } from "./model-version.js";
import { clearAllPauses } from "./rate-limit-fallback.js";
import { captureAvailableModels, mainUnavailableMessage } from "./event-handlers.js";
import { enabledSkillLayers, listLayeredSkills } from "./skills-manifest.js";
import { buildPoolRoster } from "./agents/registry.js";
import { setLogLevel } from "./log.js";
import { DEFAULT_KEEP_FRACTION, DEFAULT_HEADROOM_TOKENS, DEFAULT_MAX_PROMPT_TOKENS } from "./promptcap/limits.js";
import { DEFAULT_IMAGE_TOKENS } from "./promptcap/estimate.js";
import { finalizeTracer, getTracer, initTracer } from "./tracer.js";
import type { Orchestrator } from "./orchestrator.js";
import { openWorkerViewer } from "./workers/ui.js";
import type { WorkerRecord } from "./workers/types.js";

type Scope = "global" | "project";
type OptionInput = string | { title: string; description?: string };
type SimpleRole = keyof PiPiConfig["agents"]["subagents"]["simple"];

const BACK = "Back";
const CLOSE = "Close";

interface ConfigSourceInfo {
  activeValue: any;
  defaultValue: any;
  globalValue: any | undefined;
  projectValue: any | undefined;
  source: "default" | "global" | "project";
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
  { path: ["performance", "internals", "workerStallWarn"], label: "Worker silent: flag after" },
  { path: ["performance", "internals", "workerStartTimeout"], label: "Worker start: fail after" },
  { path: ["performance", "internals", "workerModelStale"], label: "Worker model request: retry after" },
  { path: ["performance", "internals", "workerQuestionTimeout"], label: "Worker question: wait for answer" },
  { path: ["performance", "internals", "workerBashTimeout"], label: "Worker bash default timeout" },
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

function readLayer(orchestrator: Orchestrator, scope: Scope): Record<string, any> {
  return migrateConfigLayer(readRawConfig(getScopeConfigPath(orchestrator, scope))).config;
}

function hasLayerOverride(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): boolean {
  const raw = readLayer(orchestrator, scope);
  if (!hasNestedKey(raw, keyPath)) return false;
  return !isEmptyOverride(getNestedValue(raw, keyPath));
}

function getLayerOverrideValue(orchestrator: Orchestrator, scope: Scope, keyPath: string[]): any {
  return getNestedValue(readLayer(orchestrator, scope), keyPath);
}

function getOwnedScopes(orchestrator: Orchestrator, keyPath: string[]): Scope[] {
  const out: Scope[] = [];
  if (hasLayerOverride(orchestrator, "global", keyPath)) out.push("global");
  if (hasLayerOverride(orchestrator, "project", keyPath)) out.push("project");
  return out;
}

export function getConfigSourceInfo(orchestrator: Orchestrator, keyPath: string[]): ConfigSourceInfo {
  const globalConfig = migrateConfigLayer(readRawConfig(GLOBAL_CONFIG_PATH)).config;
  const projectConfig = migrateConfigLayer(readRawConfig(getProjectConfigPath(orchestrator.cwd))).config;
  const source = hasNestedKey(projectConfig, keyPath)
    ? "project"
    : hasNestedKey(globalConfig, keyPath)
    ? "global"
    : "default";
  return {
    activeValue: getNestedValue(orchestrator.config as Record<string, any>, keyPath),
    defaultValue: getNestedValue(getDefaultConfig() as Record<string, any>, keyPath),
    globalValue: hasNestedKey(globalConfig, keyPath) ? getNestedValue(globalConfig, keyPath) : undefined,
    projectValue: hasNestedKey(projectConfig, keyPath) ? getNestedValue(projectConfig, keyPath) : undefined,
    source,
  };
}

export function formatSourceTags(currentValue: any, info: ConfigSourceInfo): string {
  const tags: string[] = [];
  if (isDeepStrictEqual(currentValue, info.activeValue)) tags.push("active");
  if (isDeepStrictEqual(currentValue, info.defaultValue)) tags.push("default");
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
    const nextGlobal = readLayer(orchestrator, "global");
    const nextProject = readLayer(orchestrator, "project");
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
    const nextGlobal = readLayer(orchestrator, "global");
    const nextProject = readLayer(orchestrator, "project");
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
  const key = keyPath.join(".");
  if (keyPath[0] === "providers" || keyPath[0] === "models") {
    void reconcileRouting(orchestrator, orchestrator.lastCtx, keyPath[0] === "providers" || keyPath[1] === "claude");
    return;
  }
  if (keyPath[0] === "agents") {
    orchestrator.registerAgents(true);
    if (keyPath[1] === "maxConcurrentSubagents") orchestrator.workers?.poke();
    if (keyPath[1] === "main" && orchestrator.lastCtx) {
      void orchestrator.applyMainAgent(orchestrator.lastCtx).then((ok) => {
        if (!ok) orchestrator.lastCtx?.ui?.notify?.(mainUnavailableMessage(orchestrator), "warning");
      });
    }
    return;
  }
  if (key === "general.tracing") {
    const sessionId = orchestrator.lastCtx?.sessionManager?.getSessionId?.();
    if (orchestrator.config.general.tracing && sessionId && !getTracer()) initTracer(`${orchestrator.cwd}/.pp`, sessionId);
    if (!orchestrator.config.general.tracing) finalizeTracer();
  }
}

/**
 * Carry a routing change through: re-register the providers it touches, take
 * a fresh catalog, rebuild worker definitions, and re-route the main session
 * between turns. A session on a model the user picked by hand is left alone.
 */
async function reconcileRouting(orchestrator: Orchestrator, ctx: any, reregister: boolean): Promise<void> {
  if (reregister) {
    const result = await updateFlantInfra(orchestrator.pi, { cwd: orchestrator.cwd, pinnedSpecs: pinnedRoleSpecs(orchestrator.config) });
    if (!result.ok && readGatewayApiKey()) ctx?.ui?.notify?.(`LLM API update failed: ${result.error ?? "unknown error"}`, "warning");
  }
  captureAvailableModels(ctx);
  orchestrator.registerAgents(true);
  if (!ctx) return;
  await orchestrator.runModelSwitchBetweenTurns(async () => {
    if (orchestrator.routedMainSpec) await orchestrator.restoreMainRouting(ctx);
    else if (!await orchestrator.applyMainAgent(ctx)) ctx.ui?.notify?.(mainUnavailableMessage(orchestrator), "warning");
  });
}

function applyConfigChange(orchestrator: Orchestrator, scope: Scope, keyPath: string[], value: any): void {
  const result = tryApplyConfigChange(orchestrator, scope, keyPath, value);
  if (!result.ok) {
    orchestrator.lastCtx?.ui?.notify?.(`Config update rejected: ${result.error}`, "error");
    return;
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
    const globalConfig = readLayer(orchestrator, "global");
    const projectConfig = readLayer(orchestrator, "project");
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
    if (seen.has(spec.toLowerCase())) continue;
    seen.add(spec.toLowerCase());
    models.push({ provider, id, spec });
  }
  return models.sort((a, b) => a.provider.localeCompare(b.provider) || compareModelVersion(b.id, a.id));
}

/** "→ claude-opus-5-5 via Claude subscription (direct)", or why nothing serves it. */
function routeSummary(ref: string): string {
  const resolution = resolveRef(ref);
  if (!resolution.spec) return "⚠ nothing serves it — open Explain routing";
  const parts = splitSpec(resolution.spec)!;
  const pinned = parseRef(ref)?.kind === "pin" ? " [pinned]" : "";
  const pro = resolution.proFallback ? " (no pro here; base)" : "";
  const kept = resolution.via === "last-good" ? " (last working)" : "";
  return `→ ${parts.id} via ${concreteProviderLabel(parts.provider)}${pro}${kept}${pinned}`;
}

function modelCapabilities(ctx: any, spec: string): string {
  const parts = splitSpec(spec);
  const model = parts ? ctx?.modelRegistry?.find?.(parts.provider, parts.id) : null;
  if (!model) return "";
  const window = typeof model.contextWindow === "number" ? `${formatTokenCount(model.contextWindow)} context` : "";
  const images = model.input?.includes?.("image") ? "images" : "no images";
  const thinking = model.reasoning ? "thinking" : "no thinking";
  return [window, images, thinking].filter(Boolean).join(" · ");
}

async function pickProviderModel(ctx: any, title: string): Promise<string | null> {
  const models = listAvailableModels(ctx);
  const providers = [...new Set(models.map((m) => m.provider))];
  const providerTitles = new Map<string, string>();
  const options: OptionInput[] = providers.map((provider) => {
    const count = models.filter((m) => m.provider === provider).length;
    const label = concreteProviderLabel(provider);
    const t = label === provider ? provider : `${label} (${provider})`;
    providerTitles.set(t, provider);
    return opt(t, `${count} models`);
  });
  options.push(opt(BACK, "Return to the previous menu"));
  for (;;) {
    const choice = await selectOption(ctx, title, options);
    if (!choice || choice === BACK) return null;
    const provider = providerTitles.get(choice);
    if (!provider) continue;
    const byTitle = new Map<string, string>();
    const modelOptions: OptionInput[] = models.filter((m) => m.provider === provider).map((m) => {
      byTitle.set(m.id, m.spec);
      return opt(m.id, modelCapabilities(ctx, m.spec) || m.spec);
    });
    modelOptions.push(opt(BACK, "Return to the previous menu"));
    const picked = await selectOption(ctx, `${title} › ${concreteProviderLabel(provider)}`, modelOptions);
    if (!picked || picked === BACK) continue;
    const spec = byTitle.get(picked);
    if (spec) return spec;
  }
}

async function pickModel(ctx: any, currentModel?: string): Promise<string | null> {
  const options: OptionInput[] = [];
  const byTitle = new Map<string, string>();
  const used = new Set<string>();
  const add = (ref: string) => {
    const tag = ref === currentModel ? " [active]" : "";
    const title = makeUniqueTitle(`${refLabel(ref)}${tag}`, used);
    byTitle.set(title, ref);
    options.push(opt(title, routeSummary(ref)));
  };
  for (const family of FAMILIES) {
    for (const def of slotsOf(family).slice().reverse()) {
      add(formatSlotRef(family, def.slot));
      if (family === "gpt" && !orchestratorOverride(family)) add(formatSlotRef(family, def.slot, true));
    }
  }
  if (currentModel && !isSlotRef(currentModel)) {
    const title = makeUniqueTitle(`${currentModel} [active] [pinned]`, used);
    byTitle.set(title, currentModel);
    options.unshift(opt(title, routeSummary(currentModel)));
  }
  const PIN = "Pin a specific provider/model…";
  options.push(opt(PIN, "Bypass routing: always this exact model, no fallback"));
  options.push(opt(BACK, "Return to the previous menu"));
  for (;;) {
    const choice = await selectOption(ctx, "Model", options);
    if (!choice || choice === BACK) return null;
    if (choice === PIN) {
      const spec = await pickProviderModel(ctx, "Pin model");
      if (spec) return spec;
      continue;
    }
    const selected = byTitle.get(choice);
    if (selected) return selected;
  }
}

function orchestratorOverride(family: FamilyName): boolean {
  return !!OrchestratorRef.current?.config?.models?.[family]?.override;
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

async function showAgentEditor(orchestrator: Orchestrator, ctx: any, basePath: string[], label: string, getCurrent: () => { model: string; thinking: string }): Promise<void> {
  for (;;) {
    const current = getCurrent();
    const choice = await selectOption(ctx, label, [
      opt(`Model: ${refLabel(current.model)}`, routeSummary(current.model)),
      opt(`Thinking: ${thinkingLabel(current.thinking)}`, "Choose how much this agent thinks before acting"),
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
      opt(`Model: ${refLabel(entry.model)}`, routeSummary(entry.model)),
      opt(`Thinking: ${thinkingLabel(entry.thinking)}`, "Choose how much this agent thinks before acting"),
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
    const confirm = await selectOption(ctx, "Confirm delete?", [opt("Yes, delete", "This cannot be undone"), opt(BACK, "Cancel")]);
    if (confirm !== "Yes, delete") continue;
    const next = structuredClone(entries);
    next.splice(index, 1);
    if (await writePool(orchestrator, ctx, pool, next)) return;
  }
}

async function showPoolSettings(orchestrator: Orchestrator, ctx: any, pool: PoolKey, label: string): Promise<void> {
  const keyPath = ["agents", "subagents", "pools", pool];
  for (;;) {
    const entries = orchestrator.config.agents.subagents.pools[pool] ?? [];
    const options: OptionInput[] = [];
    const byTitle = new Map<string, number>();
    const usedTitles = new Set<string>();
    entries.forEach((entry, i) => {
      const tag = entry.enabled === false ? " (disabled)" : "";
      const title = makeUniqueTitle(`${refLabel(entry.model)}${tag}`, usedTitles);
      options.push(opt(title, `${thinkingLabel(entry.thinking)} ${routeSummary(entry.model)}`));
      byTitle.set(title, i);
    });
    options.push(opt("New entry", `Add a model to the ${label.toLowerCase()} pool`));
    // Entry edits rewrite the whole array into one scope, so without these a
    // project override can never be lifted and writePool's "reset it first"
    // advice would have nowhere to go.
    options.push(...buildResetOptions(orchestrator, keyPath));
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
    if (idx !== undefined) {
      await showPoolEntryEditor(orchestrator, ctx, pool, idx);
      continue;
    }
    await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath);
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
      opt("Main", `${refLabel(config.main.model)} · ${thinkingLabel(config.main.thinking)} ${routeSummary(config.main.model)}`),
      ...SIMPLE_ROLES.map(({ role, label }) => {
        const current = config.subagents.simple[role];
        return opt(label, `${refLabel(current.model)} · ${thinkingLabel(current.thinking)} ${routeSummary(current.model)}`);
      }),
      ...POOL_ITEMS.map((item) => {
        const pool = config.subagents.pools[item.pool] ?? [];
        const enabled = pool.filter((entry) => entry.enabled !== false);
        return opt(item.label, `${enabled.length}/${pool.length} enabled: ${enabled.map((entry) => refLabel(entry.model)).join(", ") || "none"}`);
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
      await showAgentEditor(orchestrator, ctx, ["agents", "subagents", "simple", simple.role], simple.label, () => orchestrator.config.agents.subagents.simple[simple.role]);
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
    const skills = listLayeredSkills(orchestrator.cwd, enabledSkillLayers(enabled));
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

async function showPromptcapSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const pickers: Array<{
    prefix: string;
    key: "maxPromptTokens" | "contextWindow" | "headroomTokens" | "keepFraction" | "imageTokens";
    question: string;
    choices: Array<{ title: string; description: string }>;
    parse?: (title: string) => number;
  }> = [
    {
      prefix: "Prompt ceiling:",
      key: "maxPromptTokens",
      question: "Prompt ceiling (tokens)",
      choices: [
        { title: "100K", description: "Fold sooner, while the session's prose is still small" },
        { title: "150K", description: "Default" },
        { title: "250K", description: "Fold later, keeping more tool history" },
        { title: "400K", description: "Fold much later" },
      ],
    },
    {
      prefix: "Context window:",
      key: "contextWindow",
      question: "Context window (tokens)",
      choices: [
        { title: "Ask the host", description: "Use the window the host reports for the active model (default)" },
        { title: "200K", description: "Declare a 200K window" },
        { title: "400K", description: "Declare a 400K window" },
        { title: "1M", description: "Declare a 1M window" },
      ],
    },
    {
      prefix: "Headroom:",
      key: "headroomTokens",
      question: "Headroom above unfoldable prose (tokens)",
      choices: [
        { title: "100K", description: "Fold sooner and more often, keeping the prompt small" },
        { title: "200K", description: "Default" },
        { title: "300K", description: "Fold rarely, at the cost of a larger prompt every request" },
      ],
    },
    {
      prefix: "Image cost:",
      key: "imageTokens",
      question: "What one image counts as (tokens)",
      choices: [
        { title: "1.6K", description: "Default — what a frontier model charges for an image" },
        { title: "5K", description: "For a model whose vendor prices images above that" },
        { title: "25K", description: "For a small model priced per token far below a large one" },
      ],
      parse: (title) => Number(title.replace("K", "")) * 1000,
    },
    {
      prefix: "History kept:",
      key: "keepFraction",
      question: "How much of the headroom a fold keeps as recent tool history",
      choices: [
        { title: "20%", description: "Less history kept, and longer before the next fold" },
        { title: "30%", description: "Default" },
        { title: "50%", description: "More history kept, at the cost of folding sooner" },
      ],
      parse: (title) => Number(title.replace("%", "")) / 100,
    },
  ];
  const parse = (title: string): number => {
    if (title === "Ask the host") return 0;
    if (title.endsWith("M")) return Number(title.replace("M", "")) * 1_000_000;
    return Number(title.replace("K", "")) * 1000;
  };
  for (;;) {
    const c = orchestrator.config.promptcap;
    const options: OptionInput[] = [
      opt(`Fold old tool calls: ${c.enabled ? "ON" : "OFF"}`, "Replace old tool output and arguments in the prompt with a recallable notice"),
    ];
    if (c.enabled) {
      options.push(
        opt(`Prompt ceiling: ${Math.round((c.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS) / 1000)}K tokens`, "Where folding starts, unless the unfoldable prose plus headroom already sits above it"),
        opt(`Context window: ${c.contextWindow ? `${Math.round(c.contextWindow / 1000)}K tokens` : "ask the host"}`, "Declare the model's window, for a provider that does not report one"),
        opt(`Headroom: ${Math.round((c.headroomTokens ?? DEFAULT_HEADROOM_TOKENS) / 1000)}K tokens`, "Room kept above the prose that cannot be folded, before folding starts"),
        opt(`History kept: ${Math.round((c.keepFraction ?? DEFAULT_KEEP_FRACTION) * 100)}%`, "How much of that headroom a fold keeps as recent tool history; the rest is room to grow back into"),
        opt(`Image cost: ${((c.imageTokens ?? DEFAULT_IMAGE_TOKENS) / 1000).toFixed(1)}K tokens`, "What one image is counted as; raise it for a model whose vendor charges more for the same picture"),
        opt(`Hour-long cache: ${c.longCacheRetention === false ? "OFF" : "ON"}`, "Ask Anthropic to hold the prompt cache for an hour, so a pause longer than five minutes stops re-buying the prompt"),
      );
      const guard = orchestrator.promptGuard;
      if (guard?.lastTokens != null && guard.lastCeiling != null) {
        options.push(opt(`Last prompt: ${Math.round(guard.lastTokens / 1000)}K of ${Math.round(guard.lastCeiling / 1000)}K`, "What the most recent request was estimated at, against the ceiling it was held to"));
      }
    }
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Prompt size", options);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Fold old tool calls:")) {
      await showBooleanSetting(orchestrator, ctx, "Fold old tool calls", ["promptcap", "enabled"], "Replace old tool output and arguments in the prompt with a recallable notice", "Send the whole conversation");
      continue;
    }
    if (choice.startsWith("Hour-long cache:")) {
      await showBooleanSetting(orchestrator, ctx, "Hour-long cache", ["promptcap", "longCacheRetention"], "Hold the prompt cache for an hour, at 2x base on what is written", "Leave the provider's five-minute default");
      continue;
    }
    const picker = pickers.find((entry) => choice.startsWith(entry.prefix));
    if (!picker) continue;
    const sel = await selectOption(ctx, picker.question, [...picker.choices, opt(BACK, "Return to the previous menu")]);
    if (!sel || sel === BACK) continue;
    const value = (picker.parse ?? parse)(sel);
    if (Number.isFinite(value)) {
      applyScopeChoice(orchestrator, ["promptcap", picker.key], value > 0 ? value : undefined, await pickScope(ctx, orchestrator));
    }
  }
}

type ProviderStatus = "Ready" | "Serving" | "Paused" | "No credentials" | "Unused" | "Disabled";

function providerCredential(provider: ProviderName): boolean {
  switch (provider) {
    case "claude-sub": return hasClaudeSubCredential();
    case "codex": return hasCodexCredential();
    case "copilot": return !!(process.env.COPILOT_GITHUB_TOKEN || readCopilotOAuthToken());
    case "llm-api": return !!readGatewayApiKey();
  }
}

function roleRefs(orchestrator: Orchestrator): string[] {
  const a = orchestrator.config.agents;
  return [a.main.model, ...Object.values(a.subagents.simple).map((r) => r.model), ...Object.values(a.subagents.pools).flatMap((p) => p.filter((e) => e.enabled !== false).map((e) => e.model))];
}

function providerStatus(orchestrator: Orchestrator, provider: ProviderName): { status: ProviderStatus; detail: string } {
  const settings = orchestrator.config;
  if (!settings.providers[provider].enabled) return { status: "Disabled", detail: "" };
  if (!providerCredential(provider)) {
    const how: Record<ProviderName, string> = {
      "claude-sub": "/login → Anthropic",
      codex: "/login → OpenAI (ChatGPT Plus/Pro)",
      copilot: "/login → GitHub Copilot, or COPILOT_GITHUB_TOKEN",
      "llm-api": "set LLM_API_KEY",
    };
    return { status: "No credentials", detail: how[provider] };
  }
  if (provider === "claude-sub" && !isClaudeSubInUse(settings, pinnedRoleSpecs(settings))) {
    return { status: "Unused", detail: `Claude overridden by ${settings.models.claude.override!.provider}` };
  }
  const paused = listPauses().find((p) => p.key === provider || p.key.startsWith(`${provider}:`) || p.key.startsWith(`${provider}@`));
  if (paused) {
    const until = paused.until === null ? "until it recovers" : `until ${new Date(paused.until).toTimeString().slice(0, 5)}`;
    return { status: "Paused", detail: `${describePauseKey(paused.key)} ${until}` };
  }
  const serving = roleRefs(orchestrator).some((ref) => resolveRef(ref).via === provider);
  return { status: serving ? "Serving" : "Ready", detail: "" };
}

function providerServes(provider: ProviderName): string {
  switch (provider) {
    case "claude-sub": return "Claude";
    case "codex": return "GPT";
    case "copilot": return "Claude, GPT";
    case "llm-api": return "GPT, any override";
  }
}

function warnIfMasked(ctx: any, orchestrator: Orchestrator, keyPath: string[], scope: Scope): void {
  if (scope === "global" && hasLayerOverride(orchestrator, "project", keyPath)) {
    ctx.ui?.notify?.("A project setting still governs this; the global change has no effect here until the project one is reset.", "warning");
  }
}

async function writeRoutingValue(orchestrator: Orchestrator, ctx: any, keyPath: string[], value: any, scope?: Scope | null): Promise<boolean> {
  const chosen = scope === undefined ? await pickScope(ctx, orchestrator) : scope;
  if (!chosen) return false;
  applyConfigChange(orchestrator, chosen, keyPath, value);
  warnIfMasked(ctx, orchestrator, keyPath, chosen);
  return true;
}

async function moveProvider(orchestrator: Orchestrator, ctx: any, provider: ProviderName, delta: -1 | 1): Promise<void> {
  const order = [...orchestrator.config.providers.order];
  const from = order.indexOf(provider);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  [order[from], order[to]] = [order[to]!, order[from]!];
  await writeRoutingValue(orchestrator, ctx, ["providers", "order"], order);
}

async function showClaudeSubRoute(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const keyPath = ["providers", "claude-sub", "route"];
  const choices: Array<{ title: string; route: ClaudeSubRoute[]; description: string }> = [
    { title: "Via LLM API, then direct", route: ["llm-api", "direct"], description: "Through the gateway; straight to Anthropic when the gateway fails" },
    { title: "Direct, then via LLM API", route: ["direct", "llm-api"], description: "Straight to Anthropic; through the gateway when that fails" },
    { title: "Direct only", route: ["direct"], description: "Straight to Anthropic; no LLM API key needed" },
    { title: "Via LLM API only", route: ["llm-api"], description: "Only through the gateway" },
  ];
  for (;;) {
    const info = getConfigSourceInfo(orchestrator, keyPath);
    const options: OptionInput[] = choices.map((c) => opt(withTags(c.title, formatSourceTags(c.route, info)), c.description));
    options.push(...buildResetOptions(orchestrator, keyPath), opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Claude subscription › Route", options);
    if (!choice || choice === BACK) return;
    const picked = choices.find((c) => choice.startsWith(c.title));
    if (picked) await writeRoutingValue(orchestrator, ctx, keyPath, picked.route);
    else await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath);
  }
}

function routeLabel(route: ClaudeSubRoute[]): string {
  return route.map((r) => (r === "direct" ? "direct" : "via LLM API")).join(", then ");
}

async function showProvider(orchestrator: Orchestrator, ctx: any, provider: ProviderName): Promise<void> {
  for (;;) {
    const config = orchestrator.config.providers;
    const index = config.order.indexOf(provider);
    const { status, detail } = providerStatus(orchestrator, provider);
    const enabledPath = ["providers", provider, "enabled"];
    const options: OptionInput[] = [
      opt(`Status: ${status}`, detail || `Serves ${providerServes(provider)}`),
      opt(withTags(`Enabled: ${config[provider].enabled ? "ON" : "OFF"}`, tagsString(getOwnedScopes(orchestrator, enabledPath))), config[provider].enabled ? "Stop routing anything here" : "Route through this provider again"),
    ];
    if (index > 0) options.push(opt("Move up", `Position ${index + 1} of ${config.order.length} → ${index}`));
    if (index < config.order.length - 1) options.push(opt("Move down", `Position ${index + 1} of ${config.order.length} → ${index + 2}`));
    if (provider === "claude-sub") options.push(opt(`Route: ${routeLabel(config["claude-sub"].route)}`, "How requests reach Anthropic; both bill the same subscription"));
    if (provider === "llm-api") {
      const cache = loadLlmApiCache();
      options.push(
        opt(`Auto-update on startup: ${config["llm-api"].autoUpdate ? "ON" : "OFF"}`, "Refresh the model list each time pi starts"),
        opt(`Cache period: ${config["llm-api"].cacheTTLDays} ${config["llm-api"].cacheTTLDays === 1 ? "day" : "days"}`, "How long the fetched model list is reused"),
        opt("Update now", `Last updated: ${cache.lastUpdated ?? "never"} · ${cache.cachedFlantModels?.length ?? 0} models`),
      );
    }
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, PROVIDER_LABEL[provider], options);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Status:")) {
      ctx.ui?.notify?.(`${PROVIDER_LABEL[provider]}: ${status}${detail ? ` — ${detail}` : ""}`, "info");
    } else if (choice.startsWith("Enabled:")) {
      await writeRoutingValue(orchestrator, ctx, enabledPath, !config[provider].enabled);
    } else if (choice === "Move up") {
      await moveProvider(orchestrator, ctx, provider, -1);
    } else if (choice === "Move down") {
      await moveProvider(orchestrator, ctx, provider, 1);
    } else if (choice.startsWith("Route:")) {
      await showClaudeSubRoute(orchestrator, ctx);
    } else if (choice.startsWith("Auto-update on startup:")) {
      await showBooleanSetting(orchestrator, ctx, "Auto-update on startup", ["providers", "llm-api", "autoUpdate"], "Refresh the model list each time pi starts", "Reuse the cached list until it is updated by hand");
    } else if (choice.startsWith("Cache period:")) {
      const selected = await selectOption(ctx, "Cache period", [
        opt("1 day", "Refresh daily"), opt("3 days", "Default"), opt("7 days", "Weekly"), opt("30 days", "Monthly"), opt(BACK, "Return to the previous menu"),
      ]);
      const days = selected && selected !== BACK ? Number(selected.split(" ")[0]) : NaN;
      if (Number.isFinite(days)) await writeRoutingValue(orchestrator, ctx, ["providers", "llm-api", "cacheTTLDays"], days);
    } else if (choice === "Update now") {
      const result = await updateFlantInfra(orchestrator.pi, { force: true, cwd: orchestrator.cwd, pinnedSpecs: pinnedRoleSpecs(orchestrator.config) });
      await reconcileRouting(orchestrator, ctx, false);
      ctx.ui?.notify?.(result.ok ? `LLM API: ${result.models?.length ?? 0} models.` : `LLM API update failed: ${result.error ?? "unknown error"}`, result.ok ? "info" : "error");
    }
  }
}

function explainRouting(orchestrator: Orchestrator): string {
  const lines: string[] = [`Priority: ${orchestrator.config.providers.order.map((p) => PROVIDER_LABEL[p]).join(" › ")}`];
  const refs = new Set<string>();
  for (const family of FAMILIES) for (const def of slotsOf(family)) refs.add(formatSlotRef(family, def.slot));
  for (const ref of roleRefs(orchestrator)) refs.add(ref);
  for (const ref of refs) {
    const resolution = resolveRef(ref);
    lines.push("", `${refLabel(ref)} (${ref})`);
    lines.push(...resolution.steps.map((step) => `  ${step}`));
  }
  const pauses = listPauses();
  if (pauses.length > 0) {
    lines.push("", "Paused:");
    for (const p of pauses) lines.push(`  ${describePauseKey(p.key)} — ${p.reason}${p.until ? ` (until ${new Date(p.until).toTimeString().slice(0, 5)})` : " (until a probe succeeds)"}`);
  }
  return lines.join("\n");
}

async function showProvidersSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const config = orchestrator.config.providers;
    const byTitle = new Map<string, ProviderName>();
    const options: OptionInput[] = config.order.map((provider, i) => {
      const { status, detail } = providerStatus(orchestrator, provider);
      const extra = provider === "claude-sub" ? ` · ${routeLabel(config["claude-sub"].route)}` : provider === "llm-api" ? " · paid" : "";
      const title = `${i + 1}  ${PROVIDER_LABEL[provider]}  [${status}]`;
      byTitle.set(title, provider);
      return opt(title, `${detail || `Serves ${providerServes(provider)}`}${extra}`);
    });
    const pauses = listPauses();
    options.push(
      opt(`Automatic fallback: ${config.fallback.auto ? "ON" : "OFF"}`, "On a rate limit, move to the next provider that serves the model (LLM API is paid)"),
      opt(`Retry paused providers after: ${config.fallback.retryAfterMinutes} min`, "First retry; doubles while the limit keeps refusing, or follows what the provider says"),
    );
    if (pauses.length > 0) options.push(opt(`Clear pauses (${pauses.length})`, pauses.map((p) => describePauseKey(p.key)).join(", ")));
    options.push(...buildResetOptions(orchestrator, ["providers", "order"]).map((o) => typeof o === "string" ? o : { ...o, title: o.title.replace("setting", "priority order") }));
    options.push(opt("Explain routing", "Each model slot: which provider serves it now, and why the others were skipped"), opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Providers · first that serves a model wins", options);
    if (!choice || choice === BACK) return;
    const provider = byTitle.get(choice);
    if (provider) {
      await showProvider(orchestrator, ctx, provider);
    } else if (choice.startsWith("Automatic fallback:")) {
      await showBooleanSetting(orchestrator, ctx, "Automatic fallback", ["providers", "fallback", "auto"], "Move to the next provider on a rate limit, paid ones included", "Only warn; switch models by hand");
    } else if (choice.startsWith("Retry paused providers after:")) {
      const selected = await selectOption(ctx, "Retry paused providers after", [
        opt("5 min", "Retry sooner"), opt("10 min", "Default"), opt("30 min", "Retry less often"), opt("60 min", "Hourly"), opt(BACK, "Return to the previous menu"),
      ]);
      const mins = selected && selected !== BACK ? Number(selected.split(" ")[0]) : NaN;
      if (Number.isFinite(mins)) await writeRoutingValue(orchestrator, ctx, ["providers", "fallback", "retryAfterMinutes"], mins);
    } else if (choice.startsWith("Clear pauses")) {
      const cleared = clearAllPauses(orchestrator);
      await reconcileRouting(orchestrator, ctx, false);
      ctx.ui?.notify?.(`Cleared ${cleared.length} pause(s).`, "info");
    } else if (choice === "Reset global priority order" || choice === "Reset project priority order") {
      await maybeHandleResetChoice(orchestrator, ctx, choice.replace("priority order", "setting"), ["providers", "order"]);
    } else if (choice === "Explain routing") {
      ctx.ui?.notify?.(explainRouting(orchestrator), "info");
    }
  }
}

function overrideScopeTag(orchestrator: Orchestrator, family: FamilyName): string {
  const keyPath = ["models", family, "override"];
  const g = getLayerOverrideValue(orchestrator, "global", keyPath);
  const p = getLayerOverrideValue(orchestrator, "project", keyPath);
  if (p !== undefined && g !== undefined && !isDeepStrictEqual(p, g)) return `[project: ${p?.provider ?? "none"} · global: ${g?.provider ?? "none"}]`;
  if (p !== undefined) return "[project]";
  if (g !== undefined) return "[global]";
  return "";
}

async function pickOverrideProvider(orchestrator: Orchestrator, ctx: any, family: FamilyName): Promise<string | null> {
  const providers = catalogProviders();
  const byTitle = new Map<string, string>();
  const options: OptionInput[] = providers.map((provider) => {
    const label = concreteProviderLabel(provider);
    const title = label === provider ? provider : `${label} (${provider})`;
    byTitle.set(title, provider);
    return opt(title, `${catalogModelsOf(provider).length} models · credentials present`);
  });
  options.push(opt(BACK, "Return to the previous menu"));
  const choice = await selectOption(ctx, `${FAMILY_LABEL[family]} › Override › Provider`, options);
  return choice && choice !== BACK ? byTitle.get(choice) ?? null : null;
}

async function pickOverrideModel(ctx: any, provider: string, title: string): Promise<string | null> {
  const ids = catalogModelsOf(provider).sort((a, b) => compareModelVersion(b, a));
  const options: OptionInput[] = ids.map((id) => opt(id, modelCapabilities(ctx, `${provider}/${id}`) || `${provider}/${id}`));
  options.push(opt(BACK, "Return to the previous menu"));
  const choice = await selectOption(ctx, title, options);
  return choice && choice !== BACK ? choice : null;
}

async function showOverrideEditor(orchestrator: Orchestrator, ctx: any, family: FamilyName): Promise<void> {
  const keyPath = ["models", family, "override"];
  for (;;) {
    const override = orchestrator.config.models[family].override;
    if (!override) return;
    const options: OptionInput[] = [
      opt(`Provider: ${concreteProviderLabel(override.provider)}`, "Replace with another provider (resets the models)"),
      opt(`Default model: ${override.model}`, "Fills every slot without its own model"),
      ...slotsOf(family).slice().reverse().map((def) => {
        const own = override.slots?.[def.slot];
        const spec = overrideModelFor(family, def.slot)!;
        return opt(`${def.label}: ${own ?? `${override.model} (default)`}`, `${def.tier} role · ${modelCapabilities(ctx, spec) || spec}`);
      }),
      opt("Remove override", `Back to real ${FAMILY_LABEL[family]} through provider priority`),
      opt(BACK, "Return to the previous menu"),
    ];
    const choice = await selectOption(ctx, `${FAMILY_LABEL[family]} › Override ${overrideScopeTag(orchestrator, family)}`, options);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Provider:")) {
      const provider = await pickOverrideProvider(orchestrator, ctx, family);
      if (!provider) continue;
      const model = await pickOverrideModel(ctx, provider, `${FAMILY_LABEL[family]} › Override › Default model`);
      if (model) await writeRoutingValue(orchestrator, ctx, keyPath, { provider, model });
    } else if (choice.startsWith("Default model:")) {
      const model = await pickOverrideModel(ctx, override.provider, `${FAMILY_LABEL[family]} › Override › Default model`);
      if (model) await writeRoutingValue(orchestrator, ctx, keyPath, { ...override, model });
    } else if (choice === "Remove override") {
      const scope = await pickScope(ctx, orchestrator);
      if (!scope) continue;
      // `null` rather than deleting: in the project layer it has to cancel a
      // global override, not fall through to it.
      const below = scope === "project" ? getLayerOverrideValue(orchestrator, "global", keyPath) : undefined;
      if (below) applyConfigChange(orchestrator, scope, keyPath, null);
      else clearConfigOverride(orchestrator, scope, keyPath);
      return;
    } else {
      const def = slotsOf(family).find((d) => choice.startsWith(`${d.label}:`));
      if (!def) continue;
      const model = await pickOverrideModel(ctx, override.provider, `${FAMILY_LABEL[family]} › Override › ${def.label}`);
      if (!model) continue;
      const slots = { ...(override.slots ?? {}) };
      if (model === override.model) delete slots[def.slot];
      else slots[def.slot] = model;
      await writeRoutingValue(orchestrator, ctx, keyPath, { ...override, slots });
    }
  }
}

async function showSlotPin(orchestrator: Orchestrator, ctx: any, family: FamilyName, slot: SlotName): Promise<void> {
  const keyPath = ["models", family, "pins", slot];
  const def = slotsOf(family).find((d) => d.slot === slot)!;
  const versions = new Set<string>();
  for (const provider of catalogProviders()) {
    for (const id of catalogModelsOf(provider)) {
      const bare = id.replace(/^sub\//, "");
      if (def.pattern.test(bare) && !bare.endsWith("-pro")) versions.add(bare.replace(/\./g, "-"));
    }
  }
  const options: OptionInput[] = [opt("Latest", "Use the newest version any provider serves")];
  for (const version of [...versions].sort((a, b) => compareModelVersion(b, a))) options.push(opt(version, "Lock this slot to this version"));
  options.push(...buildResetOptions(orchestrator, keyPath), opt(BACK, "Return to the previous menu"));
  const choice = await selectOption(ctx, `${def.label} › Version`, options);
  if (!choice || choice === BACK) return;
  if (choice === "Latest") {
    const scope = await pickScope(ctx, orchestrator);
    if (!scope) return;
    // In the project layer a deletion would just inherit a global pin again.
    if (scope === "project" && getLayerOverrideValue(orchestrator, "global", keyPath)) applyConfigChange(orchestrator, scope, keyPath, null);
    else clearConfigOverride(orchestrator, scope, keyPath);
    return;
  }
  if (await maybeHandleResetChoice(orchestrator, ctx, choice, keyPath)) return;
  await writeRoutingValue(orchestrator, ctx, keyPath, choice);
}

async function showFamilySettings(orchestrator: Orchestrator, ctx: any, family: FamilyName): Promise<void> {
  for (;;) {
    const config = orchestrator.config.models[family];
    if (config.override) {
      await showOverrideEditor(orchestrator, ctx, family);
      if (orchestrator.config.models[family].override) return;
      continue;
    }
    const byTitle = new Map<string, SlotName>();
    const options: OptionInput[] = [opt(`Override: none ${overrideScopeTag(orchestrator, family)}`.trim(), `Replace the whole ${FAMILY_LABEL[family]} family with another provider's models`)];
    for (const def of slotsOf(family).slice().reverse()) {
      const pin = config.pins[def.slot];
      const title = `${def.label}${pin ? ` [pinned ${pin}]` : ""}`;
      byTitle.set(title, def.slot);
      options.push(opt(title, `${def.tier} ${routeSummary(formatSlotRef(family, def.slot))}`));
    }
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, `Models › ${FAMILY_LABEL[family]}`, options);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Override:")) {
      const provider = await pickOverrideProvider(orchestrator, ctx, family);
      if (!provider) continue;
      const model = await pickOverrideModel(ctx, provider, `${FAMILY_LABEL[family]} › Override › Model for every slot`);
      if (model) await writeRoutingValue(orchestrator, ctx, ["models", family, "override"], { provider, model });
      continue;
    }
    const slot = byTitle.get(choice);
    if (slot) await showSlotPin(orchestrator, ctx, family, slot);
  }
}

async function showModelsSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const options: OptionInput[] = FAMILIES.map((family) => {
      const override = orchestrator.config.models[family].override;
      const pins = Object.keys(orchestrator.config.models[family].pins).length;
      const summary = override ? `overridden by ${override.provider} (${override.model})` : pins > 0 ? `${pins} slot(s) pinned, others latest` : "latest of each slot";
      return opt(FAMILY_LABEL[family], summary);
    });
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, "Models", options);
    if (!choice || choice === BACK) return;
    const family = FAMILIES.find((f) => FAMILY_LABEL[f] === choice);
    if (family) await showFamilySettings(orchestrator, ctx, family);
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
        getPerModelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSupported: boolean; turns: number; cost: number; subscription: boolean }>;
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
  // Exact per-model cost is recorded per turn. Summaries written before that
  // field existed carry none, so fall back to a proportional share of the main
  // total (subscription rows contribute no dollars either way).
  const hasExactCost = mainModelEntries.some(([, u]) => u.cost > 0);
  const mainTotalTokens = mainModelEntries.reduce((s, [, u]) => s + (u.subscription ? 0 : u.inputTokens + u.outputTokens), 0);
  for (const [modelId, usage] of mainModelEntries) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const modelCost = usage.subscription ? 0
      : hasExactCost ? usage.cost
      : mainTotalTokens <= 0 ? 0 : mainCost * (modelTokens / mainTotalTokens);
    byModel.set(modelId, {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, cacheSupported: usage.cacheSupported, cost: modelCost,
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

async function showLspSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const label = "Diagnostics after edits";
  const desc = "Append what running language servers report to each edit and write";
  for (;;) {
    const choice = await selectOption(ctx, "LSP", [
      opt(`${label}: ${orchestrator.config.lsp.diagnosticsAfterEdit ? "ON" : "OFF"}`, desc),
      opt("Restart all servers", "Stop all servers. They reinitialize on next use"),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice.startsWith(`${label}:`)) {
      await showBooleanSetting(orchestrator, ctx, label, ["lsp", "diagnosticsAfterEdit"], desc, "Leave edit results as they are");
      continue;
    }
    if (!orchestrator.lsp) {
      ctx.ui?.notify?.("Language servers are not available in this session.", "warning");
      continue;
    }
    try {
      await orchestrator.lsp.restart();
      ctx.ui?.notify?.("Language servers stopped; they start again on next use.", "info");
    } catch (error: any) {
      ctx.ui?.notify?.(`Failed to restart LSP servers: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

function workerRecords(orchestrator: Orchestrator): WorkerRecord[] {
  return orchestrator.workers?.list() ?? [];
}

function isActiveWorker(record: WorkerRecord): boolean {
  return record.status === "running" || record.status === "queued";
}

async function showWorkers(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const records = workerRecords(orchestrator).sort((a, b) => Number(!!b.question) - Number(!!a.question) || Number(isActiveWorker(b)) - Number(isActiveWorker(a)) || b.createdAt - a.createdAt);
    const active = records.filter(isActiveWorker);
    const now = Date.now();
    const byTitle = new Map<string, string>();
    const options: OptionInput[] = records.map((record) => {
      const state = record.question ? "? waiting on you" : record.status;
      const title = `${record.spec.type}: ${record.spec.description} [${state}] · ${record.id}`;
      byTitle.set(title, record.id);
      const age = formatAge(now - (record.startedAt ?? record.createdAt));
      const detail = record.question
        ? `${record.step ? `${formatAge(now - record.step.since)} · ` : ""}asks: ${record.question.text}`
        : record.status === "running" && record.step
          ? `${age} · ${record.step.label}`
          : `${age} · ${record.toolUses} tools${record.result?.summary ? ` · ${record.result.summary}` : record.error ? ` · ${record.error}` : ""}`;
      return opt(title, detail.slice(0, 160));
    });
    if (active.length) options.push(opt("Stop all active workers", "Kill every queued and running worker; the main session continues."));
    options.push(opt(BACK, "Return to the previous menu"));
    const choice = await selectOption(ctx, records.length ? `Workers (${active.length} active) — pick one to open its live view` : "Workers — none yet", options);
    if (!choice || choice === BACK) return;
    if (choice === "Stop all active workers") {
      orchestrator.abortAllSubagents();
      continue;
    }
    const id = byTitle.get(choice);
    if (id) await openWorkerViewer(orchestrator, ctx, id);
  }
}

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function sessionStatus(orchestrator: Orchestrator, ctx: any): string {
  const usage = ctx.getContextUsage?.();
  const active = workerRecords(orchestrator).filter(isActiveWorker);
  const tracker = (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] as { getTotalCost?: () => number } | undefined;
  const cost = tracker?.getTotalCost?.();
  const contextLine = usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0
    ? `${formatTokenCount(usage.tokens ?? 0)} / ${formatTokenCount(usage.contextWindow)} tokens (${Math.round(((usage.tokens ?? 0) / usage.contextWindow) * 100)}%)`
    : "unavailable";
  const lines = [
    `Model: ${ctx.model ? `${orchestrator.mainModelInfo(ctx).label} → ${ctx.model.provider}/${ctx.model.id}${ctx.model.provider === "pp-flant-openai" ? " [paid]" : ""}` : "none"} · thinking ${ctx.thinkingLevel ?? orchestrator.config.agents.main.thinking}`,
    `Context: ${contextLine}`,
    ...(typeof cost === "number" && cost > 0 ? [`Session cost: $${cost.toFixed(2)}`] : []),
    `Providers: ${orchestrator.config.providers.order.map((p) => `${PROVIDER_LABEL[p]} [${providerStatus(orchestrator, p).status}]`).join(" › ")}`,
    ...listPauses().map((p) => `⚠ Paused: ${describePauseKey(p.key)}${p.until ? ` until ${new Date(p.until).toTimeString().slice(0, 5)}` : " until a probe succeeds"}`),
    ...roleRefs(orchestrator).filter((ref, i, all) => all.indexOf(ref) === i && !resolveRef(ref).spec).map((ref) => `⚠ ${refLabel(ref)} has nothing to run on — /pp › Settings › Providers › Explain routing`),
    ...(orchestrator.continuationHalted ? ["⚠ Automatic continuation paused (repeated stalls) — send a message to resume"] : []),
    ...(orchestrator.configError ? [`⚠ Config error: ${orchestrator.configError}`] : []),
  ];
  if (active.length > 0) {
    lines.push(`Workers (${active.length} active):`);
    for (const record of active.slice(0, 6)) {
      lines.push(`  • ${record.question ? "waiting on you" : record.status}: ${record.spec.description} (${formatAge(Date.now() - (record.startedAt ?? record.createdAt))})`);
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

async function showSettings(orchestrator: Orchestrator, ctx: any): Promise<void> {
  for (;;) {
    const config = orchestrator.config;
    const models = FAMILIES.map((f) => `${FAMILY_LABEL[f]}: ${config.models[f].override ? `override ${config.models[f].override!.provider}` : "latest"}`).join(" · ");
    const pools = POOL_ITEMS.map((item) => config.agents.subagents.pools[item.pool].filter((e) => e.enabled !== false).length).join("/");
    const choice = await selectOption(ctx, "/pp › Settings", [
      opt("Providers", `${config.providers.order.map((p) => PROVIDER_LABEL[p]).join(" › ")}`),
      opt("Models", models),
      opt("Agents", `main ${refLabel(config.agents.main.model)} · pools ${pools} · max ${config.agents.maxConcurrentSubagents} workers`),
      opt("Skills", "Bundled/global/project skill sources and catalog"),
      opt("Context", "AGENTS.md / CLAUDE.md injection (global/ancestor/project)"),
      opt("Prompt size", "How much of the conversation reaches the model, and when old tool calls fold away"),
      opt("Commands", "Shell commands to run after file edits (formatters, linters)"),
      opt("General", "Log level and tracing"),
      opt("Performance", "Main-turn stall recovery, worker silence warning and startup, question and bash timeouts"),
      opt("LSP", "Diagnostics after edits, restart language servers"),
      opt(BACK, "Return to the previous menu"),
    ]);
    if (!choice || choice === BACK) return;
    if (choice === "Providers") await showProvidersSettings(orchestrator, ctx);
    else if (choice === "Models") await showModelsSettings(orchestrator, ctx);
    else if (choice === "Agents") await showAgentsSettings(orchestrator, ctx);
    else if (choice === "Skills") await showSkillsSettings(orchestrator, ctx);
    else if (choice === "Context") await showContextSettings(orchestrator, ctx);
    else if (choice === "Prompt size") await showPromptcapSettings(orchestrator, ctx);
    else if (choice === "Commands") await showCommandsSettings(orchestrator, ctx);
    else if (choice === "General") await showGeneralSettings(orchestrator, ctx);
    else if (choice === "Performance") await showTimeoutsSettings(orchestrator, ctx);
    else if (choice === "LSP") await showLspSettings(orchestrator, ctx);
  }
}

export async function showPpMenu(orchestrator: Orchestrator, ctx: any): Promise<void> {
  OrchestratorRef.current = orchestrator;
  for (;;) {
    const choice = await selectOption(ctx, "/pp · session control panel", [
      opt("Status", "Model, context, providers, workers, and warnings"),
      opt("Workers", "Inspect or stop bounded background workers"),
      opt("Usage", "Session token usage and cost breakdown"),
      opt("Settings", "Providers, models, agents, and everything else"),
      opt("Report", "Bundle a local feedback report (note + logs)"),
      opt("Doctor", "Run diagnostic checks"),
      opt(CLOSE, "Return to the prompt"),
    ]);
    if (!choice || choice === CLOSE) return;
    if (choice === "Status") ctx.ui?.notify?.(sessionStatus(orchestrator, ctx), "info");
    else if (choice === "Workers") await showWorkers(orchestrator, ctx);
    else if (choice === "Usage") showUsage(ctx);
    else if (choice === "Settings") await showSettings(orchestrator, ctx);
    else if (choice === "Report") await showReportMenu(orchestrator, ctx);
    else if (choice === "Doctor") {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(orchestrator, ctx);
    }
  }
}
