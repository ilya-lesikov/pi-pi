import { describe, expect, it } from "vitest";
import { injectBillingHeader, buildUserAgent, registerBillingHook, CC_VERSION, CC_ENTRYPOINT } from "./billing-spoof.js";

const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function claudePayload(system: Array<{ type: string; text: string }>) {
  return {
    model: "sub/claude-opus-4-8",
    system,
    messages: [{ role: "user", content: "hello world this is the first user message" }],
  };
}

describe("buildUserAgent", () => {
  it("produces the full-form claude-cli user agent matching cc_version", () => {
    expect(buildUserAgent()).toBe(`claude-cli/${CC_VERSION} (external, ${CC_ENTRYPOINT})`);
  });
});

describe("injectBillingHeader", () => {
  it("prepends the billing header as system[0] for an OAuth-stealth Claude payload", () => {
    const payload = claudePayload([{ type: "text", text: CC_IDENTITY }]);
    const ok = injectBillingHeader(payload);
    expect(ok).toBe(true);
    expect(payload.system[0].text.startsWith("x-anthropic-billing-header:")).toBe(true);
    expect(payload.system[0].text).toContain(`cc_version=${CC_VERSION}.`);
    expect(payload.system[0].text).toContain(`cc_entrypoint=${CC_ENTRYPOINT}`);
    expect(payload.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    // Identity block is preserved right after (no relocation of other system content).
    expect(payload.system[1].text).toBe(CC_IDENTITY);
  });

  it("is idempotent (does not double-inject)", () => {
    const payload = claudePayload([{ type: "text", text: CC_IDENTITY }]);
    injectBillingHeader(payload);
    const before = JSON.stringify(payload.system);
    const second = injectBillingHeader(payload);
    expect(second).toBe(false);
    expect(JSON.stringify(payload.system)).toBe(before);
  });

  it("does NOT touch a payload without the Claude Code identity block (plain API key)", () => {
    const payload = claudePayload([{ type: "text", text: "some third-party system prompt" }]);
    expect(injectBillingHeader(payload)).toBe(false);
    expect(payload.system[0].text).toBe("some third-party system prompt");
  });

  it("does NOT touch a non-Claude payload", () => {
    const payload = { model: "openai/gpt-latest", system: [{ type: "text", text: CC_IDENTITY }], messages: [{ role: "user", content: "hi" }] };
    expect(injectBillingHeader(payload)).toBe(false);
  });

  it("leaves the rest of the system prompt in place (no relocation)", () => {
    const payload = claudePayload([
      { type: "text", text: CC_IDENTITY },
      { type: "text", text: "pi-pi phase constraints block" },
    ]);
    injectBillingHeader(payload);
    expect(payload.system.map((s) => s.text)).toEqual([
      expect.stringContaining("x-anthropic-billing-header:"),
      CC_IDENTITY,
      "pi-pi phase constraints block",
    ]);
    // First user message content unchanged (cch computed on it as-is).
    expect(payload.messages[0].content).toBe("hello world this is the first user message");
  });
});

describe("registerBillingHook", () => {
  function fakePi() {
    let handler: ((event: any) => Promise<any>) | undefined;
    return {
      on: (name: string, fn: (event: any) => Promise<any>) => { if (name === "before_provider_request") handler = fn; },
      fire: (payload: any) => handler!({ payload }),
      registered: () => handler !== undefined,
    };
  }

  it("registers a before_provider_request hook that injects the billing block for sub/Claude payloads", async () => {
    const pi = fakePi();
    registerBillingHook(pi as any);
    expect(pi.registered()).toBe(true);
    const payload = claudePayload([{ type: "text", text: CC_IDENTITY }]);
    await pi.fire(payload);
    expect(payload.system[0].text).toMatch(/^x-anthropic-billing-header:/);
  });

  it("leaves non-Claude / non-identity payloads untouched", async () => {
    const pi = fakePi();
    registerBillingHook(pi as any);
    // No CC identity block -> gate fails, untouched.
    const noIdentity = { model: "sub/claude-opus-4-8", system: [{ type: "text", text: "other" }], messages: [{ role: "user", content: "hi" }] };
    await pi.fire(noIdentity);
    expect(noIdentity.system[0].text).toBe("other");
    // Non-Claude model -> untouched.
    const nonClaude = { model: "openai/gpt-x", system: [{ type: "text", text: CC_IDENTITY }], messages: [{ role: "user", content: "hi" }] };
    await pi.fire(nonClaude);
    expect(nonClaude.system[0].text).toBe(CC_IDENTITY);
  });
});
