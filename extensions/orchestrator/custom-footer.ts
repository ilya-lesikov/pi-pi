import { homedir } from "node:os";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { UsageTracker } from "./usage-tracker.js";

let footerCtx: ExtensionContext | undefined;
let footerTracker: UsageTracker | undefined;

export function setFooterContext(ctx: ExtensionContext): void {
  footerCtx = ctx;
}

export function setFooterTracker(tracker: UsageTracker): void {
  footerTracker = tracker;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
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
  const percentText = percentValue === null ? "?" : percentValue.toFixed(1);
  const display = `${percentText}%/${formatTokens(contextWindow)} (auto)`;
  if (percentValue !== null && percentValue > 90) return theme.fg("error", display);
  if (percentValue !== null && percentValue > 70) return theme.fg("warning", display);
  return display;
}

function renderStatsLine(width: number, theme: Theme): string {
  const ctx = footerCtx;
  const tracker = footerTracker;

  const inputTokens = tracker?.getTotalInputTokens() ?? 0;
  const outputTokens = tracker?.getTotalOutputTokens() ?? 0;
  const cacheRate = tracker?.getCacheHitRate() ?? 0;
  const totalCost = tracker?.getTotalCost() ?? 0;

  const cacheSupported = tracker?.isCacheSupported() ?? false;
  const leftParts: string[] = [`↑${formatTokens(inputTokens)}`, `↓${formatTokens(outputTokens)}`];
  if (cacheSupported) leftParts.push(`⚡${Math.round(cacheRate * 100)}%`);
  if (totalCost > 0) leftParts.push(`$${totalCost.toFixed(2)}`);
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

function renderPathLine(width: number, theme: Theme, footerData: ReadonlyFooterDataProvider): string {
  const ctx = footerCtx;
  const path = formatPath(ctx?.cwd ?? process.cwd());
  const branch = footerData.getGitBranch();
  const sessionName = ctx?.sessionManager.getSessionName();

  let line = path;
  if (branch) line += ` (${branch})`;
  if (sessionName) line += ` • ${sessionName}`;

  return truncateToWidth(theme.fg("dim", line), width, theme.fg("dim", "..."));
}

function renderStatusLine(width: number, theme: Theme, footerData: ReadonlyFooterDataProvider): string | undefined {
  const statuses = footerData.getExtensionStatuses();
  if (statuses.size === 0) return undefined;

  const line = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .join(" ");

  return truncateToWidth(theme.fg("dim", line), width, theme.fg("dim", "..."));
}

export function createCustomFooter(_tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } {
  return {
    render(width: number): string[] {
      const line1 = renderPathLine(width, theme, footerData);
      const line2 = renderStatsLine(width, theme);
      const line3 = renderStatusLine(width, theme, footerData) ?? theme.fg("dim", "");
      return [line1, line2, line3];
    },
    invalidate(): void {},
    dispose(): void {},
  };
}
