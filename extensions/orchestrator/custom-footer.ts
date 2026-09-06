import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { UsageTracker } from "./usage-tracker.js";
import type { Orchestrator } from "./orchestrator.js";

// Resolve the pi-pi package version once at module load. ESM-safe: resolve
// package.json relative to this module's URL (never __dirname or a fixed
// install-dir depth). Degrade to "?" if the read/parse fails.
export function resolvePackageVersion(packageUrl: URL = new URL("../../package.json", import.meta.url)): string {
  try {
    const raw = readFileSync(packageUrl, "utf8");
    const version = JSON.parse(raw)?.version;
    return typeof version === "string" && version ? version : "?";
  } catch {
    return "?";
  }
}

const PP_VERSION = resolvePackageVersion();
const BRANCH_REFRESH_MS = 5000;

let footerCtx: ExtensionContext | undefined;
let footerTracker: UsageTracker | undefined;
let footerOrchestrator: Orchestrator | undefined;

export function setFooterContext(ctx: ExtensionContext): void {
  footerCtx = ctx;
}

export function setFooterTracker(tracker: UsageTracker): void {
  footerTracker = tracker;
}

export function setFooterOrchestrator(orchestrator: Orchestrator): void {
  footerOrchestrator = orchestrator;
}

// The host caches its branch behind an fs.watch on .git/HEAD, which silently
// misses updates under inotify pressure or on network/container filesystems, so
// pi-pi reads HEAD itself. This must stay synchronous and filesystem-only: it
// runs from the TUI render path, where a subprocess would block every frame.
// The `.invalid` -> git symbolic-ref fallback therefore lives in the async
// refresh, which reaches it via the "detached" result below.
export function resolveGitBranchSync(cwd: string = footerCtx?.cwd ?? process.cwd()): string | null {
  try {
    let headPath = "";
    for (let dir = cwd; !headPath; ) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) {
          headPath = join(gitPath, "HEAD");
        } else if (stat.isFile()) {
          const pointer = readFileSync(gitPath, "utf8").trim();
          if (!pointer.startsWith("gitdir: ")) return null;
          headPath = join(resolvePath(dir, pointer.slice(8).trim()), "HEAD");
        } else {
          return null;
        }
        if (!existsSync(headPath)) return null;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    const content = readFileSync(headPath, "utf8").trim();
    if (!content.startsWith("ref: refs/heads/")) return "detached";
    const branch = content.slice(16);
    return branch === ".invalid" ? "detached" : branch;
  } catch {
    return null;
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatPath(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function toThinkingLevel(ctx: ExtensionContext | undefined): string {
  if (!ctx) return "off";
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      return entry.thinkingLevel;
    }
  }
  return "off";
}

function toContextUsagePart(ctx: ExtensionContext | undefined, theme: Theme): string {
  const usage = ctx?.getContextUsage();
  const contextWindow = usage?.contextWindow ?? 0;
  const percentValue = usage?.percent ?? null;
  const tokensValue = usage?.tokens ?? null;
  const percentText = percentValue === null ? "?" : percentValue.toFixed(1);
  const tokensText = tokensValue === null ? "?" : formatTokens(tokensValue);
  const display = `${percentText}%/${tokensText}/${formatTokens(contextWindow)} (auto)`;
  if (percentValue !== null && percentValue > 90) return theme.fg("error", display);
  if (percentValue !== null && percentValue > 70) return theme.fg("warning", display);
  return display;
}

function renderStatsLine(width: number, theme: Theme): string {
  const ctx = footerCtx;
  const tracker = footerTracker;

  // ↑ is the total input the model actually processed (uncached + cache read +
  // cache write) across main + subagents — not just the tiny uncached sliver.
  const inputTokens = tracker?.getTotalProcessedInputTokens() ?? 0;
  const outputTokens = tracker?.getTotalOutputTokens() ?? 0;
  const cacheRate = tracker?.getCacheHitRate() ?? 0;
  const totalCost = tracker?.getTotalCost() ?? 0;

  const cacheSupported = tracker?.isCacheSupported() ?? false;
  const leftParts: string[] = [`↑${formatTokens(inputTokens)}`, `↓${formatTokens(outputTokens)}`];
  if (cacheSupported) leftParts.push(`⚡${Math.round(cacheRate * 100)}%`);
  // Always show cost, even $0.00 (subscription/flat-rate sessions).
  leftParts.push(`$${totalCost.toFixed(2)}`);
  leftParts.push(toContextUsagePart(ctx, theme));
  let left = leftParts.join(" ");

  const modelId = ctx?.model?.id ?? "no-model";
  const provider = ctx?.model?.provider ?? "unknown";
  const thinkingLevel = toThinkingLevel(ctx);
  let right = `(${provider}) ${modelId} • ${thinkingLevel}`;

  let leftWidth = visibleWidth(left);
  if (leftWidth > width) {
    left = truncateToWidth(left, width, "...");
    leftWidth = visibleWidth(left);
    right = "";
  }

  const minPadding = 2;
  const rightWidth = visibleWidth(right);
  const totalNeeded = leftWidth + minPadding + rightWidth;
  let fullLine: string;

  if (right && totalNeeded <= width) {
    const padding = " ".repeat(width - leftWidth - rightWidth);
    fullLine = left + padding + right;
  } else if (right) {
    const availableRight = width - leftWidth - minPadding;
    if (availableRight > 0) {
      const truncatedRight = truncateToWidth(right, availableRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      const padding = " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth));
      fullLine = left + padding + truncatedRight;
    } else {
      fullLine = left;
    }
  } else {
    fullLine = left;
  }

  const remainder = fullLine.slice(left.length);
  return theme.fg("dim", left) + theme.fg("dim", remainder);
}

function renderPathLine(width: number, theme: Theme, branch: string | null): string {
  const ctx = footerCtx;
  const path = formatPath(ctx?.cwd ?? process.cwd());

  let line = path;
  if (branch) line += ` (${branch})`;

  const sessionName = ctx?.sessionManager.getSessionName();
  if (sessionName) line += ` • ${sessionName}`;

  line += ` • pp v${PP_VERSION}`;

  return truncateToWidth(theme.fg("dim", line), width, theme.fg("dim", "..."));
}

export function createCustomFooter(
  tui: TUI,
  theme: Theme,
  _footerData: ReadonlyFooterDataProvider,
  resolveBranch: (cwd?: string) => string | null = resolveGitBranchSync,
): Component & { dispose?(): void } {
  let branch = resolveBranch();
  let disposed = false;
  let confirming = false;
  let detachedConfirmed = false;

  const apply = (next: string | null): void => {
    if (disposed || next === branch) return;
    branch = next;
    tui.requestRender();
  };

  // The timer belongs to this closure, not module scope: pi-pi re-registers the
  // footer on every session_start and the host only ever calls dispose() on the
  // component it is replacing.
  const timer = setInterval(() => {
    const next = resolveBranch();
    // "detached" is also what the sync read yields for a `.invalid` HEAD ref,
    // which only git itself can resolve — so ask git, but only once per entry
    // into that state, and only here where blocking the render path is moot.
    if (next === "detached") {
      if (confirming || detachedConfirmed) return;
      confirming = true;
      detachedConfirmed = true;
      execFile(
        "git",
        ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd: footerCtx?.cwd ?? process.cwd(), encoding: "utf8" },
        (error, stdout) => {
          confirming = false;
          apply(error ? "detached" : stdout.trim() || "detached");
        },
      );
      return;
    }
    detachedConfirmed = false;
    apply(next);
  }, BRANCH_REFRESH_MS);

  return {
    render(width: number): string[] {
      const line1 = renderPathLine(width, theme, branch);
      const line2 = renderStatsLine(width, theme);
      return [line1, line2];
    },
    invalidate(): void {},
    dispose(): void {
      disposed = true;
      clearInterval(timer);
    },
  };
}
