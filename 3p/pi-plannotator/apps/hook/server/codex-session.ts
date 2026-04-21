/**
 * Codex Session Parser
 *
 * Extracts the last rendered assistant message from a Codex rollout file.
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * Detection: Codex injects CODEX_THREAD_ID into every spawned process.
 * The thread ID is the UUID in the rollout filename.
 *
 * Rollout format (JSONL, one object per line):
 *   {"timestamp":"...","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
 *   {"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"...","call_id":"..."}}
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Types ---

interface RolloutEntry {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    content?: { type: string; text?: string }[];
    [key: string]: unknown;
  };
}

// --- Rollout File Discovery ---

/**
 * Find the Codex rollout file for a given thread ID.
 * The thread ID is the UUID portion of the filename:
 *   rollout-<timestamp>-<uuid>.jsonl
 *
 * Scans ~/.codex/sessions/ directory tree for a matching file.
 */
export function findCodexRolloutByThreadId(threadId: string): string | null {
  const sessionsDir = join(homedir(), ".codex", "sessions");

  try {
    // Walk YYYY/MM/DD directories in reverse order (most recent first)
    const years = readdirSync(sessionsDir).sort().reverse();
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      if (!isDir(yearDir)) continue;

      const months = readdirSync(yearDir).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        if (!isDir(monthDir)) continue;

        const days = readdirSync(monthDir).sort().reverse();
        for (const day of days) {
          const dayDir = join(monthDir, day);
          if (!isDir(dayDir)) continue;

          const files = readdirSync(dayDir);
          for (const file of files) {
            if (file.endsWith(".jsonl") && file.includes(threadId)) {
              return join(dayDir, file);
            }
          }
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- Message Extraction ---

/**
 * Extract the last assistant message from a Codex rollout file.
 *
 * Walks backward through the JSONL, finds the last entry where:
 *   type === "response_item"
 *   payload.type === "message"
 *   payload.role === "assistant"
 *
 * Extracts output_text blocks from payload.content.
 */
export function getLastCodexMessage(
  rolloutPath: string
): { text: string } | null {
  const content = readFileSync(rolloutPath, "utf-8");
  const lines = content.trim().split("\n");

  // Walk backward
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: RolloutEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (entry.type !== "response_item") continue;
    if (entry.payload?.type !== "message") continue;
    if (entry.payload?.role !== "assistant") continue;

    const contentBlocks = entry.payload?.content;
    if (!Array.isArray(contentBlocks)) continue;

    const textParts = contentBlocks
      .filter((b) => b.type === "output_text" && b.text?.trim())
      .map((b) => b.text!);

    if (textParts.length === 0) continue;

    return { text: textParts.join("\n") };
  }

  return null;
}
