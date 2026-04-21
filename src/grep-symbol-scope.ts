import { buildPtcLine } from "./ptc-value.js";
import type { GrepOutputEntry, GrepOutputGroup, GrepOutputScopeSymbol, GrepScopeWarning } from "./grep-output.js";
import type { FileMap, FileSymbol } from "./readmap/types.js";

interface FlatSymbol extends GrepOutputScopeSymbol {
  rangeSize: number;
}

function flattenSymbols(symbols: FileSymbol[], parentName?: string): FlatSymbol[] {
  const flattened: FlatSymbol[] = [];
  for (const symbol of symbols) {
    flattened.push({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      parentName,
      rangeSize: symbol.endLine - symbol.startLine,
    });
    if (symbol.children?.length) flattened.push(...flattenSymbols(symbol.children, symbol.name));
  }
  return flattened;
}

function findEnclosingSymbol(map: FileMap, lineNumber: number): GrepOutputScopeSymbol | null {
  const candidates = flattenSymbols(map.symbols)
    .filter((s) => lineNumber >= s.startLine && lineNumber <= s.endLine)
    .sort((a, b) => {
      if (a.rangeSize !== b.rangeSize) return a.rangeSize - b.rangeSize;
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.name.localeCompare(b.name);
    });
  if (!candidates.length) return null;
  const { rangeSize: _rangeSize, ...symbol } = candidates[0];
  return symbol;
}

function firstLineNumber(group: GrepOutputGroup): number {
  const first = group.entries.find((e) => e.kind !== "separator");
  return first ? first.line.line : Number.MAX_SAFE_INTEGER;
}

function buildSymbolEntries(
  fileLines: string[],
  symbol: GrepOutputScopeSymbol,
  matchLines: Set<number>,
  scopeContext: number | undefined,
): GrepOutputEntry[] {
  if (scopeContext === undefined) {
    const entries: GrepOutputEntry[] = [];
    for (let lineNumber = symbol.startLine; lineNumber <= symbol.endLine; lineNumber++) {
      const built = buildPtcLine(lineNumber, fileLines[lineNumber - 1] ?? "");
      entries.push({ kind: matchLines.has(lineNumber) ? "match" : "context", line: built });
    }
    return entries;
  }
  // Windowed path: ±scopeContext lines, clipped, merged, with '--' separators between non-overlapping ranges.
  const ranges = [...matchLines].sort((a, b) => a - b).map((ln) => ({
    startLine: Math.max(symbol.startLine, ln - scopeContext),
    endLine: Math.min(symbol.endLine, ln + scopeContext),
  }));
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, r.endLine);
    } else {
      merged.push({ ...r });
    }
  }
  const entries: GrepOutputEntry[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (i > 0) entries.push({ kind: "separator", text: "--" });
    const range = merged[i];
    for (let ln = range.startLine; ln <= range.endLine; ln++) {
      const built = buildPtcLine(ln, fileLines[ln - 1] ?? "");
      entries.push({ kind: matchLines.has(ln) ? "match" : "context", line: built });
    }
  }
  return entries;
}

function buildFallbackEntries(fileLines: string[], matchLines: number[], contextLines: number): GrepOutputEntry[] {
  const lineMap = new Map<number, GrepOutputEntry>();
  for (const matchLine of matchLines) {
    const start = Math.max(1, matchLine - contextLines);
    const end = Math.min(fileLines.length, matchLine + contextLines);
    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
      const built = buildPtcLine(lineNumber, fileLines[lineNumber - 1] ?? "");
      const candidate: GrepOutputEntry = { kind: lineNumber === matchLine ? "match" : "context", line: built };
      const existing = lineMap.get(lineNumber);
      if (!existing || (existing.kind === "context" && candidate.kind === "match")) {
        lineMap.set(lineNumber, candidate);
      }
    }
  }
  const ordered = [...lineMap.entries()].sort(([a], [b]) => a - b);
  const entries: GrepOutputEntry[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0 && ordered[i][0] > ordered[i - 1][0] + 1) entries.push({ kind: "separator", text: "--" });
    entries.push(ordered[i][1]);
  }
  return entries;
}

export function scopeGrepGroupsToSymbols(input: {
  groups: GrepOutputGroup[];
  fileLinesByPath: Map<string, string[]>;
  fileMapsByPath: Map<string, FileMap | null>;
  contextLines: number;
  scopeContext?: number;
}): { groups: GrepOutputGroup[]; warnings: GrepScopeWarning[] } {
  const warnings: GrepScopeWarning[] = [];
  const rendered: Array<{ order: number; group: GrepOutputGroup }> = [];

  for (const group of input.groups) {
    const fileLines = input.fileLinesByPath.get(group.absolutePath);
    const fileMap = input.fileMapsByPath.get(group.absolutePath) ?? null;

    if (!fileLines || !fileMap) {
      warnings.push({
        code: "unmappable-file",
        message: `[Warning: symbol scoping unavailable for ${group.absolutePath} — showing normal grep lines for this file]`,
        path: group.absolutePath,
      });
      rendered.push({ order: firstLineNumber(group), group });
      continue;
    }

    const symbolBuckets = new Map<string, { symbol: GrepOutputScopeSymbol; matchLines: Set<number> }>();
    const fallbackMatchLines: number[] = [];

    for (const entry of group.entries) {
      if (entry.kind !== "match") continue;
      const symbol = findEnclosingSymbol(fileMap, entry.line.line);
      if (!symbol) {
        fallbackMatchLines.push(entry.line.line);
        warnings.push({
          code: "no-enclosing-symbol",
          message: `[Warning: no enclosing symbol for ${group.absolutePath}:${entry.line.line} — showing normal grep lines for this match]`,
          path: group.absolutePath,
          line: entry.line.line,
        });
        continue;
      }

      const key = `${symbol.startLine}:${symbol.endLine}:${symbol.parentName ?? ""}:${symbol.name}`;
      const bucket = symbolBuckets.get(key) ?? { symbol, matchLines: new Set<number>() };
      bucket.matchLines.add(entry.line.line);
      symbolBuckets.set(key, bucket);
    }

    const scopedGroups = [...symbolBuckets.values()]
      .sort((a, b) => {
        if (a.symbol.startLine !== b.symbol.startLine) return a.symbol.startLine - b.symbol.startLine;
        return a.symbol.name.localeCompare(b.symbol.name);
      })
      .map(({ symbol, matchLines }) => ({
        displayPath: group.displayPath,
        absolutePath: group.absolutePath,
        matchCount: matchLines.size,
        scope: {
          mode: "symbol" as const,
          symbol,
          matchLines: [...matchLines].sort((a, b) => a - b),
          ...(input.scopeContext !== undefined ? { contextLines: input.scopeContext } : {}),
        },
        entries: buildSymbolEntries(fileLines, symbol, matchLines, input.scopeContext),
      }));

    for (const scopedGroup of scopedGroups) rendered.push({ order: scopedGroup.scope!.symbol.startLine, group: scopedGroup });

    if (fallbackMatchLines.length > 0) {
      rendered.push({
        order: Math.min(...fallbackMatchLines),
        group: {
          displayPath: group.displayPath,
          absolutePath: group.absolutePath,
          matchCount: fallbackMatchLines.length,
          entries: buildFallbackEntries(fileLines, fallbackMatchLines, input.contextLines),
        },
      });
    }

    if (scopedGroups.length === 0 && fallbackMatchLines.length === 0) {
      rendered.push({ order: firstLineNumber(group), group });
    }
  }

  rendered.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.group.absolutePath !== b.group.absolutePath) return a.group.absolutePath.localeCompare(b.group.absolutePath);
    return a.group.displayPath.localeCompare(b.group.displayPath);
  });

  return { groups: rendered.map((item) => item.group), warnings };
}
