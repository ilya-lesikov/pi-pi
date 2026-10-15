import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { registerEventHandlers } from "./event-handlers.js";
import { pinnedRoleSpecs } from "./routing.js";
import { initFlantSync, legacyCachePolicy, stripLegacyCachePolicy } from "./flant-infra.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_CONFIG_PATH, mergeConfigLayers, migrateConfigFile, readRawConfig } from "./config.js";
import { getLogger } from "./log.js";
import { suppressPierreThemeSpam } from "./suppress-pierre-theme-spam.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");

export default function (pi: ExtensionAPI) {
  suppressPierreThemeSpam();
  // The host re-runs this factory for every root session (startup and each
  // /new, /resume or fork), so everything below must be safe to repeat.
  const firstActivation = !(globalThis as any)[ORCHESTRATOR_KEY];
  (globalThis as any)[ORCHESTRATOR_KEY] = true;

  // The global config moves onto the providers/models schema here, once, in
  // the root process only; project configs are read migrated in memory and
  // rewritten the first time /pp edits them, so a repo's tracked file is not
  // dirtied by merely opening it. Both steps read config: an unreadable one must
  // not abort the whole load, or pi-pi never registers its handlers and the
  // session has no /pp to fix it.
  try {
    if (firstActivation) {
      migrateConfigFile(GLOBAL_CONFIG_PATH, legacyCachePolicy);
      stripLegacyCachePolicy();
    }
  } catch (error: any) {
    getLogger().error({ s: "config", err: error?.message }, "migrating the global config failed");
  }
  try {
    initFlantSync(pi, undefined, rolePinnedSpecs(process.cwd()));
  } catch (error: any) {
    getLogger().error({ s: "flant", err: error?.message }, "provider initialization from config failed");
  }

  const orchestrator = new Orchestrator(pi);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);
}

// The roles' raw pins, read without creating a project .pp directory: a pinned
// subscription model keeps the subscription registered while the Claude family
// is overridden, from the first registration on.
function rolePinnedSpecs(cwd: string | undefined): string[] {
  try {
    const project = cwd ? join(cwd, ".pp", "config.json") : null;
    return pinnedRoleSpecs(mergeConfigLayers(readRawConfig(GLOBAL_CONFIG_PATH), project && existsSync(project) ? readRawConfig(project) : null));
  } catch {
    return [];
  }
}
