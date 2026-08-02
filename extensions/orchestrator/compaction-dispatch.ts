import type { PiVccCompactionDetails } from "../../3p/pi-vcc/index.js";

// Helpers for the in-phase (natural) compaction path that runs the vendored
// pi-vcc engine from pi-pi's single session_before_compact dispatcher (item 1).
// Ported from pi-vcc's dropped hooks/before-compact.ts so the persisted
// compaction metadata matches what vcc_recall (recall.ts) expects:
// details.compactor === "pi-vcc" plus a [firstSummarizedId, lastSummarizedId]
// messageRange keyed by ENTRY IDs (not branch-relative indices).

interface BranchEntry {
  id: string;
  type?: string;
  message?: unknown;
}

/**
 * Compute the entry-ID range of the summarized messages, exactly like upstream
 * pi-vcc's computeMessageRange. Returns [firstMessageEntryId, firstKeptEntryId]
 * or undefined when nothing was summarized (the first kept entry IS the first
 * message, or there are no message entries). Uses entry IDs so vcc_recall can
 * resolve the range against the full session file.
 */
export function computeVccMessageRange(
  branchEntries: BranchEntry[],
  firstKeptEntryId: string,
): [string, string] | undefined {
  if (!firstKeptEntryId) {
    // compact-all sentinel: range spans the first..last message entry.
    let lastId: string | undefined;
    let firstId: string | undefined;
    for (const e of branchEntries) {
      if (e.type === "message" && e.message != null && e.id) {
        if (firstId === undefined) firstId = e.id;
        lastId = e.id;
      }
    }
    return firstId && lastId ? [firstId, lastId] : undefined;
  }

  const firstMsgId = branchEntries.find(
    (e) => e.type === "message" && e.message != null && !!e.id,
  )?.id;
  if (!firstMsgId) return undefined;
  // If the first kept entry IS the first message, nothing was summarized.
  if (firstMsgId === firstKeptEntryId) return undefined;
  return [firstMsgId, firstKeptEntryId];
}

/**
 * Build the PiVccCompactionDetails persisted alongside the summary, mirroring
 * upstream. `sections` are the bracket-tag headers pi-vcc emits at line starts
 * (e.g. "[Session Goal]"), which recall/rendering surface.
 */
export function buildVccDetails(
  summary: string,
  sourceMessageCount: number,
  previousSummaryUsed: boolean,
  tokensBefore: number,
  messageRange: [string, string] | undefined,
): PiVccCompactionDetails {
  const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
  return {
    compactor: "pi-vcc",
    version: 1,
    sections,
    sourceMessageCount,
    previousSummaryUsed,
    messageRange,
    compressionRatio: tokensBefore > 0 ? Math.round(tokensBefore / Math.max(1, sourceMessageCount)) : undefined,
    timestamp: new Date().toISOString(),
    tokensBefore: tokensBefore || undefined,
  };
}
