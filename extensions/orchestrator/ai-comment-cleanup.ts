import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Orchestrator } from "./orchestrator.js";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const AI_COMMENT_TOKEN = "AI_COMMENT:";

// Remove reviewer→user `AI_COMMENT:` markers from a single file's content.
// - A line whose comment content is ONLY an AI_COMMENT marker is dropped entirely
//   (covers `// AI_COMMENT: ...`, `#`, `--`, `;`, `<!-- ... -->`, `/* ... */`).
// - A code line with a trailing `<comment-open> AI_COMMENT: ...` is stripped back
//   to the code, dropping the trailing marker only.
// Anything else containing the token is left untouched (do not corrupt prose).
// True when `prefix` ends inside an unclosed string literal (single, double, or
// backtick quote). Used to avoid stripping a `// AI_COMMENT:` that lives inside a
// string rather than being a real trailing comment. Escaped quotes are honored.
function insideStringLiteral(prefix: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== null;
}

export function stripAiCommentsFromContent(content: string): { content: string; removed: number } {
  if (!content.includes(AI_COMMENT_TOKEN)) return { content, removed: 0 };
  const lines = content.split("\n");
  const out: string[] = [];
  let removed = 0;

  const fullLineComment = /^\s*(?:\/\/+|#+|--|;+|\/\*|<!--)\s*AI_COMMENT:.*?(?:\*\/|-->)?\s*$/;
  const trailingComment = /(\s*(?:\/\/+|#+|--|;+|\/\*|<!--)\s*AI_COMMENT:.*?(?:\*\/|-->)?)\s*$/;

  for (const line of lines) {
    if (!line.includes(AI_COMMENT_TOKEN)) {
      out.push(line);
      continue;
    }
    if (fullLineComment.test(line)) {
      removed += 1;
      continue;
    }
    const match = trailingComment.exec(line);
    // Only strip a trailing marker when the code BEFORE the comment opener has
    // balanced quotes — otherwise the "// AI_COMMENT:" is inside a string literal
    // (e.g. `const s = "// AI_COMMENT: x"`) and stripping it would corrupt source.
    if (match && !insideStringLiteral(line.slice(0, match.index))) {
      const stripped = line.slice(0, match.index);
      if (stripped.trim().length > 0) {
        out.push(stripped);
        removed += 1;
        continue;
      }
    }
    // Token present but not in a strippable trailing-comment position — leave as-is.
    out.push(line);
  }

  return { content: out.join("\n"), removed };
}

// Strip AI_COMMENT markers from all tracked files in the given repos. Uses
// `git grep` to find candidate files (fast, respects the index / .gitignore).
// Best-effort: errors are swallowed so cleanup never blocks task completion.
export async function stripAiCommentMarkers(
  exec: ExecFn,
  repoPaths: string[],
): Promise<{ filesChanged: number; markersRemoved: number }> {
  let filesChanged = 0;
  let markersRemoved = 0;
  for (const repoPath of repoPaths) {
    let files: string[] = [];
    try {
      const res = await exec("git", ["grep", "-l", "--untracked", "--fixed-strings", AI_COMMENT_TOKEN], { cwd: repoPath, timeout: 15000 });
      if (res.code !== 0) continue;
      files = res.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    } catch {
      continue;
    }
    for (const rel of files) {
      const abs = join(repoPath, rel);
      try {
        const original = readFileSync(abs, "utf-8");
        const { content, removed } = stripAiCommentsFromContent(original);
        if (removed > 0 && content !== original) {
          writeFileSync(abs, content, "utf-8");
          filesChanged += 1;
          markersRemoved += removed;
        }
      } catch {
        // Unreadable/binary file — skip.
      }
    }
  }
  return { filesChanged, markersRemoved };
}

// Safety-net strip run on task completion: removes any AI_COMMENT markers the
// review left behind so none are ever committed/left in the tree. Best-effort and
// only meaningful for review tasks (the only path that inserts the markers).
export async function stripAiCommentMarkersForActiveTask(orchestrator: Orchestrator, ctx: any): Promise<void> {
  const active = orchestrator.active;
  if (!active) return;
  if (active.type !== "review") return;
  const repoPaths = (active.state.repos ?? []).map((r) => r.path);
  if (repoPaths.length === 0) return;
  const exec: ExecFn = (cmd, args, opts) => orchestrator.pi.exec(cmd, args, opts);
  try {
    const { filesChanged, markersRemoved } = await stripAiCommentMarkers(exec, repoPaths);
    if (markersRemoved > 0) {
      ctx?.ui?.notify?.(`Removed ${markersRemoved} leftover AI_COMMENT marker(s) from ${filesChanged} file(s).`, "info");
    }
  } catch {
    // Never block task completion on cleanup.
  }
}
