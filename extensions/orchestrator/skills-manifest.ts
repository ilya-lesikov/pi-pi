import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { getLogger } from "./log.js";

// Skills manifest injection (item 11). pi-pi owns its system prompt, so the
// framework's skill discovery never reaches the agent. This module discovers
// project + global skills and injects a NAME + DESCRIPTION manifest (bodies are
// loaded on demand by the agent via the skill file), gated by two scope toggles
// plus a per-skill enable list.

export interface SkillsConfig {
  loadProject: boolean;
  loadGlobal: boolean;
  /** Skill identifiers (see skillId) explicitly DISABLED by the user. */
  disabled: string[];
}

export interface DiscoveredSkill {
  scope: "project" | "global";
  name: string;
  description: string;
  filePath: string;
  id: string;
}

function resolveGlobalAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

// Stable identifier for a skill (used for per-skill enable/disable). Scope-
// qualified name keeps a project and global skill of the same name distinct.
export function skillId(scope: "project" | "global", name: string): string {
  return `${scope}:${name}`;
}

function loadDir(dir: string, source: string): Skill[] {
  try {
    return loadSkillsFromDir({ dir, source }).skills;
  } catch (err: any) {
    getLogger().debug({ s: "skills", dir, err: err?.message }, "skill discovery failed for dir");
    return [];
  }
}

/**
 * Discover all skills across the enabled scopes (regardless of the per-skill
 * disable list — the "List" submenu needs the full set). Project scope =
 * <cwd>/.pi/skills; global scope = <agentDir>/skills.
 */
export function discoverSkills(cwd: string, config: SkillsConfig): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  if (config.loadProject) {
    for (const s of loadDir(join(cwd, ".pi", "skills"), "project")) {
      out.push({ scope: "project", name: s.name, description: s.description, filePath: s.filePath, id: skillId("project", s.name) });
    }
  }
  if (config.loadGlobal) {
    for (const s of loadDir(join(resolveGlobalAgentDir(), "skills"), "global")) {
      out.push({ scope: "global", name: s.name, description: s.description, filePath: s.filePath, id: skillId("global", s.name) });
    }
  }
  return out;
}

/** The subset of discovered skills that are ENABLED (not in the disable list). */
export function enabledSkills(cwd: string, config: SkillsConfig): DiscoveredSkill[] {
  const disabled = new Set(config.disabled);
  return discoverSkills(cwd, config).filter((s) => !disabled.has(s.id));
}

/**
 * Render the manifest injected into the system prompt: name + description +
 * on-demand path per enabled skill. Bodies are NOT inlined — the agent reads the
 * file when it decides to use a skill. Returns "" when there are none.
 */
export function renderSkillsManifest(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "<skills>",
    "The following skills are available. Each lists a name, what it's for, and a file path.",
    "When a task matches a skill, READ its file for the full instructions before proceeding.",
  ];
  for (const s of skills) {
    lines.push(`- ${s.name} (${s.scope}): ${s.description} [load: ${s.filePath}]`);
  }
  lines.push("</skills>");
  return lines.join("\n");
}
