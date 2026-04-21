/**
 * Session Log Parser
 *
 * Extracts the last rendered assistant message from a Claude Code session log.
 * Used by the "annotate-last" feature to let users annotate the most recent
 * assistant response in the annotation UI.
 *
 * Session logs are JSONL files at:
 *   ~/.claude/projects/{project-slug}/{session-id}.jsonl
 *
 * Each line is a JSON object with a `type` field. Assistant messages may be
 * split across multiple lines sharing the same `message.id` (streamed chunks).
 * Text content blocks (`type: "text"` inside `message.content`) are what the
 * user sees rendered in chat.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// --- Types ---

export interface SessionLogEntry {
  type: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface RenderedMessage {
  /** The API message ID (shared across streamed chunks) */
  messageId: string;
  /** Concatenated text from all text blocks */
  text: string;
  /** Line numbers in the JSONL where this message appeared */
  lineNumbers: number[];
}

// --- Session File Discovery ---

/**
 * Derive the project slug from a working directory path.
 * Claude Code replaces every character outside [a-zA-Z0-9-] with `-`.
 * On Windows it also lowercases drive letters (C: → c-).
 */
export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Find all .jsonl session log files in a project directory,
 * sorted by modification time (most recent first).
 * Returns empty array if no session logs exist.
 */
export function findSessionLogs(projectDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  const withMtime: { path: string; mtime: number }[] = [];
  for (const f of files) {
    const full = join(projectDir, f);
    try {
      withMtime.push({ path: full, mtime: statSync(full).mtimeMs });
    } catch {
      continue;
    }
  }

  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);
}

/**
 * Find session log candidates for a given working directory.
 * Returns all .jsonl paths sorted by mtime (most recent first).
 *
 * Tries the exact slug first, then a case-insensitive match. On Windows,
 * Claude Code lowercases the entire slug (e.g. `C-Users-...` → `c-users-...`)
 * while our cwd may have mixed case. The fallback scans the projects directory
 * for a case-insensitive match.
 */
export function findSessionLogsForCwd(cwd: string): string[] {
  const slug = projectSlugFromCwd(cwd);
  const projectsDir = join(homedir(), ".claude", "projects");
  const projectDir = join(projectsDir, slug);

  // Try exact match first
  const logs = findSessionLogs(projectDir);
  if (logs.length > 0) return logs;

  // Fallback: case-insensitive directory scan (handles Windows drive letter casing)
  const slugLower = slug.toLowerCase();
  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      if (dir.toLowerCase() === slugLower) {
        const fallbackLogs = findSessionLogs(join(projectsDir, dir));
        if (fallbackLogs.length > 0) return fallbackLogs;
      }
    }
  } catch {
    // projectsDir doesn't exist
  }

  return [];
}

// --- Session Metadata Resolution ---

/**
 * Claude Code writes per-process session metadata to:
 *   ~/.claude/sessions/<pid>.json
 *
 * Each file contains:
 *   { pid, sessionId, cwd, startedAt }
 *
 * This lets us deterministically resolve the correct session log
 * when the shell CWD has diverged from the session's project directory
 * (e.g. after the user runs `cd` during a session).
 */

interface SessionMetadata {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

/**
 * Read a Claude Code session metadata file for a given PID.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readSessionMetadata(pid: number): SessionMetadata | null {
  const metaPath = join(homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Resolve the session log path using Claude Code's session metadata.
 *
 * Strategy:
 * 1. Read ~/.claude/sessions/<ppid>.json to get the exact sessionId and cwd.
 * 2. Use findSessionLogsForCwd() with the session's original cwd (not the
 *    current shell cwd), which handles case-insensitive slug matching on Windows.
 * 3. Return the log matching the sessionId, or null.
 *
 * Returns null if session metadata is unavailable or the log file doesn't exist.
 */
export function resolveSessionLogByPpid(): string | null {
  const ppid = process.ppid;
  if (!ppid) return null;

  const meta = readSessionMetadata(ppid);
  if (!meta?.sessionId || !meta?.cwd) return null;

  const candidates = findSessionLogsForCwd(meta.cwd);
  return candidates.find((p) => p.includes(meta.sessionId)) ?? null;
}

/**
 * Walk up the directory tree from `cwd` trying each ancestor as a project slug.
 * Returns session logs from the first ancestor that has any, sorted by mtime.
 *
 * Used as a fallback when session metadata resolution (PPID) is unavailable.
 * Stops at the filesystem root to avoid infinite loops.
 */
export function findSessionLogsByAncestorWalk(cwd: string): string[] {
  let dir = dirname(cwd);
  if (dir === cwd) return [];

  while (true) {
    const logs = findSessionLogsForCwd(dir);
    if (logs.length > 0) return logs;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [];
}

// --- Log Parsing ---

/**
 * Parse a JSONL session log into entries.
 * Invalid lines are silently skipped.
 */
export function parseSessionLog(content: string): SessionLogEntry[] {
  const lines = content.trim().split("\n");
  const entries: SessionLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Prefixes that indicate system-generated user messages, not real human input.
 * Claude Code logs local command caveats, command names, stdout/stderr, and
 * other system messages as type:"user" with string content.
 */
const SYSTEM_USER_PREFIXES = [
  "<local-command-",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
];

/**
 * Check if a session log entry is a human-typed user prompt
 * (as opposed to a tool result or system-generated user message).
 */
export function isHumanPrompt(entry: SessionLogEntry): boolean {
  if (entry.type !== "user") return false;
  if (typeof entry.message?.content !== "string") return false;
  const content = entry.message.content;
  // Filter out system-generated user messages
  for (const prefix of SYSTEM_USER_PREFIXES) {
    if (content.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Check if a session log entry is an assistant message with rendered text.
 */
function hasTextContent(entry: SessionLogEntry): boolean {
  if (entry.type !== "assistant") return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: ContentBlock) => block.type === "text" && block.text?.trim()
  );
}

/**
 * Extract text blocks from an assistant message's content array.
 */
function extractTextBlocks(entry: SessionLogEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: ContentBlock) => b.type === "text" && b.text?.trim())
    .map((b: ContentBlock) => b.text!);
}

/**
 * Find the anchor index: the last human prompt at or before `beforeIndex`
 * whose content includes `anchorText`.
 * If no anchorText is provided, returns the index of the last human prompt.
 */
export function findAnchorIndex(
  entries: SessionLogEntry[],
  anchorText?: string,
  beforeIndex?: number
): number {
  const end = beforeIndex ?? entries.length - 1;
  for (let i = end; i >= 0; i--) {
    if (!isHumanPrompt(entries[i])) continue;
    if (!anchorText) return i;
    const content = entries[i].message!.content as string;
    if (content.includes(anchorText)) return i;
  }
  return -1;
}

/**
 * Extract the last rendered assistant message before a given index.
 *
 * Finds the last message.id with text content — the final "bubble" the user
 * sees in the TUI. Collects all text chunks for that message.id only.
 *
 * Skips noise entries and non-human user messages. If no text is found
 * in the current turn, walks backward through earlier turns.
 */
export function extractLastRenderedMessage(
  entries: SessionLogEntry[],
  beforeIndex: number
): RenderedMessage | null {
  let targetMessageId: string | null = null;
  const textParts: { text: string; lineNum: number }[] = [];

  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = entries[i];

    // Skip noise
    if (entry.type === "progress" || entry.type === "system") continue;
    if (entry.type === "file-history-snapshot") continue;
    if (entry.type === "queue-operation") continue;

    // Skip non-human user messages (tool results, system-generated)
    if (entry.type === "user" && !isHumanPrompt(entry)) continue;

    // At a human prompt: if we already have text, stop.
    // If no text yet, skip and keep looking in earlier turns.
    if (isHumanPrompt(entry)) {
      if (textParts.length > 0) break;
      continue;
    }

    if (entry.type !== "assistant") continue;

    // If we already locked onto a message.id, collect earlier chunks of it
    if (targetMessageId) {
      const msgId = entry.message?.id;
      if (msgId !== targetMessageId) break;
      const texts = extractTextBlocks(entry);
      if (texts.length > 0) {
        textParts.push(...texts.map((t) => ({ text: t, lineNum: i + 1 })));
      }
      continue;
    }

    // Haven't found target yet — look for assistant with text
    if (!hasTextContent(entry)) continue;
    const msgId = entry.message?.id;
    if (!msgId) continue;

    targetMessageId = msgId;
    const texts = extractTextBlocks(entry);
    textParts.push(...texts.map((t) => ({ text: t, lineNum: i + 1 })));
  }

  if (!targetMessageId || textParts.length === 0) return null;

  textParts.reverse();

  return {
    messageId: targetMessageId,
    text: textParts.map((p) => p.text).join("\n"),
    lineNumbers: textParts.map((p) => p.lineNum),
  };
}

/**
 * High-level: extract the last rendered assistant message from a session log file.
 *
 * Starts from the END of the log (no anchoring). The slash command's
 * <command-message> entry isn't written until after the binary completes,
 * so we can't anchor on it. Instead, we just find the last assistant
 * text entry in the entire log.
 */
export function getLastRenderedMessage(
  logPath: string,
): RenderedMessage | null {
  try {
    const content = readFileSync(logPath, "utf-8");
    const entries = parseSessionLog(content);
    return extractLastRenderedMessage(entries, entries.length);
  } catch {
    return null;
  }
}
