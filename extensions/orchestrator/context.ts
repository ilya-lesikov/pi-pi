import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RepoInfo } from "./repo-utils.js";
import type { Phase } from "./state.js";
import { getLogger } from "./log.js";

type AgentType = "main" | "explore" | "librarian" | "planner" | "planReviewer" | "task" | "codeReviewer" | "brainstormReviewer";
type AgentGroup = "all" | "subagents";
type InjectMode = "system" | "context";
type PhaseFilter = "brainstorm" | "debug" | "plan" | "implement" | "review";
type VendorFilter = "anthropic" | "openai" | "google" | "unknown";
type FamilyFilter = "opus" | "sonnet" | "haiku" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "unknown";
type TierFilter = "stupid" | "regular" | "smart" | "xsmart" | "unknown";
type ModelInfo = { vendor: string; family: string; tier: string };

interface ContextFile {
  mode: InjectMode;
  content: string;
}

interface Frontmatter {
  inject: InjectMode;
  agents: AgentType[];
  agentGroups: AgentGroup[];
  phases: PhaseFilter[];
  vendors: VendorFilter[];
  families: FamilyFilter[];
  tiers: TierFilter[];
}

const VALID_INJECT_MODES: readonly string[] = ["system", "context"];
const VALID_AGENTS: readonly string[] = ["main", "explore", "librarian", "planner", "planReviewer", "task", "codeReviewer", "brainstormReviewer"];
const VALID_AGENT_GROUPS: readonly string[] = ["all", "subagents"];
const VALID_PHASES: readonly string[] = ["brainstorm", "debug", "plan", "implement", "review"];
const VALID_VENDORS: readonly string[] = ["anthropic", "openai", "google", "unknown"];
const VALID_FAMILIES: readonly string[] = ["opus", "sonnet", "haiku", "gpt", "gpt-mini", "gemini-pro", "gemini-flash", "unknown"];
const VALID_TIERS: readonly string[] = ["stupid", "regular", "smart", "xsmart", "unknown"];

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*\n([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {
        inject: "context",
        agents: ["main"],
        agentGroups: [],
        phases: [],
        vendors: [],
        families: [],
        tiers: [],
      },
      body: raw,
    };
  }

  const yamlBlock = match[1];
  const body = match[2];

  let inject: InjectMode = "context";
  let agents: AgentType[] = [];
  let agentGroups: AgentGroup[] = [];
  let phases: PhaseFilter[] = [];
  let vendors: VendorFilter[] = [];
  let families: FamilyFilter[] = [];
  let tiers: TierFilter[] = [];

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (key === "inject") {
      const cleaned = stripQuotes(val);
      if (VALID_INJECT_MODES.includes(cleaned)) {
        inject = cleaned as InjectMode;
      }
    } else if (key === "agents") {
      agents = parseArray(val).filter((v): v is AgentType => VALID_AGENTS.includes(v));
    } else if (key === "agentGroups") {
      agentGroups = parseArray(val).filter((v): v is AgentGroup => VALID_AGENT_GROUPS.includes(v));
    } else if (key === "phases") {
      phases = parseArray(val).filter((v): v is PhaseFilter => VALID_PHASES.includes(v));
    } else if (key === "vendors") {
      vendors = parseArray(val).filter((v): v is VendorFilter => VALID_VENDORS.includes(v));
    } else if (key === "families") {
      families = parseArray(val).filter((v): v is FamilyFilter => VALID_FAMILIES.includes(v));
    } else if (key === "tiers") {
      tiers = parseArray(val).filter((v): v is TierFilter => VALID_TIERS.includes(v));
    }
  }

  if (agents.length === 0 && agentGroups.length === 0) {
    agents = ["main"];
  }

  return {
    frontmatter: { inject, agents, agentGroups, phases, vendors, families, tiers },
    body,
  };
}

function stripQuotes(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseArray(val: string): string[] {
  const trimmed = val.trim();
  if (trimmed.startsWith("[")) {
    const closingIdx = trimmed.lastIndexOf("]");
    const inner = closingIdx > 0 ? trimmed.slice(1, closingIdx) : trimmed.slice(1);
    return inner
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  return [stripQuotes(trimmed)];
}

function sortByTimestampPrefix(a: string, b: string): number {
  const aNum = parseInt(a, 10);
  const bNum = parseInt(b, 10);
  if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
  return a.localeCompare(b);
}

function matchesAgent(fm: Frontmatter, agentType: AgentType): boolean {
  if (fm.agentGroups.includes("all")) return true;
  if (fm.agentGroups.includes("subagents") && agentType !== "main") return true;
  return fm.agents.includes(agentType);
}

function matchesFilters(
  fm: Frontmatter,
  agentType: AgentType,
  phase?: string,
  modelInfo?: ModelInfo,
): boolean {
  if (!matchesAgent(fm, agentType)) return false;
  if (fm.phases.length > 0 && phase && !fm.phases.includes(phase as PhaseFilter)) return false;
  if (modelInfo) {
    if (fm.vendors.length > 0 && !fm.vendors.includes(modelInfo.vendor as VendorFilter)) return false;
    if (fm.families.length > 0 && !fm.families.includes(modelInfo.family as FamilyFilter)) return false;
    if (fm.tiers.length > 0 && !fm.tiers.includes(modelInfo.tier as TierFilter)) return false;
  }
  return true;
}

export function loadContextFiles(
  cwd: string,
  agentType: AgentType,
  injectMode?: InjectMode,
  phase?: string,
  modelInfo?: ModelInfo,
): ContextFile[] {
  return loadContextFilesFromDir(join(cwd, ".pp", "context"), agentType, injectMode, phase, modelInfo);
}

export function loadContextFilesFromDir(
  contextDir: string,
  agentType: AgentType,
  injectMode?: InjectMode,
  phase?: string,
  modelInfo?: ModelInfo,
): ContextFile[] {
  if (!existsSync(contextDir)) return [];

  const results: ContextFile[] = [];
  for (const file of readdirSync(contextDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(contextDir, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err: any) {
      getLogger().warn({ s: "context", filePath, err: err.message }, "failed to read context file");
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!matchesFilters(frontmatter, agentType, phase, modelInfo)) continue;
    if (injectMode && frontmatter.inject !== injectMode) continue;

    results.push({ mode: frontmatter.inject, content: body.trim() });
  }

  return results;
}

export function loadAllContextFiles(
  contextDirs: string[],
  agentType: AgentType,
  injectMode?: InjectMode,
  phase?: string,
  modelInfo?: ModelInfo,
): ContextFile[] {
  const results: ContextFile[] = [];
  for (const contextDir of contextDirs) {
    results.push(...loadContextFilesFromDir(contextDir, agentType, injectMode, phase, modelInfo));
  }
  getLogger().debug({ s: "context", agentType, injectMode, phase, dirs: contextDirs.length, files: results.length }, "loaded context files");
  return results;
}

export function getContextDirs(rootCwd: string, repos: RepoInfo[], loadExtraRepoConfigs: boolean): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (!existsSync(dir) || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  add(join(getAgentDir(), "extensions", "pp", "context"));
  add(join(rootCwd, ".pp", "context"));

  if (loadExtraRepoConfigs) {
    for (const repo of repos) {
      if (repo.isRoot) continue;
      add(join(repo.path, ".pp", "context"));
    }
  }

  return dirs;
}

export function getPhaseArtifacts(taskDir: string, phase: Phase): { name: string; content: string }[] {
  const artifacts: { name: string; content: string }[] = [];

  const tryAdd = (name: string, path: string) => {
    if (existsSync(path)) {
      artifacts.push({ name, content: readFileSync(path, "utf-8") });
    }
  };

  tryAdd("USER_REQUEST.md", join(taskDir, "USER_REQUEST.md"));
  tryAdd("RESEARCH.md", join(taskDir, "RESEARCH.md"));

  const artifactsDir = join(taskDir, "artifacts");
  if (existsSync(artifactsDir)) {
    for (const file of readdirSync(artifactsDir).filter((f) => f.endsWith(".md")).sort()) {
      tryAdd(`artifacts/${file}`, join(artifactsDir, file));
    }
  }

  if (phase === "plan" || phase === "implement") {
    const plansDir = join(taskDir, "plans");
    if (existsSync(plansDir)) {
      const synthFiles = readdirSync(plansDir)
        .filter((f) => f.includes("synthesized"))
        .sort(sortByTimestampPrefix);
      if (synthFiles.length > 0) {
        const synthPath = join(plansDir, synthFiles[synthFiles.length - 1]);
        tryAdd("Synthesized Plan", synthPath);
      }
    }
  }

  return artifacts;
}

export function getLatestSynthesizedPlan(taskDir: string): string | null {
  const plansDir = join(taskDir, "plans");
  if (!existsSync(plansDir)) return null;

  const synthFiles = readdirSync(plansDir)
    .filter((f) => f.includes("synthesized"))
    .sort(sortByTimestampPrefix);
  if (synthFiles.length === 0) return null;

  return readFileSync(join(plansDir, synthFiles[synthFiles.length - 1]), "utf-8");
}

export function loadBrainstormReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "brainstorm-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.includes(`round-${pass}`) && f.endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}

export function loadCodeReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "code-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.includes(`round-${pass}`) && f.endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}

export function loadPlanReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "plan-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.includes(`round-${pass}`) && f.endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}
