import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type SkillLayer = "project" | "global" | "bundled";

export interface LayeredSkill {
  name: string;
  description: string;
  layer: SkillLayer;
  filePath: string;
  shadows: SkillLayer[];
}

export interface LoadedLayeredSkill extends LayeredSkill {
  document: string;
}

const LAYERS: readonly SkillLayer[] = ["project", "global", "bundled"];
const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("./skills/", import.meta.url));
}

function globalSkillsDir(): string {
  const configured = process.env.PI_SKILLS_DIR;
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/")) return homedir() + configured.slice(1);
  if (configured) return configured;
  return join(homedir(), ".pi", "skills");
}

function layerDir(layer: SkillLayer, cwd: string): string {
  if (layer === "project") return join(cwd, ".pi", "skills");
  if (layer === "global") return globalSkillsDir();
  return bundledSkillsDir();
}

function skillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isFile() && extname(entry).toLowerCase() === ".md") files.push(path);
    if (stat.isDirectory()) {
      const nested = join(path, "SKILL.md");
      if (existsSync(nested)) files.push(nested);
    }
  }
  return files.sort();
}

function readMetadata(filePath: string): { name: string; description: string } | null {
  try {
    const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    const frontmatter = parsed.frontmatter as Record<string, unknown>;
    const fallbackName = basename(filePath, extname(filePath));
    const name = String(frontmatter.name ?? (fallbackName === "SKILL" ? basename(join(filePath, "..")) : fallbackName));
    const description = String(frontmatter.description ?? "").trim();
    if (!VALID_NAME.test(name) || !description) return null;
    return { name, description };
  } catch {
    return null;
  }
}

export function listLayeredSkills(cwd: string): LayeredSkill[] {
  const resolved = new Map<string, LayeredSkill>();
  for (const layer of LAYERS) {
    for (const filePath of skillFiles(layerDir(layer, cwd))) {
      const metadata = readMetadata(filePath);
      if (!metadata) continue;
      const existing = resolved.get(metadata.name);
      if (existing) {
        if (!existing.shadows.includes(layer)) existing.shadows.push(layer);
      } else {
        resolved.set(metadata.name, { ...metadata, layer, filePath, shadows: [] });
      }
    }
  }
  return [...resolved.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveLayeredSkill(name: string, cwd: string): LayeredSkill | undefined {
  return listLayeredSkills(cwd).find((skill) => skill.name === name);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function loadLayeredSkill(name: string, cwd: string): LoadedLayeredSkill {
  const skills = listLayeredSkills(cwd);
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Unknown skill "${name}". Available skills: ${skills.map((candidate) => candidate.name).join(", ") || "<none>"}`);
  const body = parseFrontmatter(readFileSync(skill.filePath, "utf8")).body.trim();
  const document = `<skill name="${escapeAttribute(skill.name)}" source="${skill.layer}">\n${body}\n</skill>`;
  return { ...skill, document };
}
