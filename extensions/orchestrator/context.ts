import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { Phase } from "./state.js";

type AgentType = "main" | "explore" | "librarian" | "planner" | "planReviewer" | "task" | "codeReviewer";
type AgentGroup = "all" | "subagents";
type InjectMode = "system" | "context";

interface ContextFile {
  mode: InjectMode;
  content: string;
}

interface Frontmatter {
  inject: InjectMode;
  agents: AgentType[];
  agentGroups: AgentGroup[];
}

const VALID_INJECT_MODES: readonly string[] = ["system", "context"];
const VALID_AGENTS: readonly string[] = ["main", "explore", "librarian", "planner", "planReviewer", "task", "codeReviewer"];
const VALID_AGENT_GROUPS: readonly string[] = ["all", "subagents"];

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*\n([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: { inject: "context", agents: ["main"], agentGroups: [] },
      body: raw,
    };
  }

  const yamlBlock = match[1];
  const body = match[2];

  let inject: InjectMode = "context";
  let agents: AgentType[] = [];
  let agentGroups: AgentGroup[] = [];

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
    }
  }

  if (agents.length === 0 && agentGroups.length === 0) {
    agents = ["main"];
  }

  return { frontmatter: { inject, agents, agentGroups }, body };
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

export function loadContextFiles(cwd: string, agentType: AgentType, injectMode?: InjectMode): ContextFile[] {
  const contextDir = join(cwd, ".pp", "context");
  if (!existsSync(contextDir)) return [];

  const results: ContextFile[] = [];
  for (const file of readdirSync(contextDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(contextDir, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err: any) {
      console.error(`[pi-pi] Failed to read context file ${filePath}: ${err.message}`);
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!matchesAgent(frontmatter, agentType)) continue;
    if (injectMode && frontmatter.inject !== injectMode) continue;

    results.push({ mode: frontmatter.inject, content: body.trim() });
  }

  return results;
}

export function loadAgentsMd(cwd: string): string | null {
  const agentsPath = join(cwd, "AGENTS.md");
  if (!existsSync(agentsPath)) return null;
  return readFileSync(agentsPath, "utf-8");
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

export function loadReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const reviewsDir = join(taskDir, "reviews");
  if (!existsSync(reviewsDir)) return [];
  return readdirSync(reviewsDir)
    .filter((f) => f.includes(`round-${pass}`) && f.endsWith(".md"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(reviewsDir, name), "utf-8") }));
}
