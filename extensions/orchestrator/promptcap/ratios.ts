import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RatioStore } from "./guard.js";

// How often what has been learned is written back. A ratio moves a little on
// every turn and converges within a handful of them, so the last few seconds of
// learning are worth less than a file write per turn from every session and
// subagent sharing the file.
const SAVE_INTERVAL_MS = 30_000;

function ratiosPath(): string {
  return join(getAgentDir(), "extensions", "pp", "promptcap-ratios.json");
}

/**
 * The byte-to-token ratios learned from what providers charged, kept on disk.
 *
 * A ratio describes a model, not a conversation, and it takes a turn to learn:
 * without this the first prompt after a restart is sized by the raw estimate,
 * which on a real session ran a quarter under what the model charged — so the
 * fold aimed high and the whole session sat above where it belonged. The file
 * is shared by every session and subagent on the machine, which is what makes
 * one turn anywhere enough for all of them.
 */
export function fileRatioStore(): RatioStore {
  let lastSaved = 0;
  return {
    load(): Record<string, number> {
      return read();
    },
    save(ratios: Record<string, number>): void {
      const now = Date.now();
      if (now - lastSaved < SAVE_INTERVAL_MS) return;
      lastSaved = now;
      // Merged rather than overwritten: another session is learning the models
      // this one never used, and a whole-file write would forget them.
      const merged = { ...read(), ...ratios };
      const path = ratiosPath();
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
      } catch {}
    },
  };
}

function read(): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ratiosPath(), "utf-8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
