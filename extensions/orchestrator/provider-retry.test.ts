import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureProviderRetrySettings, isRequestTooLargeError, isUnrecognizedTransportError, patchRetryPredicate, readProviderRetry } from "./provider-retry.js";
import { PromptGuard, registerPromptGuard } from "./promptcap/guard.js";

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

  it("recognizes a request refused for its size however the gateway worded it", () => {
    expect(isRequestTooLargeError("413 Request Entity Too Large")).toBe(true);
    expect(isRequestTooLargeError("Request body too large")).toBe(true);
    expect(isRequestTooLargeError('{"type":"request_too_large"}')).toBe(true);
    expect(isRequestTooLargeError("payload too large")).toBe(true);
    expect(isRequestTooLargeError("read 4130 bytes")).toBe(false);
    expect(isRequestTooLargeError("413 but the available balance is spent")).toBe(false);
    expect(isRequestTooLargeError(undefined)).toBe(false);
  });

  // A retry that resends what was just refused buys nothing, so this status is
  // retryable only when the guard that built the prompt can make it smaller.
  it("retries an oversized request only while there is an image left to drop", () => {
    const handlers = new Map<string, Function>();
    const sessionManager = {};
    const guard = new PromptGuard({ settings: () => ({ enabled: true, perModel: {} }) });
    registerPromptGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, guard);
    guard.apply(
      [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: { path: "/a.png" } }] },
        { role: "toolResult", toolCallId: "t0", toolName: "read", content: [{ type: "image", data: "i".repeat(9000), mimeType: "image/png" }], isError: false },
      ],
      { model: { provider: "anthropic", id: "m" }, getSystemPrompt: () => "s", sessionManager },
      [],
    );

    const prototype: any = { _isRetryableError: () => false, sessionManager };
    patchRetryPredicate(prototype);
    const refusal = { stopReason: "error", errorMessage: "413 Request body too large" };

    expect(prototype._isRetryableError(refusal)).toBe(true);
  });

  it("leaves an oversized request to fail when no guard folds for the session", () => {
    const prototype: any = { _isRetryableError: () => false, sessionManager: {} };
    patchRetryPredicate(prototype);

    expect(prototype._isRetryableError({ stopReason: "error", errorMessage: "413 Request body too large" })).toBe(false);
  });
});
