import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers, registerLoadSkill, registerSubagentCompaction } from "./event-handlers.js";
import { registerCbmTools } from "./cbm.js";
import { registerExaTools } from "./exa.js";
import { registerAstSearchTool } from "./ast-search.js";
import { initFlantSync, migrateLegacyFlantSettings } from "./flant-infra.js";
import { getDefaultConfig, loadConfig, normalizeConfigDurations } from "./config.js";
import { registerBillingHook } from "./billing-spoof.js";
import { suppressPierreThemeSpam } from "./suppress-pierre-theme-spam.js";
import { registerRecallTool } from "../../3p/pi-vcc/index.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");
const ORCHESTRATOR_CWD_KEY = Symbol.for("pi-pi:orchestrator-cwd");
// Written by 3p/pi-subagents/src/agent-runner.ts for the duration of an
// in-process subagent session's extension load; see the LOCAL PATCH there.
// Shared with 3p/pi-tasks and 3p/pi-lsp, which make the same call.
export function subagentSessionDepth(): number {
  const scope = (globalThis as Record<symbol, any>)[Symbol.for("pi-pi:subagent-session-scope")];
  return scope?.getStore?.()?.depth ?? 0;
}

export default function (pi: ExtensionAPI) {
  suppressPierreThemeSpam();
  if (subagentSessionDepth() > 0) {
    // Child sessions inherit the root project cwd (seeded/refreshed on the root
    // ORCHESTRATOR_CWD_KEY) so project-scoped flant overrides bind; fall back to
    // global-only when no root cwd is known.
    initFlantSync(pi, (globalThis as any)[ORCHESTRATOR_CWD_KEY]);
    // Child sessions never run registerEventHandlers, so without this the
    // root-only billing hook is absent and subagent subscription requests miss
    // the billing system[0] block — the reason switch-back "works" for the main
    // model but not for subagents. Gated to Claude/identity payloads internally.
    registerBillingHook(pi);
    registerSubagentTools(pi);
    return;
  }
  // The host re-runs this factory for every root session (startup and each
  // /new, /resume or fork), so everything below must be safe to repeat.
  const firstActivation = !(globalThis as any)[ORCHESTRATOR_KEY];
  (globalThis as any)[ORCHESTRATOR_KEY] = true;
  (globalThis as any)[ORCHESTRATOR_CWD_KEY] = process.cwd();

  // One-time (root-only) migration of durable flant policy out of the legacy
  // combined cache file into scoped config, before the first settings read.
  if (firstActivation) migrateLegacyFlantSettings();
  initFlantSync(pi);

  const orchestrator = new Orchestrator(pi);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);
}

function registerSubagentTools(pi: ExtensionAPI): void {
  const cwd = (globalThis as any)[ORCHESTRATOR_CWD_KEY] ?? process.cwd();
  const sessionSkills = new Map<string, string>();
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    config = normalizeConfigDurations(getDefaultConfig());
  }
  registerCbmTools(pi, cwd);
  registerExaTools(pi);
  registerAstSearchTool(pi, cwd);
  registerRecallTool(pi, (globalThis as any)[Symbol.for("pi-pi:root-session-source")]);
  registerLoadSkill(pi, cwd, () => config.skills, sessionSkills);
  registerSubagentCompaction(pi, config, sessionSkills);
}
