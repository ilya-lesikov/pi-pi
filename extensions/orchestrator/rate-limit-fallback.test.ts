import { describe, expect, it } from "vitest";
import { isRateLimitError, isExtraUsageError, isSdkRetryableError } from "./rate-limit-fallback.js";
import { isSubscriptionRouted } from "./usage-tracker.js";
import { SUB_MODEL_PREFIX, SUB_PROVIDER, subProbeModelId } from "./flant-infra.js";

describe("isRateLimitError", () => {
  it("matches 429 and rate-limit phrasings", () => {
    expect(isRateLimitError("Error 429: too many requests")).toBe(true);
    expect(isRateLimitError("rate_limit_error")).toBe(true);
    expect(isRateLimitError("This request would exceed your account's rate limit")).toBe(true);
    expect(isRateLimitError("Rate Limit reached")).toBe(true);
    expect(isRateLimitError("Too Many Requests")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isRateLimitError("Anthropic stream ended before message_stop")).toBe(false);
    expect(isRateLimitError("500 internal server error")).toBe(false);
    expect(isRateLimitError("")).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("does not match the 400 extra-usage message (kept separate from 429)", () => {
    expect(isRateLimitError("Third-party apps now draw from extra usage, not plan limits")).toBe(false);
  });
});

describe("isExtraUsageError", () => {
  it("matches the subscription 400 extra-usage phrasing", () => {
    expect(isExtraUsageError("400 Third-party apps now draw from extra usage, not plan limits")).toBe(true);
    expect(isExtraUsageError("you are out of extra usage")).toBe(true);
    expect(isExtraUsageError("requests now draw from your extra usage balance")).toBe(true);
  });

  it("does not match 429 or unrelated errors (no over-match)", () => {
    expect(isExtraUsageError("Error 429: too many requests")).toBe(false);
    expect(isExtraUsageError("500 internal server error")).toBe(false);
    expect(isExtraUsageError("")).toBe(false);
    expect(isExtraUsageError(undefined)).toBe(false);
  });
});

describe("isSdkRetryableError", () => {
  it("matches the same error classes the SDK auto-retries", () => {
    // These are exactly the errors the user hit; the SDK retries them itself,
    // so pi-pi must NOT double-retry.
    expect(isSdkRetryableError("Anthropic stream ended before message_stop")).toBe(true);
    expect(isSdkRetryableError("429 rate_limit_error")).toBe(true);
    expect(isSdkRetryableError("overloaded_error")).toBe(true);
    expect(isSdkRetryableError("503 service unavailable")).toBe(true);
    expect(isSdkRetryableError("fetch failed")).toBe(true);
    expect(isSdkRetryableError("request timed out")).toBe(true);
  });

  it("does not match non-retryable errors", () => {
    expect(isSdkRetryableError("invalid request: bad tool arguments")).toBe(false);
    expect(isSdkRetryableError("")).toBe(false);
    expect(isSdkRetryableError(undefined)).toBe(false);
  });

  it("the common rate-limit phrasings are both rate-limit AND SDK-retryable", () => {
    // The sub-429 interception (isRateLimitError) runs BEFORE the SDK-defer
    // branch (isSdkRetryableError); the phrasings the gateway actually emits
    // must be recognised by both so a sub-429 is intercepted and any other
    // rate-limit is deferred to the SDK rather than double-retried by pi-pi.
    for (const m of ["429", "rate limit", "rate_limit_error", "too many requests"]) {
      expect(isRateLimitError(m)).toBe(true);
      expect(isSdkRetryableError(m)).toBe(true);
    }
    // The gateway's account-limit phrasing is a rate limit; the SDK regex does
    // not include that exact phrase, so pi-pi's sub-429 interception (which runs
    // first) is what handles it — by design.
    expect(isRateLimitError("exceed your account")).toBe(true);
  });
});

describe("isSubscriptionRouted", () => {
  it("detects the subscription provider", () => {
    expect(isSubscriptionRouted("claude-opus-4-8", SUB_PROVIDER)).toBe(true);
  });

  it("detects the sub/ model prefix", () => {
    expect(isSubscriptionRouted(`${SUB_MODEL_PREFIX}claude-opus-4-8`)).toBe(true);
  });

  it("detects a full provider-prefixed spec passed as a single id", () => {
    expect(isSubscriptionRouted(`${SUB_PROVIDER}/${SUB_MODEL_PREFIX}claude-opus-4-8`)).toBe(true);
  });

  it("returns false for regular flant Claude", () => {
    expect(isSubscriptionRouted("claude-opus-4-8", "pp-flant-anthropic")).toBe(false);
    expect(isSubscriptionRouted("pp-flant-anthropic/claude-opus-4-8")).toBe(false);
  });

  it("returns false with no signal", () => {
    expect(isSubscriptionRouted(undefined, undefined)).toBe(false);
  });
});

describe("subProbeModelId", () => {
  it("derives sub/<m> from a provider-prefixed spec", () => {
    expect(subProbeModelId(`${SUB_PROVIDER}/${SUB_MODEL_PREFIX}claude-opus-4-8`)).toBe(`${SUB_MODEL_PREFIX}claude-opus-4-8`);
  });

  it("keeps a bare sub/<m> spec", () => {
    expect(subProbeModelId(`${SUB_MODEL_PREFIX}claude-haiku-4-5`)).toBe(`${SUB_MODEL_PREFIX}claude-haiku-4-5`);
  });

  it("adds sub/ to a plain claude id", () => {
    expect(subProbeModelId("claude-opus-4-8")).toBe(`${SUB_MODEL_PREFIX}claude-opus-4-8`);
  });

  it("never double-prefixes the provider", () => {
    const out = subProbeModelId(`${SUB_PROVIDER}/${SUB_MODEL_PREFIX}claude-opus-4-8`);
    expect(out).not.toContain(SUB_PROVIDER);
    expect(out.startsWith(`${SUB_MODEL_PREFIX}${SUB_MODEL_PREFIX}`)).toBe(false);
  });
});
