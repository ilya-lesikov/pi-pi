import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeConfigValue } from "./config.js";
import { resolveAgentDir } from "./flant-infra.js";
import { getLogger } from "./log.js";

/**
 * How many times pi retries a provider call that failed before it gives up on
 * the turn, and how long it may wait between attempts.
 *
 * pi reads both from its own settings file. No extension API reaches them — the
 * settings manager is not on the extension context, and there is no setter —
 * so raising them means writing the setting pi reads.
 *
 * Three attempts is short for a transport fault. A connection error says
 * nothing about whether the request would succeed, and the failures that
 * produce it arrive in bursts lasting longer than three quick attempts span,
 * which is how a turn dies to a fault that had already cleared.
 */
const MAX_RETRIES = 8;

// The ceiling on the wait between attempts, not the total. Backoff grows until
// it reaches this, so raising it is what turns more attempts into a longer
// window rather than the same window sampled more often.
const MAX_RETRY_DELAY_MS = 120_000;

export type RetrySettingsOutcome = "written" | "present" | "unwritable";

function settingsPath(): string {
  return join(resolveAgentDir(), "settings.json");
}

/** What pi currently has, or undefined where it has nothing of its own. */
export function readProviderRetry(path = settingsPath()): { maxRetries?: number; maxRetryDelayMs?: number } {
  try {
    if (!existsSync(path)) return {};
    const provider = JSON.parse(readFileSync(path, "utf-8"))?.retry?.provider;
    return provider && typeof provider === "object" ? provider : {};
  } catch {
    return {};
  }
}

/**
 * Raises pi's retry ceiling where the user has expressed no preference.
 *
 * A value already in the file is left alone, whatever it is: it is the user's,
 * and a default that overwrote it would be a setting that could not be turned
 * down.
 */
export function ensureProviderRetrySettings(path = settingsPath()): RetrySettingsOutcome {
  const current = readProviderRetry(path);
  if (typeof current.maxRetries === "number") return "present";
  try {
    writeConfigValue(path, ["retry", "provider", "maxRetries"], MAX_RETRIES);
    if (typeof current.maxRetryDelayMs !== "number") {
      writeConfigValue(path, ["retry", "provider", "maxRetryDelayMs"], MAX_RETRY_DELAY_MS);
    }
    getLogger().debug({ s: "retry", path, maxRetries: MAX_RETRIES }, "raised pi's provider retry ceiling");
    return "written";
  } catch (err) {
    getLogger().warn({ s: "retry", path, err: String(err) }, "could not raise pi's provider retry ceiling");
    return "unwritable";
  }
}
