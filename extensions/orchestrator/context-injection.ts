import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

// Global/ancestor/cwd AGENTS.md + CLAUDE.md injection (item 10). The framework's
// resource-loader.loadContextFileFromDir returns only the FIRST match among
// [AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD] per directory, so it can never
// yield BOTH AGENTS and CLAUDE from one scope. pi-pi therefore needs its own
// enumerator that reads each file type independently across three scopes, gated
// by six toggles (3 scopes × 2 file types).

export type ContextScope = "global" | "ancestor" | "project";
export type ContextFileType = "agents" | "claude";

export interface ContextInjectionToggles {
  globalAgents: boolean;
  globalClaude: boolean;
  ancestorAgents: boolean;
  ancestorClaude: boolean;
  projectAgents: boolean;
  projectClaude: boolean;
}

// Per-file byte cap so injecting large context files can't blow up the prompt.
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

export interface CollectedContextFile {
  scope: ContextScope;
  type: ContextFileType;
  path: string;
  content: string;
  truncated: boolean;
}

const FILE_NAMES: Record<ContextFileType, string[]> = {
  // First existing candidate per type wins (case variants), read INDEPENDENTLY
  // of the other type so a dir with both AGENTS.md and CLAUDE.md yields both.
  agents: ["AGENTS.md", "AGENTS.MD"],
  claude: ["CLAUDE.md", "CLAUDE.MD"],
};

function resolveGlobalAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

// Ancestor directories STRICTLY between the project cwd and the filesystem root
// (excludes cwd itself, which is the "project" scope). Nearest-first is not
// important; we return root→cwd order for stable, readable prompts.
function ancestorDirs(cwd: string): string[] {
  const resolvedCwd = resolve(cwd);
  const dirs: string[] = [];
  let current = dirname(resolvedCwd);
  const root = resolve("/");
  while (true) {
    dirs.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

// Normalize NEWLINES ONLY for content-dedup hashing: convert CRLF and lone CR
// to LF, then strip exactly ONE trailing LF. Interior/other whitespace and
// multiple trailing blank lines are preserved (treated as semantic).
export function normalizeForHash(raw: string): string {
  const lf = raw.replace(/\r\n?/g, "\n");
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf;
}

function contentHash(raw: string): string {
  return createHash("sha256").update(normalizeForHash(raw), "utf8").digest("hex");
}

// Cap by UTF-8 BYTE length (not JS string .length), so non-ASCII markdown is
// measured accurately against MAX_CONTEXT_FILE_BYTES.
function capUtf8(raw: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= MAX_CONTEXT_FILE_BYTES) return { content: raw, truncated: false };
  // Slice on a byte boundary, then drop any trailing partial multibyte char.
  const sliced = bytes.subarray(0, MAX_CONTEXT_FILE_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  return { content: sliced, truncated: true };
}

// Read a file, returning its FULL raw content plus the byte-capped render form.
// The hash is computed over the full content BEFORE the cap so two files that
// share a first 64 KiB but differ afterwards are NOT falsely deduped.
function readCapped(path: string): { content: string; truncated: boolean; hash: string } | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const hash = contentHash(raw);
    const { content, truncated } = capUtf8(raw);
    return { content, truncated, hash };
  } catch {
    return null;
  }
}

// Read the first existing candidate of a file type in a directory.
function readTypeInDir(dir: string, type: ContextFileType): { path: string; content: string; truncated: boolean; hash: string } | null {
  for (const name of FILE_NAMES[type]) {
    const path = join(dir, name);
    const read = readCapped(path);
    if (read) return { path, content: read.content, truncated: read.truncated, hash: read.hash };
  }
  return null;
}

/**
 * Enumerate the enabled context files across the three scopes and two types.
 * Dedupes by resolved path (e.g. an ancestor dir that equals the global agent
 * dir won't be read twice). Order: global → ancestors(root→cwd) → project.
 */
export function collectContextFiles(
  cwd: string,
  toggles: ContextInjectionToggles,
): CollectedContextFile[] {
  const out: CollectedContextFile[] = [];
  const seen = new Set<string>();
  // Content-hash dedup: identical file CONTENT is injected once regardless of
  // path (covers copies, not just symlinks). Collection runs least->most
  // specific (global -> ancestor -> project), so on a content collision the
  // LATER (more-specific) file REPLACES the earlier one.
  const byContent = new Map<string, number>(); // hash -> index in `out`

  const push = (scope: ContextScope, type: ContextFileType, dir: string) => {
    const hit = readTypeInDir(dir, type);
    if (!hit) return;
    const key = resolve(hit.path);
    if (seen.has(key)) return;
    seen.add(key);
    const dupIndex = byContent.get(hit.hash);
    const entry = { scope, type, path: hit.path, content: hit.content, truncated: hit.truncated };
    if (dupIndex !== undefined) {
      // Replace the less-specific duplicate in place (keep ordering position).
      out[dupIndex] = entry;
      return;
    }
    byContent.set(hit.hash, out.length);
    out.push(entry);
  };

  const globalDir = resolveGlobalAgentDir();
  if (toggles.globalAgents) push("global", "agents", globalDir);
  if (toggles.globalClaude) push("global", "claude", globalDir);

  const ancestors = ancestorDirs(cwd);
  for (const dir of ancestors) {
    if (toggles.ancestorAgents) push("ancestor", "agents", dir);
    if (toggles.ancestorClaude) push("ancestor", "claude", dir);
  }

  const projectDir = resolve(cwd);
  if (toggles.projectAgents) push("project", "agents", projectDir);
  if (toggles.projectClaude) push("project", "claude", projectDir);

  return out;
}

/**
 * Render collected files into a single prompt block, or "" when none. Each file
 * is wrapped with its scope/type/source for provenance.
 */
export function renderContextInjection(files: CollectedContextFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map((f) => {
    const trunc = f.truncated ? ' truncated="true"' : "";
    return `<context_file scope="${f.scope}" type="${f.type}" source="${f.path}"${trunc}>\n${f.content}\n</context_file>`;
  });
  return blocks.join("\n\n");
}
