import { describe, expect, it } from "vitest";
import { isRateLimitError } from "./rate-limit-fallback.js";
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
