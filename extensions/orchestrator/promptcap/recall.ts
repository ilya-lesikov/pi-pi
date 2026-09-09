import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { searchEntries, type SearchHit } from "./search.js";
import { formatRecallOutput } from "./format.js";
import { byteLength } from "./estimate.js";
import { cutBytes } from "./fold.js";
import {
  activeLineageEntryIds,
  findToolCall,
  type RecalledCall,
  loadMessages,
  loadSessionEntries,
  renderMessage,
  type SessionSource,
} from "./session.js";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;
const MAX_PAGES = 5;

// Bounds what one recall returns. A folded result is recalled because the
// prompt had no room for it, so handing back all of it would undo the fold that
// made the room.
const RECALL_LIMIT = 8000;

/**
 * Explains the omission notices once, in the system prompt, rather than in
 * every notice. A long session folds hundreds of calls, and the difference
 * between explaining each time and explaining once is thousands of tokens of
 * boilerplate — paid for out of the recent tool history the model reads.
 */
export const OMISSION_INSTRUCTION = [
  "<folded_history>",
  "Older tool output in this conversation may appear as a notice of the form [omitted: <size>B; <call_id>],",
  "and older tool arguments may be cut short with a …[+NB] marker. The conversation outgrew the model's",
  "context window, so the prompt you see was folded on its way here. The session itself is complete.",
  "",
  "To read what was folded away, call recall_tool_output with that call_id — page a long one with offset and",
  "limit, or narrow it with pattern. recall_tool_args does the same for a call's arguments.",
  "",
  "A recalled result is what the tool returned at the time, not the state of the world now. When you need to",
  "know how things are now, call the tool again, narrowed so its answer is smaller than the one that had to",
  "be folded.",
  "</folded_history>",
].join("\n");

function resolveEntries(
  ctx: any,
  source: SessionSource | undefined,
  useCurrent: boolean,
): { entries: any[] | undefined; sessionManager: any } {
  const sessionManager = useCurrent ? ctx.sessionManager : source?.getSessionManager?.() ?? ctx.sessionManager;
  const sessionFile = useCurrent
    ? sessionManager?.getSessionFile?.()
    : source?.getSessionFile() ?? sessionManager?.getSessionFile?.();
  const entries = sessionFile ? loadSessionEntries(sessionFile) : sessionManager?.getEntries?.();
  return { entries: Array.isArray(entries) ? entries : undefined, sessionManager };
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

export function registerRecallTools(pi: ExtensionAPI, source?: SessionSource): void {
  pi.registerTool({
    name: "vcc_recall",
    label: "Recall",
    description:
      "Search session history. source defaults to 'root'; use source:'current' for the executing session. " +
      "Defaults to the active branch; use scope:'all' to include off-branch history. Supports regex queries, paging, and expand indices.",
    promptSnippet:
      "vcc_recall: Search history; source defaults to the owning root session. Use source:'current' for this session's history. " +
      "Default scope is the active branch; use scope:'all' for off-branch history. " +
      "expand:[indices] returns full content for those entries, composable with query to expand matched results.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance." }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for. Works alone (any index in scope) or alongside query (expands matching entries on the current page)." }),
      ),
      page: Type.Optional(Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1." })),
      scope: Type.Optional(
        Type.Union([Type.Literal("lineage"), Type.Literal("all")], { description: "Search scope: 'lineage' (default, the active branch) or 'all' (the entire session)." }),
      ),
      source: Type.Optional(
        Type.Union([Type.Literal("root"), Type.Literal("current")], { description: "Session to search: 'root' (default; owning main session) or 'current' (the session executing this tool)." }),
      ),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const useCurrent = params.source === "current";
      const { entries, sessionManager } = resolveEntries(ctx, source, useCurrent);
      if (!entries) return text(`No ${useCurrent ? "current" : "root"} session history available.`);

      const allScope = params.scope === "all";
      const lineage = allScope ? undefined : activeLineageEntryIds(sessionManager);
      const scopeLabel = allScope ? " (scope: all)" : "";
      const expandSet = new Set<number>(params.expand ?? []);
      const query = typeof params.query === "string" ? params.query.trim() : "";

      if (expandSet.size > 0 && !query) {
        const { rendered } = loadMessages(entries, true, lineage);
        const byIndex = new Map(rendered.map((entry) => [entry.index, entry]));
        const invalid = [...expandSet].filter((index) => !byIndex.has(index));
        if (invalid.length > 0) {
          return text(`Cannot expand indices outside ${allScope ? "session history" : "the active branch"}: ${invalid.join(", ")}`);
        }
        const expanded = [...expandSet].map((index) => byIndex.get(index)!);
        return text(scopeLabel.trim() + "\n" + formatRecallOutput(expanded));
      }

      const { rendered, raw } = loadMessages(entries, false, lineage);
      if (!query) {
        return text(scopeLabel.trim() + "\n" + formatRecallOutput(rendered.slice(-DEFAULT_RECENT)));
      }

      const hits = searchEntries(rendered, raw, query);
      const page = Math.max(1, params.page ?? 1);
      const totalPages = Math.ceil(hits.length / PAGE_SIZE);
      if (hits.length > 0 && page > Math.min(totalPages, MAX_PAGES)) {
        return text(`Too many results to page through (${hits.length} matches across ${totalPages} pages). Try a more specific query${scopeLabel}.`);
      }

      const pageHits = hits.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE) as SearchHit[];
      const header = totalPages > 1
        ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeLabel})`
        : `${hits.length} matches${scopeLabel}`;

      // Swap the truncated snippet for full content on any paged result the
      // caller asked to expand. `raw` is parallel to `rendered`, so the
      // requested entries are re-rendered rather than the file re-read.
      const expanded: number[] = [];
      if (expandSet.size > 0) {
        const rawByIndex = new Map<number, Message>();
        for (let i = 0; i < rendered.length; i++) rawByIndex.set(rendered[i].index, raw[i]);
        for (const hit of pageHits) {
          if (!expandSet.has(hit.index)) continue;
          const message = rawByIndex.get(hit.index);
          if (!message) continue;
          const full = renderMessage(message, hit.index, true);
          hit.snippet = full.summary;
          hit.summary = full.summary;
          expanded.push(hit.index);
        }
      }

      const footer: string[] = [];
      if (page < totalPages && page < MAX_PAGES) footer.push(`--- Use page:${page + 1} for more results ---`);
      else if (totalPages > MAX_PAGES) footer.push(`--- Results truncated at ${MAX_PAGES} pages. Use a more specific query to narrow results. ---`);
      if (expandSet.size > 0) {
        const missing = [...expandSet].filter((index) => !expanded.includes(index));
        const noun = expanded.length === 1 ? "entry" : "entries";
        if (expanded.length > 0 && missing.length === 0) footer.push(`--- expanded ${expanded.length} ${noun} to full content ---`);
        else if (expanded.length > 0) footer.push(`--- expanded ${expanded.length} ${noun} to full content; not on this page: ${missing.join(", ")} ---`);
        else if (missing.length > 0) footer.push(`--- no expand indices on this page: ${missing.join(", ")} ---`);
      }

      const body = formatRecallOutput(pageHits, query, header) + (footer.length ? "\n" + footer.join("\n") : "");
      return text(body);
    },
  });

  pi.registerTool({
    name: "recall_tool_output",
    label: "Recall output",
    description:
      "Read the full output of an earlier tool call whose output was replaced by an [omitted: …] notice. " +
      "Takes the call_id from that notice. Use offset and limit to page through a long output, or pattern to " +
      "return only the lines containing a string. Returns what the tool returned at the time, which is not " +
      "necessarily true now.",
    parameters: Type.Object({
      call_id: Type.String({ description: "The call id printed in the [omitted: …] notice." }),
      offset: Type.Optional(Type.Number({ description: "First line to return (0-based)." })),
      limit: Type.Optional(Type.Number({ description: "How many lines to return." })),
      pattern: Type.Optional(Type.String({ description: "Return only the lines containing this string." })),
      source: Type.Optional(
        Type.Union([Type.Literal("root"), Type.Literal("current")], { description: "Session to read: 'root' (default) or 'current'." }),
      ),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const found = lookup(ctx, source, params);
      if (typeof found === "string") return text(found);
      if (found.output === undefined && !found.images) return text(`Call ${params.call_id} has no recorded output.`);
      const body = slice(found.output ?? "", params.offset, params.limit, params.pattern);
      // An image result folds to a notice like any other, so recall has to be
      // able to hand the image itself back and not just its caption.
      if (!found.images) return text(body);
      return {
        content: [
          { type: "text" as const, text: body },
          ...found.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "recall_tool_args",
    label: "Recall arguments",
    description:
      "Read the full arguments of an earlier tool call whose arguments were shortened with a …[+NB] marker. " +
      "Takes the call_id shown in the [omitted: …] notice of the same call.",
    parameters: Type.Object({
      call_id: Type.String({ description: "The call id printed in the [omitted: …] notice." }),
      offset: Type.Optional(Type.Number({ description: "First line to return (0-based)." })),
      limit: Type.Optional(Type.Number({ description: "How many lines to return." })),
      source: Type.Optional(
        Type.Union([Type.Literal("root"), Type.Literal("current")], { description: "Session to read: 'root' (default) or 'current'." }),
      ),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const found = lookup(ctx, source, params);
      if (typeof found === "string") return text(found);
      if (found.args === undefined) return text(`Call ${params.call_id} has no recorded arguments.`);
      return text(slice(JSON.stringify(found.args, null, 2), params.offset, params.limit));
    },
  });
}

function lookup(ctx: any, source: SessionSource | undefined, params: any): RecalledCall | string {
  const callId = String(params.call_id ?? "").trim();
  if (!callId) return "No call_id given; it is printed in the [omitted: …] notice.";
  const useCurrent = params.source === "current";
  const { entries } = resolveEntries(ctx, source, useCurrent);
  if (!entries) return `No ${useCurrent ? "current" : "root"} session history available.`;
  const found = findToolCall(entries, callId);
  if (!found) return `No call ${callId} in this conversation.`;
  return found;
}

/** The part of `found` the caller asked for, bounded so a recall cannot refill the context it worked around. */
export function slice(found: string, offset?: number, limit?: number, pattern?: string): string {
  let lines = found.split("\n");

  if (pattern) {
    const matched = lines.filter((line) => line.includes(pattern));
    if (matched.length === 0) return `No line contains ${JSON.stringify(pattern)}; the output is ${byteLength(found)} bytes.`;
    lines = matched;
  }

  if (offset && offset > 0) {
    if (offset >= lines.length) return `Offset ${offset} is past the end; the output has ${lines.length} lines.`;
    lines = lines.slice(offset);
  }
  if (limit && limit > 0 && limit < lines.length) lines = lines.slice(0, limit);

  const out = lines.join("\n");
  if (byteLength(out) <= RECALL_LIMIT) return out;
  const shown = cutBytes(out, RECALL_LIMIT);
  return `${shown}\n…[${byteLength(out) - byteLength(shown)} bytes not shown; page on with offset and limit, or narrow with pattern]`;
}
