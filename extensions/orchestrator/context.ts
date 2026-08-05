import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RepoInfo } from "./repo-utils.js";
import type { Phase } from "./state.js";
import { getLogger } from "./log.js";
import { isReviewFileForRound } from "./review-files.js";
import { reviewPresetGroupForPhase } from "./config.js";

type AgentType = "main" | "explore" | "librarian" | "planner" | "planReviewer" | "task" | "codeReviewer" | "brainstormReviewer" | "advisor" | "deep-debugger" | "reviewer";
type AgentGroup = "all" | "subagents";
type InjectMode = "system" | "context";
type PhaseFilter = "brainstorm" | "plan" | "implement" | "review";
type VendorFilter = "anthropic" | "openai" | "google" | "unknown";
type FamilyFilter = "opus" | "fable" | "sonnet" | "haiku" | "gpt" | "gpt-mini" | "gemini-pro" | "gemini-flash" | "unknown";
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
const VALID_AGENTS: readonly string[] = ["main", "explore", "librarian", "planner", "planReviewer", "task", "codeReviewer", "brainstormReviewer", "advisor", "deep-debugger", "reviewer"];
const VALID_AGENT_GROUPS: readonly string[] = ["all", "subagents"];
const VALID_PHASES: readonly string[] = ["brainstorm", "plan", "implement", "review"];
const VALID_VENDORS: readonly string[] = ["anthropic", "openai", "google", "unknown"];
const VALID_FAMILIES: readonly string[] = ["opus", "fable", "sonnet", "haiku", "gpt", "gpt-mini", "gemini-pro", "gemini-flash", "unknown"];
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

// Per-artifact and whole-set byte budgets for verbatim injection. A phase can
// legitimately write mechanically-generated artifacts (e.g. raw `git diff -p`
// dumps) that reach multiple MB; injecting those verbatim on every compaction
// overflowed a 1M-token window with ~3.7M tokens of re-injected artifacts. The
// set budget bounds the pathological many-medium-files case too, since the
// per-file cap alone does not.
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const MAX_ARTIFACTS_TOTAL_BYTES = 512 * 1024;

export function getPhaseArtifacts(taskDir: string, phase: Phase): { name: string; content: string; truncated?: boolean }[] {
  // Collected in PRIORITY order, not directory order: the request, research and
  // the synthesized plan claim budget before the generic artifacts/ glob, so a
  // pile of alphabetically-earlier analysis files cannot starve the plan down to
  // a bare truncation marker.
  const planned: { name: string; path: string }[] = [];
  const push = (name: string, path: string) => {
    if (existsSync(path)) planned.push({ name, path });
  };

  push("USER_REQUEST.md", join(taskDir, "USER_REQUEST.md"));
  push("RESEARCH.md", join(taskDir, "RESEARCH.md"));

  if (phase === "plan" || phase === "implement") {
    const plansDir = join(taskDir, "plans");
    if (existsSync(plansDir)) {
      const synthFiles = readdirSync(plansDir)
        .filter((f) => f.includes("synthesized"))
        .sort(sortByTimestampPrefix);
      if (synthFiles.length > 0) {
        push("Synthesized Plan", join(plansDir, synthFiles[synthFiles.length - 1]));
      }
    }
  }

  const artifactsDir = join(taskDir, "artifacts");
  if (existsSync(artifactsDir)) {
    for (const file of readdirSync(artifactsDir).filter((f) => f.endsWith(".md")).sort()) {
      push(`artifacts/${file}`, join(artifactsDir, file));
    }
  }

  const byName = new Map<string, { name: string; content: string; truncated?: boolean }>();
  let remainingBytes = MAX_ARTIFACTS_TOTAL_BYTES;
  for (const { name, path } of planned) {
    const raw = readFileSync(path, "utf-8");
    const bytes = Buffer.from(raw, "utf8");
    const budget = Math.max(0, Math.min(MAX_ARTIFACT_BYTES, remainingBytes));
    // Budget spent: drop the artifact entirely rather than emit a bare marker,
    // whose own bytes would push the set past the cap. The manifest paths the
    // phase panels inject still tell the agent these files exist on disk.
    if (budget === 0) continue;
    if (bytes.length <= budget) {
      remainingBytes -= bytes.length;
      byName.set(name, { name, content: raw });
      continue;
    }
    // Slice on a byte boundary, then drop any trailing partial multibyte char.
    const head = bytes.subarray(0, budget).toString("utf8").replace(/\uFFFD$/, "");
    remainingBytes -= budget;
    const sizeKib = Math.round(bytes.length / 1024);
    byName.set(name, {
      name,
      content: `${head}\n\n[PI-PI: TRUNCATED — ${name} is ${sizeKib} KiB on disk. Read ${path} with the read tool for the full content.]`,
      truncated: true,
    });
  }

  // Emit in the original (caller-facing) order: request, research, artifacts/, plan.
  const order = [
    "USER_REQUEST.md",
    "RESEARCH.md",
    ...planned.filter((p) => p.name.startsWith("artifacts/")).map((p) => p.name),
    "Synthesized Plan",
  ];
  return order.flatMap((name) => {
    const hit = byName.get(name);
    return hit ? [hit] : [];
  });
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

// True when the newest `code-reviews/*_final_pass-*.md` exists and carries an
// `ANCHORS:` block. Shared by publishGuard (Publish menu) and the review-phase
// completion gates so a review cannot finish without the deliverable Publish
// consumes. A zero-findings `ANCHORS: (none)` still satisfies this (the line exists).
export function hasFinalPassAnchors(taskDir: string): boolean {
  const reviewsDir = join(taskDir, "code-reviews");
  if (!existsSync(reviewsDir)) return false;
  const finalPassFiles = readdirSync(reviewsDir)
    .filter((f) => f.endsWith(".md") && f.includes("_final_pass-"))
    .sort();
  if (finalPassFiles.length === 0) return false;
  const latest = finalPassFiles[finalPassFiles.length - 1];
  const content = readFileSync(join(reviewsDir, latest), "utf8");
  return /^ANCHORS:/m.test(content);
}

function getLatestSynthesizedPlanPath(taskDir: string): string | null {
  const plansDir = join(taskDir, "plans");
  if (!existsSync(plansDir)) return null;

  const synthFiles = readdirSync(plansDir)
    .filter((f) => f.includes("synthesized"))
    .sort(sortByTimestampPrefix);
  if (synthFiles.length === 0) return null;

  return join(plansDir, synthFiles[synthFiles.length - 1]);
}

function extractTitle(path: string, fallback: string): string {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^#\s+(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch {
    // fall through to filename fallback
  }
  return fallback;
}

// Path-aware manifest of on-demand task documents (artifacts/*.md + the synthesized
// plan when present) — each entry carries a REAL filesystem path an agent can read.
// Unlike getPhaseArtifacts, the plan is included whenever it exists (not phase-gated),
// so a reviewer spawned in the review phase still gets the plan path.
export function getArtifactManifest(taskDir: string): { title: string; path: string }[] {
  const manifest: { title: string; path: string }[] = [];

  const artifactsDir = join(taskDir, "artifacts");
  if (existsSync(artifactsDir)) {
    for (const file of readdirSync(artifactsDir).filter((f) => f.endsWith(".md")).sort()) {
      const path = join(artifactsDir, file);
      manifest.push({ title: extractTitle(path, `artifacts/${file}`), path });
    }
  }

  const planPath = getLatestSynthesizedPlanPath(taskDir);
  if (planPath) {
    manifest.push({ title: "Synthesized implementation plan", path: planPath });
  }

  return manifest;
}

// Renders a manifest into the trailing prompt block shared by phased panels.
// Replaces the old "Do NOT re-read them from disk" line: USER_REQUEST/RESEARCH
// (and the inlined plan) stay in context, while additional artifacts are offered
// for on-demand reading from disk.
export function formatManifestBlock(manifest: { title: string; path: string }[]): string {
  if (manifest.length === 0) {
    return "The USER REQUEST and RESEARCH above are already in your context. Do NOT re-read them from disk.";
  }
  return [
    "The USER REQUEST and RESEARCH above are already in your context — do NOT re-read them from disk.",
    "Additional analysis artifacts and the plan are listed below; read them from disk with the read tool if relevant:",
    ...manifest.map((m) => `- ${m.path}  — ${m.title}`),
  ].join("\n");
}

export function loadBrainstormReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "brainstorm-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isReviewFileForRound(f, pass))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}

export function loadCodeReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "code-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isReviewFileForRound(f, pass))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}

export function loadPlanReviewOutputs(taskDir: string, pass: number): { name: string; content: string }[] {
  const dir = join(taskDir, "plan-reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isReviewFileForRound(f, pass))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf-8") }));
}

// Single source for phase→review-output loading, mirroring reviewPresetGroupForPhase
// (brainstorm → brainstorm-reviews, plan → plan-reviews, else code-reviews).
// Imported by both the /pp menu and the review-cycle completion path so the two
// cannot drift.
export function loadPhaseReviewOutputs(taskDir: string, phase: string, pass: number): { name: string; content: string }[] {
  const group = reviewPresetGroupForPhase(phase);
  if (group === "brainstormReviewers") return loadBrainstormReviewOutputs(taskDir, pass);
  if (group === "planReviewers") return loadPlanReviewOutputs(taskDir, pass);
  return loadCodeReviewOutputs(taskDir, pass);
}
