import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { Type } from "@sinclair/typebox";
import type { Orchestrator } from "./orchestrator.js";
import { getLogger } from "./log.js";
import {
  validateArtifact,
  validatePlan,
  validateResearch,
  validateUserRequest,
} from "./validate-artifacts.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
  details: Record<string, never>;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true as const, details: {} };
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(basePath, targetPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Approximate added/removed line counts via an LCS of the line arrays. Good
// enough for a compact "(+N/-M lines)" summary without pulling in a diff lib.
function lineDelta(oldContent: string, newContent: string): { added: number; removed: number } {
  const a = oldContent.length ? oldContent.split(/\r?\n/) : [];
  const b = newContent.length ? newContent.split(/\r?\n/) : [];
  const n = a.length;
  const m = b.length;
  // DP LCS length (rolling rows to keep memory O(m)).
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const curr = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  const lcs = prev[m];
  return { added: m - lcs, removed: n - lcs };
}

// Resolve a caller-supplied path (relative to the active task dir, or absolute)
// and enforce it stays within the active task dir under .pp/state/ and is a .md
// file. Returns the absolute path or an error result.
function resolveStatePath(
  orchestrator: Orchestrator,
  rawPath: string,
): { ok: true; absolute: string; label: string } | { ok: false; result: ToolResult } {
  const active = orchestrator.active;
  if (!active) return { ok: false, result: err("No active task.") };
  const taskDir = resolve(active.dir);
  const input = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!input) return { ok: false, result: err("Missing path.") };

  const absolute = isAbsolute(input) ? resolve(input) : resolve(taskDir, input);

  if (!isPathInside(taskDir, absolute)) {
    return { ok: false, result: err(`Path escapes the active task directory: ${rawPath}`) };
  }
  const ppStateDir = resolve(orchestrator.cwd, ".pp", "state");
  if (!isPathInside(ppStateDir, absolute)) {
    return { ok: false, result: err("State files must live under .pp/state/.") };
  }
  if (!absolute.endsWith(".md")) {
    return { ok: false, result: err("Only .md state files can be edited with this tool.") };
  }
  const label = relative(taskDir, absolute) || relative(orchestrator.cwd, absolute);
  return { ok: true, absolute, label };
}

// Validate structured state files by their role. Unknown .md files under the
// task dir (e.g. reviews/*.md, scratch notes) are allowed without a schema.
function validateStateContent(taskDir: string, absolute: string, content: string):
  | { ok: true }
  | { ok: false; errors: string[]; hint: string } {
  const rel = relative(taskDir, absolute);
  const parts = rel.split(sep);
  const base = parts[parts.length - 1];

  if (rel === "USER_REQUEST.md") {
    const res = validateUserRequest(content);
    return res.ok
      ? { ok: true }
      : { ok: false, errors: res.errors, hint: "Keep exactly: # User Request, ## Problem, ## Constraints. No other sections." };
  }
  if (rel === "RESEARCH.md") {
    const res = validateResearch(content);
    return res.ok
      ? { ok: true }
      : {
          ok: false,
          errors: res.errors,
          hint: "Keep exactly: ## Affected Code, ## Architecture Context, ## Constraints & Edge Cases, ## Open Questions (optional). No other sections.",
        };
  }
  if (parts[0] === "artifacts" && base.endsWith(".md")) {
    const res = validateArtifact(content);
    return res.ok ? { ok: true } : { ok: false, errors: res.errors, hint: "Artifact files must start with # <Title>." };
  }
  if (parts[0] === "plans" && base.endsWith("_synthesized.md")) {
    const res = validatePlan(content);
    return res.ok
      ? { ok: true }
      : { ok: false, errors: res.errors, hint: "Keep exactly: # Plan, ## Scope, ## Checklist (items need 'Done when:'), ## Blockers (optional)." };
  }
  return { ok: true };
}

function validationError(label: string, errors: string[], hint: string): ToolResult {
  return err(
    `${label} structure is invalid:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n${hint}`,
  );
}

// Dedicated compact-output tools for editing .pp state files. Unlike the generic
// write/edit tools (which render the full file content / a unified diff into the
// UI on every update — the "state-file spam"), these return only a one-line
// summary and no details.diff, so the TUI shows nothing large. Structure is
// validated inline (rejecting bad writes up front) instead of via an appended
// <validation-error> round-trip on the generic tools.
export function registerStateFileTools(orchestrator: Orchestrator): void {
  const pi = orchestrator.pi;
  const log = getLogger();

  pi.registerTool({
    name: "pp_write_state_file",
    label: "pi-pi",
    description:
      "Create or overwrite a pi-pi state file (USER_REQUEST.md, RESEARCH.md, artifacts/*.md, " +
      "or plans/*_synthesized.md) under the active task directory. PREFER this over the generic " +
      "write tool for .pp state files: it emits compact output (no full-file echo) and validates " +
      "structure before writing. `path` is relative to the task directory (e.g. \"RESEARCH.md\", " +
      "\"artifacts/design.md\").",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the active task dir (e.g. RESEARCH.md, artifacts/foo.md)" }),
      content: Type.String({ description: "Full new file content" }),
    }),
    async execute(_toolCallId, params: any): Promise<ToolResult> {
      const resolved = resolveStatePath(orchestrator, params?.path);
      if (!resolved.ok) return resolved.result;
      const content = typeof params?.content === "string" ? params.content : "";

      const taskDir = resolve(orchestrator.active!.dir);
      const check = validateStateContent(taskDir, resolved.absolute, content);
      if (!check.ok) return validationError(resolved.label, check.errors, check.hint);

      const existed = existsSync(resolved.absolute);
      const before = existed ? readFileSync(resolved.absolute, "utf-8") : "";
      try {
        mkdirSync(dirname(resolved.absolute), { recursive: true });
        writeFileSync(resolved.absolute, content, "utf-8");
      } catch (e: any) {
        return err(`Failed to write ${resolved.label}: ${e?.message ?? String(e)}`);
      }
      const { added, removed } = lineDelta(before, content);
      log.debug({ s: "tool", tool: "pp_write_state_file", path: resolved.label, added, removed }, "state file written");
      const verb = existed ? "Updated" : "Created";
      return ok(`${verb} ${resolved.label} (+${added}/-${removed} lines)`);
    },
  });

  pi.registerTool({
    name: "pp_edit_state_file",
    label: "pi-pi",
    description:
      "Edit a pi-pi state file in place by replacing an exact text span. PREFER this over the " +
      "generic edit tool for .pp state files (USER_REQUEST.md, RESEARCH.md, artifacts/*.md, " +
      "plans/*_synthesized.md): it emits compact output (no diff) and validates structure before " +
      "writing. `path` is relative to the active task dir. `oldText` must match exactly and be " +
      "unique unless replaceAll is set.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the active task dir (e.g. RESEARCH.md)" }),
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: false — oldText must be unique)" })),
    }),
    async execute(_toolCallId, params: any): Promise<ToolResult> {
      const resolved = resolveStatePath(orchestrator, params?.path);
      if (!resolved.ok) return resolved.result;
      if (!existsSync(resolved.absolute)) {
        return err(`File does not exist: ${resolved.label}. Use pp_write_state_file to create it.`);
      }
      const oldText = typeof params?.oldText === "string" ? params.oldText : "";
      const newText = typeof params?.newText === "string" ? params.newText : "";
      const replaceAll = params?.replaceAll === true;
      if (!oldText) return err("oldText must be a non-empty string.");

      const before = readFileSync(resolved.absolute, "utf-8");
      const occurrences = before.split(oldText).length - 1;
      if (occurrences === 0) return err(`oldText not found in ${resolved.label}.`);
      if (occurrences > 1 && !replaceAll) {
        return err(`oldText matches ${occurrences} locations in ${resolved.label}. Make it unique or set replaceAll.`);
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);

      const taskDir = resolve(orchestrator.active!.dir);
      const check = validateStateContent(taskDir, resolved.absolute, after);
      if (!check.ok) return validationError(resolved.label, check.errors, check.hint);

      try {
        writeFileSync(resolved.absolute, after, "utf-8");
      } catch (e: any) {
        return err(`Failed to write ${resolved.label}: ${e?.message ?? String(e)}`);
      }
      const { added, removed } = lineDelta(before, after);
      log.debug(
        { s: "tool", tool: "pp_edit_state_file", path: resolved.label, occurrences, replaceAll, added, removed },
        "state file edited",
      );
      const scope = replaceAll ? ` (${occurrences}x)` : "";
      return ok(`Updated ${resolved.label}${scope} (+${added}/-${removed} lines)`);
    },
  });
}
