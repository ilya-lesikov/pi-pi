import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { getLogger } from "./log.js";

// Install issue 8b: pi-pi VENDORS several upstream extensions (pi-lsp,
// pi-plannotator, pi-subagents, pi-tasks, pi-ask-user, and the vendored pi-vcc
// engine). If the user ALSO installs any of them STANDALONE, both copies load
// and their tools/commands collide — the framework only prints a non-fatal
// warning ("Tool \"lsp\" conflicts with ..."). This guard HARD-FAILS instead,
// naming the offending extension and which signal tripped, so the user disables
// the standalone copy.
//
// The check runs at session_start (post-bind), NOT at index.ts factory time:
// getAllTools()/getCommands() are only fully populated after the loader binds
// every extension. It mirrors the existing post-bind probe
// `pi.getAllTools().some(t => t.name === "lsp")`.

// Tool/command names pi-pi OWNS via its bundled extensions. A tool with one of
// these names whose source path is OUTSIDE pi-pi's own install tree is a
// standalone duplicate (signal A).
export const PI_PI_OWNED_TOOL_NAMES: readonly string[] = [
  "lsp", // pi-lsp
  "Agent", // pi-subagents
  "ask_user", // pi-ask-user
  "vcc_recall", // vendored pi-vcc
];

export const PI_PI_OWNED_COMMAND_NAMES: readonly string[] = [
  // pi-tasks
  "task", "tasks",
  // pi-plannotator
  "plannotator",
];

// Upstream package ids pi-pi vendors. A loaded extension whose source path
// contains one of these package ids but lives OUTSIDE pi-pi's tree is a
// standalone install of something pi-pi already bundles (signal B).
export const PI_PI_VENDORED_PACKAGE_IDS: readonly string[] = [
  "pi-lsp",
  "pi-plannotator",
  "pi-subagents",
  "pi-tasks",
  "pi-ask-user",
  "@monotykamary/pi-vcc",
  "pi-vcc",
];

// pi-pi's own install root (the dir containing extensions/orchestrator/). Any
// source path under here is pi-pi's OWN bundled copy, never a standalone dupe.
function piPiRoot(): string {
  // this file lives at <root>/extensions/orchestrator/duplicate-extension-guard.ts
  const here = dirname(fileURLToPath(import.meta.url));
  // up two levels: orchestrator -> extensions -> <root>
  return resolve(here, "..", "..");
}

function isUnderPiPi(sourcePath: string | undefined, root: string): boolean {
  if (!sourcePath) return false;
  const resolved = resolve(sourcePath);
  return resolved === root || resolved.startsWith(root + sep);
}

export interface DuplicateFinding {
  offender: string; // the offending extension source path
  signal: "tool-name-collision" | "command-name-collision" | "vendored-package-path";
  detail: string; // human-readable specifics (which name / package id)
}

// Minimal shapes we read from getAllTools()/getCommands().
interface NamedSource {
  name: string;
  sourceInfo?: { path?: string; source?: string };
}

// Pure detector: given the bound tool + command inventories, return every
// standalone-duplicate finding. Exported for testing without a live session.
export function detectDuplicateExtensions(
  tools: NamedSource[],
  commands: NamedSource[],
  rootOverride?: string,
): DuplicateFinding[] {
  const root = rootOverride ? resolve(rootOverride) : piPiRoot();
  const findings: DuplicateFinding[] = [];
  const seen = new Set<string>();

  const ownedTools = new Set(PI_PI_OWNED_TOOL_NAMES);
  const ownedCommands = new Set(PI_PI_OWNED_COMMAND_NAMES);

  const record = (f: DuplicateFinding) => {
    const key = `${f.signal}:${f.detail}:${f.offender}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  // Signal A: a pi-pi-owned tool/command name owned by an extension OUTSIDE
  // pi-pi's tree.
  for (const t of tools) {
    const path = t.sourceInfo?.path;
    if (ownedTools.has(t.name) && !isUnderPiPi(path, root)) {
      record({ offender: path ?? t.sourceInfo?.source ?? "unknown", signal: "tool-name-collision", detail: `tool "${t.name}"` });
    }
  }
  for (const c of commands) {
    const path = c.sourceInfo?.path;
    if (ownedCommands.has(c.name) && !isUnderPiPi(path, root)) {
      record({ offender: path ?? c.sourceInfo?.source ?? "unknown", signal: "command-name-collision", detail: `command "${c.name}"` });
    }
  }

  // Signal B: an extension whose source path references a vendored package id
  // but lives OUTSIDE pi-pi's tree.
  const allSources = [...tools, ...commands];
  for (const item of allSources) {
    const path = item.sourceInfo?.path;
    if (!path || isUnderPiPi(path, root)) continue;
    const resolved = resolve(path);
    for (const pkg of PI_PI_VENDORED_PACKAGE_IDS) {
      // Match the package id as a path segment (…/node_modules/<pkg>/… or
      // …/<pkg>/…) to avoid substring false positives.
      if (resolved.includes(`${sep}${pkg}${sep}`) || resolved.includes(`/${pkg}/`)) {
        record({ offender: resolved, signal: "vendored-package-path", detail: `vendored package "${pkg}"` });
      }
    }
  }

  return findings;
}

export function formatDuplicateFailure(findings: DuplicateFinding[]): string {
  const lines = [
    "pi-pi refuses to operate: a standalone copy of an extension pi-pi already bundles is also installed.",
    "This causes tool/command collisions and unpredictable behavior. Disable or uninstall the standalone copy, then restart.",
    "",
    "Offending extension(s):",
  ];
  for (const f of findings) {
    lines.push(`  • ${f.detail} — ${f.signal} — from: ${f.offender}`);
  }
  return lines.join("\n");
}

// Run the check against the live session and, on a hit, notify + GATE pi-pi so
// it refuses to operate (returns true when a duplicate was found, meaning the
// caller must short-circuit its normal registration/handling). Never throws.
export function checkDuplicateExtensions(pi: any, ctx: any, rootOverride?: string): boolean {
  let tools: NamedSource[] = [];
  let commands: NamedSource[] = [];
  try {
    tools = (pi.getAllTools?.() ?? []) as NamedSource[];
    commands = (pi.getCommands?.() ?? []) as NamedSource[];
  } catch {
    return false;
  }
  const findings = detectDuplicateExtensions(tools, commands, rootOverride);
  if (findings.length === 0) return false;

  const message = formatDuplicateFailure(findings);
  getLogger().error({ s: "duplicate-extension", findings }, "standalone duplicate of a bundled extension detected; refusing to operate");
  try {
    ctx?.ui?.notify?.(message, "error");
  } catch {}
  return true;
}
