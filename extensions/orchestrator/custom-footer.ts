import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { UsageTracker } from "./usage-tracker.js";
import type { MainStatus, MainStatusTracker } from "./main-status.js";
import { formatDuration } from "./workers/delivery.js";
import type { Orchestrator } from "./orchestrator.js";
import { LLM_API_PROVIDER, concreteProviderLabel } from "./routing.js";

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
let footerStatus: MainStatusTracker | undefined;
/** Statuses pi-pi sets for other apps; its own footer shows the same thing elsewhere. */
const OWN_STATUS_KEYS: ReadonlySet<string> = new Set(["workers"]);

export function setFooterContext(ctx: ExtensionContext): void {
  footerCtx = ctx;
}

export function setFooterTracker(tracker: UsageTracker): void {
  footerTracker = tracker;
}

export function setFooterOrchestrator(orchestrator: Orchestrator): void {
  footerOrchestrator = orchestrator;
}

export function setFooterStatus(tracker: MainStatusTracker): void {
  footerStatus = tracker;
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
  // Per-token billing is the one routing outcome worth seeing at a glance:
  // automatic fallback can land there without asking.
  const paid = provider === LLM_API_PROVIDER ? " [paid]" : "";
  let right = `(${concreteProviderLabel(provider)}) ${modelId}${paid} • ${thinkingLevel} • pp v${PP_VERSION}`;

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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_COLOR = { normal: "accent", attention: "warning", alarm: "error", idle: "dim" } as const;

function statusText(status: MainStatus, frame: number, now: number): { glyph: string; body: string; tail: string } {
  const glyph = status.level === "idle" ? "" : status.level === "attention" ? "?" : status.level === "alarm" ? "!" : SPINNER[frame % SPINNER.length]!;
  const elapsed = status.level === "idle" ? "" : formatDuration(now - status.since);
  const tail = [elapsed, status.suffix].filter(Boolean).join(" • ");
  return { glyph, body: status.text, tail };
}

/**
 * Line one: what the main agent is doing on the left, the directory (and
 * branch, session name) on the right. When they do not fit, the directory
 * shortens first, then the status text; never the status's time.
 */
function renderStatusLine(width: number, theme: Theme, branch: string | null, frame: number, now: number): string {
  const ctx = footerCtx;
  const sessionName = ctx?.sessionManager.getSessionName();
  const suffix = `${branch ? ` (${branch})` : ""}${sessionName ? ` • ${sessionName}` : ""}`;
  const fullPath = formatPath(ctx?.cwd ?? process.cwd());
  const status = footerStatus?.current();
  const parts = status ? statusText(status, frame, now) : { glyph: "", body: "", tail: "" };
  const color = status ? STATUS_COLOR[status.level] : "dim";
  const head = parts.glyph ? `${parts.glyph} ` : "";
  const tail = parts.tail ? ` • ${parts.tail}` : "";
  const fixed = visibleWidth(head) + visibleWidth(tail);
  const minGap = 2;
  const pathCandidates = [fullPath, shortenPath(fullPath), fullPath.split("/").filter(Boolean).at(-1) ?? fullPath];
  let right = "";
  let body = parts.body;
  for (const candidate of pathCandidates) {
    const text = `${candidate}${suffix}`;
    if (fixed + visibleWidth(body) + minGap + visibleWidth(text) <= width) {
      right = text;
      break;
    }
  }
  if (!right) {
    right = `${pathCandidates.at(-1)}${suffix}`;
    const room = width - fixed - minGap - visibleWidth(right);
    if (room < 8) right = "";
    body = truncateToWidth(body, Math.max(1, width - fixed - (right ? minGap + visibleWidth(right) : 0)), "…");
  }
  const left = parts.body || parts.glyph ? `${head}${body}${tail}` : "";
  const gap = Math.max(right ? minGap : 0, width - visibleWidth(left) - visibleWidth(right));
  const line = `${theme.fg(color, left)}${" ".repeat(gap)}${theme.fg("dim", right)}`;
  return truncateToWidth(line, width, "");
}

/** ~/git/github.com/org/repo → ~/git/…/org/repo */
function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 4) return path;
  return [parts[0], parts[1], "…", ...parts.slice(-2)].join("/");
}

/** Line three: statuses other extensions set, shown only when there are any. */
function renderExtensionStatuses(width: number, theme: Theme, footerData: ReadonlyFooterDataProvider | undefined): string | undefined {
  const statuses = footerData?.getExtensionStatuses?.();
  if (!statuses?.size) return undefined;
  const texts = [...statuses.entries()].filter(([key, text]) => !OWN_STATUS_KEYS.has(key) && text?.trim()).map(([, text]) => text.replace(/\s+/g, " ").trim());
  if (!texts.length) return undefined;
  return truncateToWidth(theme.fg("dim", texts.join(" • ")), width, theme.fg("dim", "…"));
}

export function createCustomFooter(
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  resolveBranch: (cwd?: string) => string | null = resolveGitBranchSync,
): Component & { dispose?(): void } {
  let branch = resolveBranch();
  let disposed = false;
  let frame = 0;
  // The status line animates and counts seconds; it only needs that while busy.
  // Idle still counts "done … ago", but only needs a repaint every few seconds.
  let idleTicks = 0;
  const ticker = setInterval(() => {
    if (disposed || !footerStatus) return;
    if (footerStatus.current().level === "idle") {
      if (++idleTicks % 25 !== 0) return;
    } else {
      idleTicks = 0;
      frame++;
    }
    tui.requestRender();
  }, 200);
  ticker.unref?.();
  footerStatus?.subscribe(() => { if (!disposed) tui.requestRender(); });
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
      const lines = [renderStatusLine(width, theme, branch, frame, footerStatus?.clock() ?? Date.now()), renderStatsLine(width, theme)];
      const extra = renderExtensionStatuses(width, theme, footerData);
      if (extra) lines.push(extra);
      return lines;
    },
    invalidate(): void {},
    dispose(): void {
      disposed = true;
      clearInterval(timer);
      clearInterval(ticker);
    },
  };
}
