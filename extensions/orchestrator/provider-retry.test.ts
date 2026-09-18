import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureProviderRetrySettings, isUnrecognizedTransportError, patchRetryPredicate, readProviderRetry } from "./provider-retry.js";

describe("provider retry settings", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pp-retry-"));
    path = join(dir, "settings.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("raises the ceiling when pi has no retry settings of its own", () => {
    expect(ensureProviderRetrySettings(path)).toBe("written");

    const written = readProviderRetry(path);
    expect(written.maxRetries).toBeGreaterThan(3);
    expect(written.maxRetryDelayMs).toBeGreaterThan(60_000);
  });

  it("leaves a count the user chose alone, however low", () => {
    writeFileSync(path, JSON.stringify({ retry: { provider: { maxRetries: 1 } } }), "utf-8");

    expect(ensureProviderRetrySettings(path)).toBe("present");
    expect(readProviderRetry(path).maxRetries).toBe(1);
  });

  it("keeps the rest of pi's settings intact", () => {
    writeFileSync(path, JSON.stringify({ packages: ["./pi-pi"], hideThinkingBlock: true }), "utf-8");

    ensureProviderRetrySettings(path);

    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.packages).toEqual(["./pi-pi"]);
    expect(raw.hideThinkingBlock).toBe(true);
    expect(raw.retry.provider.maxRetries).toBeGreaterThan(3);
  });

  it("reports nothing to read as no settings rather than failing", () => {
    expect(readProviderRetry(join(dir, "absent.json"))).toEqual({});
  });
});

// pi decides retryability from the provider's error text against a fixed list
// of statuses. 499 is in none of them, so a turn that died to a closed
// connection stayed dead where a 500 would have been retried eight times.
describe("pi's retry predicate", () => {
  const pi = (answer: boolean) => ({ _isRetryableError: () => answer });

  it("retries a 499 pi would have given up on", () => {
    const prototype: any = pi(false);
    expect(patchRetryPredicate(prototype)).toBe("patched");

    expect(prototype._isRetryableError({ stopReason: "error", errorMessage: "499 status code (no body)" })).toBe(true);
  });

  it("leaves pi's own answer alone, either way", () => {
    const widened: any = pi(true);
    const refused: any = pi(false);
    patchRetryPredicate(widened);
    patchRetryPredicate(refused);

    expect(widened._isRetryableError({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true);
    expect(refused._isRetryableError({ stopReason: "error", errorMessage: "400 bad request" })).toBe(false);
  });

  // The turn the user stopped is marked aborted, not error, and must not come
  // back to life however the gateway described the closed connection.
  it("does not revive an aborted turn", () => {
    const prototype: any = pi(false);
    patchRetryPredicate(prototype);

    expect(prototype._isRetryableError({ stopReason: "aborted", errorMessage: "499 status code (no body)" })).toBe(false);
  });

  it("wraps pi's predicate once, however many sessions start", () => {
    const prototype: any = pi(false);

    expect(patchRetryPredicate(prototype)).toBe("patched");
    expect(patchRetryPredicate(prototype)).toBe("already");
  });

  it("reports a predicate that is no longer there rather than throwing", () => {
    expect(patchRetryPredicate({})).toBe("absent");
  });

  it("recognizes the status wherever the provider put it in the text", () => {
    expect(isUnrecognizedTransportError("499 status code (no body)")).toBe(true);
    expect(isUnrecognizedTransportError("Request failed with status 499")).toBe(true);
    expect(isUnrecognizedTransportError("4990 tokens over the limit")).toBe(false);
    expect(isUnrecognizedTransportError(undefined)).toBe(false);
  });
});
