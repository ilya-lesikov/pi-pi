import { readFileSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

export interface LoadedMessages {
  rendered: RenderedEntry[];
  raw: Message[];
}

export interface SessionSource {
  getSessionFile(): string | undefined;
  getSessionManager?(): any;
}

export function loadSessionEntries(sessionFile: string): any[] {
  const entries: any[] = [];
  for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

/**
 * Renders the session's messages, keeping the global message index stable
 * whether or not a filter drops the entry: the indices are what `expand` and
 * the printed `#N` refer to, so they cannot renumber per scope.
 */
export function loadMessages(entries: any[], full: boolean, allowedEntryIds?: Set<string>): LoadedMessages {
  const rendered: RenderedEntry[] = [];
  const raw: Message[] = [];
  let index = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    if (!allowedEntryIds || allowedEntryIds.has(entry.id)) {
      rendered.push(renderMessage(entry.message, index, full));
      raw.push(entry.message);
    }
    index++;
  }
  return { rendered, raw };
}

/** The entry ids on the branch the session is currently on. */
export function activeLineageEntryIds(sessionManager: any): Set<string> {
  const ids = (entries: any[] | undefined) =>
    new Set((entries ?? []).map((entry) => entry?.id).filter((id): id is string => Boolean(id)));
  try {
    const branch = sessionManager?.getBranch?.();
    if (Array.isArray(branch) && branch.length > 0) return ids(branch);
  } catch {}
  try {
    return ids(sessionManager?.getEntries?.());
  } catch {
    return new Set();
  }
}

/**
 * The recorded arguments or output of one tool call.
 *
 * The stored session is re-read rather than the prompt consulted, because the
 * prompt is where the content is missing from: folding edits the request on its
 * way to the provider and never the store.
 */
export interface RecalledCall {
  args?: Record<string, unknown>;
  output?: string;
  /** Image parts of the result, which folding removed along with its text. */
  images?: Array<{ data: string; mimeType: string }>;
}

export function findToolCall(entries: any[], callId: string): RecalledCall | undefined {
  let found: RecalledCall | undefined;
  for (const entry of entries) {
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "toolCall" && part.id === callId) found = { ...found, args: part.arguments ?? {} };
      }
      continue;
    }
    if (message.role !== "toolResult" || message.toolCallId !== callId) continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const images = parts
      .filter((part: any) => part?.type === "image" && typeof part.data === "string")
      .map((part: any) => ({ data: part.data, mimeType: part.mimeType ?? "image/png" }));
    found = { ...found, output: textOf(message.content), ...(images.length > 0 && { images }) };
  }
  return found;
}

export function clip(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

export function textOf(content: Message["content"] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

export function thinkingOf(content: Message["content"] | undefined): string {
  if (!content || typeof content === "string") return "";
  return content
    .filter((part: any) => part.type === "thinking")
    .map((part: any) => part.thinking ?? "")
    .join("\n");
}

function extractPath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const path = extractPath(args);
  if (path) return `path=${path}`;
  if (typeof args.command === "string") return `command=${args.command}`;
  if (typeof args.query === "string") return `query=${args.query}`;
  return Object.keys(args).join(", ");
}

export function renderMessage(message: Message, index: number, full = false): RenderedEntry {
  if (message.role === "user") {
    return { index, role: "user", summary: full ? textOf(message.content) : clip(textOf(message.content), 300) };
  }
  if (message.role === "toolResult") {
    const text = full ? textOf(message.content) : clip(textOf(message.content), 200);
    return { index, role: "tool_result", summary: `${message.isError ? "ERROR " : ""}[${message.toolName}] ${text}` };
  }
  if ((message as any).role === "bashExecution") {
    const raw = `$ ${(message as any).command ?? ""}\n${(message as any).output ?? ""}`;
    return { index, role: "bash", summary: full ? raw : clip(raw, 300) };
  }

  const content = Array.isArray(message.content) ? message.content : [];
  const calls = content.filter((part: any) => part.type === "toolCall") as any[];
  const tools = calls.map((part) => `${part.name}(${summarizeToolArgs(part.arguments ?? {})})`).join(", ");
  const files = calls.map((part) => extractPath(part.arguments ?? {})).filter((path): path is string => path !== null);

  const text = full ? textOf(message.content) : clip(textOf(message.content), 300);
  const thinking = thinkingOf(message.content);
  const shownThinking = thinking ? (full ? thinking : clip(thinking, 150)) : "";
  const body = shownThinking ? `[thinking] ${shownThinking}\n${text}` : text;

  return { index, role: "assistant", summary: tools ? `${tools}\n${body}` : body, ...(files.length > 0 && { files }) };
}

/** The full searchable text of a message, reasoning included. */
export function fullText(message: Message): string {
  if ((message as any).role === "bashExecution") {
    return `${(message as any).command ?? ""} ${(message as any).output ?? ""}`;
  }
  const text = textOf(message.content);
  const thinking = thinkingOf(message.content);
  return thinking ? `${thinking}\n${text}` : text;
}
