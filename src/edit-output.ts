import { countEditTypes, parseDiffStats } from "./edit-render-helpers.js";
import { buildPtcEditResult, type SemanticSummary } from "./ptc-value.js";
export interface BuildEditOutputInput {
  path: string;
  displayPath: string;
  diff: string;
  firstChangedLine: number | undefined;
  warnings: string[];
  noopEdits: unknown[];
  semanticSummary?: SemanticSummary;
  edits?: unknown[];
}
export interface EditOutputResult {
  text: string;
  ptcValue: ReturnType<typeof buildPtcEditResult>;
}
function getVisibleDiffStats(diff: string): { added: number; removed: number } {
  const stats = parseDiffStats(diff);
  if (stats.added > 0 || stats.removed > 0) return stats;
  if (!diff.includes("→")) return stats;
  if (diff.includes("→ [deleted]")) return { added: 0, removed: 1 };
  return { added: 1, removed: 1 };
}
function buildVisibleSummary(displayPath: string, diff: string, edits: unknown[] | undefined): string {
  const stats = getVisibleDiffStats(diff);
  const counts = countEditTypes(edits);
  const editCount = counts.total || 1;
  const changeWord = editCount === 1 ? "change" : "changes";
  const changedLineCount = Math.max(stats.added, stats.removed);
  const lineWord = changedLineCount === 1 ? "line" : "lines";
  return `Edited ${displayPath} (${editCount} ${changeWord}, +${stats.added} -${stats.removed} ${lineWord})`;
}
function extractNewTextValues(edits: unknown[] | undefined): string[] {
  const values: string[] = [];
  for (const edit of edits ?? []) {
    if (!edit || typeof edit !== "object") continue;
    if ("set_line" in edit && typeof (edit as any).set_line?.new_text === "string") values.push((edit as any).set_line.new_text);
    if ("replace_lines" in edit && typeof (edit as any).replace_lines?.new_text === "string") values.push((edit as any).replace_lines.new_text);
    if ("insert_after" in edit && typeof (edit as any).insert_after?.new_text === "string") values.push((edit as any).insert_after.new_text);
    if ("replace" in edit && typeof (edit as any).replace?.new_text === "string") values.push((edit as any).replace.new_text);
  }
  return values;
}
function formatWhitespaceOnlyWarning(semanticSummary: SemanticSummary | undefined, edits: unknown[] | undefined): string | undefined {
  if (semanticSummary?.classification !== "whitespace-only") return undefined;
  if (!extractNewTextValues(edits).some((text) => /\S/.test(text))) return undefined;
  return "⚠ Edit classified as whitespace-only — if you intended a behavior change, re-read to verify.";
}
function formatSemanticSuffix(semanticSummary: SemanticSummary | undefined): string {
  const movedBlocks = semanticSummary?.movedBlocks ?? 0;
  if (movedBlocks <= 0) return "";
  const blockWord = movedBlocks === 1 ? "block" : "blocks";
  return ` [semantic: ${semanticSummary!.classification}, ${movedBlocks} ${blockWord} moved]`;
}
function formatReplaceHint(edits: unknown[] | undefined, noopEdits: unknown[]): string | undefined {
  if ((noopEdits ?? []).length > 0) return undefined;
  const counts = countEditTypes(edits);
  if (counts.replace === 0) return undefined;
  if (counts.replace !== counts.total) return undefined;
  return "[info: this edit used replace (unverified). For safer future edits, prefer set_line/replace_lines with an anchor from read/grep/ast_search.]";
}
export function buildEditOutput(input: BuildEditOutputInput): EditOutputResult {
  const summary = `Updated ${input.displayPath}`;
  const visibleSummary = `${buildVisibleSummary(input.displayPath, input.diff, input.edits)}${formatSemanticSuffix(input.semanticSummary)}`;
  const semanticWarning = formatWhitespaceOnlyWarning(input.semanticSummary, input.edits);
  const warningText = input.warnings.length ? `\n\nWarnings:\n${input.warnings.join("\n")}` : "";
  const replaceHint = formatReplaceHint(input.edits, input.noopEdits);
  let text = visibleSummary;
  if (semanticWarning) text += `\n${semanticWarning}`;
  text += warningText;
  if (replaceHint) text += `\n${replaceHint}`;
  return {
    text,
    ptcValue: buildPtcEditResult({
      path: input.path,
      summary,
      diff: input.diff,
      firstChangedLine: input.firstChangedLine,
      warnings: input.warnings,
      noopEdits: input.noopEdits,
      ...(input.semanticSummary ? { semanticSummary: input.semanticSummary } : {}),
    }),
  };
}
