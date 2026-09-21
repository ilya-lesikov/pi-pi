import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { writeConfigValue } from "./config.js";
import { resolveAgentDir } from "./flant-infra.js";
import { getLogger } from "./log.js";
import { noteOversizedRequest } from "./promptcap/guard.js";

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

/**
 * A status pi's retry predicate does not recognize.
 *
 * pi decides retryability by matching the provider's error text against a fixed
 * list of statuses and transport faults, and 499 is in none of them. The status
 * says the connection was closed before the upstream answered — Copilot's
 * gateway returns it under load — so the request never reached the model and
 * the same bytes sent again usually land. Unrecognized, it kills the turn where
 * a 500 would have been retried.
 *
 * pi refuses a spent quota before it considers any status, and that refusal
 * outranks this: a gateway that reports both is out of money, not out of
 * connection. A user's own abort cannot arrive here either — pi marks that
 * `aborted`, and the predicate this joins runs only on `error`.
 */
export function isUnrecognizedTransportError(message?: string): boolean {
  if (typeof message !== "string") return false;
  return /\b499\b/.test(message) && !isSpentQuota(message);
}

/**
 * A request the provider refused for its size rather than its content.
 *
 * Unlike every other status worth retrying, this one says the same bytes will
 * be refused again: it is retryable only because something between the attempts
 * makes the prompt smaller. The promptcap guard is what does that, and it is
 * also what decides whether a retry is worth scheduling at all.
 *
 * A bare number is not enough to go on. "failed after 413 ms" would arm an
 * emergency that empties a conversation of its screenshots for a fault that had
 * nothing to do with size, so the status counts only where a gateway puts a
 * status, and otherwise the refusal has to say what it was about.
 */
export function isRequestTooLargeError(message?: string): boolean {
  if (typeof message !== "string") return false;
  if (isSpentQuota(message)) return false;
  if (/request_too_large|(?:request|payload|entity|body|message)[\s_-]*(?:entity[\s_-]*)?too[\s_-]*large/i.test(message)) return true;
  return /\b(?:status(?:\s*code)?|http)\b[^\d]{0,12}413\b|\b413\b[\s:\u2013\u2014-]*(?:request|payload|entity|content|body)/i.test(message);
}

// A gateway that reports a spent quota alongside a status is out of money, not
// out of room or out of connection, and nothing here can make the next attempt
// land.
function isSpentQuota(message: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(message);
}

const PATCHED = Symbol.for("pi-pi:retry-predicate-patched");

export type RetryPredicateOutcome = "patched" | "already" | "absent";

/**
 * Widens pi's retry predicate to cover {@link isUnrecognizedTransportError} and
 * {@link isRequestTooLargeError}.
 *
 * The predicate is a private method holding a literal regex: no setting reaches
 * it and no extension API replaces it, so the only way in is the prototype pi
 * calls it through. The original decides first and this only ever adds, so a
 * status pi learns to retry on its own keeps pi's answer.
 */
export function patchRetryPredicate(prototype: any = (AgentSession as any)?.prototype): RetryPredicateOutcome {
  if (!prototype || typeof prototype._isRetryableError !== "function") {
    getLogger().warn({ s: "retry" }, "pi's retry predicate is not where it was; 499 will not be retried");
    return "absent";
  }
  if (prototype[PATCHED]) return "already";
  const original = prototype._isRetryableError;
  prototype._isRetryableError = function (message: any): boolean {
    if (message?.stopReason === "error" && isRequestTooLargeError(message?.errorMessage)) {
      // Armed whoever ends up answering: the guard has to know the last prompt
      // was refused for its size even on the reading where pi would have
      // retried anyway, or the retry resends what was just rejected.
      const recoverable = noteOversizedRequest(this);
      getLogger().debug({ s: "retry", recoverable }, "the provider refused a request for its size");
      if (recoverable) return true;
    }
    if (original.call(this, message)) return true;
    return message?.stopReason === "error" && isUnrecognizedTransportError(message?.errorMessage);
  };
  prototype[PATCHED] = true;
  getLogger().debug({ s: "retry" }, "widened pi's retry predicate to cover 499 and an oversized request");
  return "patched";
}
