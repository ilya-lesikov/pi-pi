import { describe, it, expect, vi } from "vitest";
import { PromptGuard, registerPromptGuard, modelKeyOf } from "./guard.js";
import { DEFAULT_HEADROOM_TOKENS, type PromptcapSettings } from "./limits.js";
import type { AgentMessage } from "./fold.js";

const settings = (over: Partial<PromptcapSettings> = {}): PromptcapSettings => ({
  enabled: true,
  perModel: {},
  ...over,
});

const conversation = (n: number, size: number): AgentMessage[] => {
  const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `/f${i}` } }] });
    messages.push({ role: "toolResult", toolCallId: `t${i}`, toolName: "read", content: [{ type: "text", text: "o".repeat(size) }], isError: false });
  }
  return messages;
};

const ctx = (window?: number) => ({
  model: { provider: "anthropic", id: "claude-opus-4-8" },
  getSystemPrompt: () => "system",
  getContextUsage: () => (window ? { tokens: null, contextWindow: window, percent: null } : undefined),
});

describe("PromptGuard", () => {
  it("leaves the conversation alone when folding is disabled", () => {
    const guard = new PromptGuard({ settings: () => settings({ enabled: false }) });
    const messages = conversation(40, 8000);
    const before = JSON.parse(JSON.stringify(messages));

    expect(guard.apply(messages, ctx(200_000), [])).toEqual(before);
    expect(guard.lastTokens).toBeNull();
  });

  it("folds a conversation that outgrew the declared ceiling", () => {
    const guard = new PromptGuard({ settings: () => settings({ maxPromptTokens: 5_000 }) });
    const messages = conversation(40, 8000);

    guard.apply(messages, ctx(), []);

    expect(guard.lastTokens!).toBeLessThanOrEqual(5_000);
    expect(messages[2].content[0].text).toMatch(/^\[omitted: 8000B; t0\]$/);
  });

  it("warns once the conversation cannot be made to fit", () => {
    const notify = vi.fn();
    const guard = new PromptGuard({ settings: () => settings({ maxPromptTokens: 1_000 }), notify });
    // Prose alone overflows, and prose is never folded.
    guard.apply([{ role: "user", content: [{ type: "text", text: "p".repeat(400_000) }] }], ctx(), []);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer fits"), "warning");
  });

  it("does not warn when folding brought the prompt back under the ceiling", () => {
    const notify = vi.fn();
    const guard = new PromptGuard({ settings: () => settings({ maxPromptTokens: 5_000 }), notify });
    guard.apply(conversation(40, 8000), ctx(), []);

    expect(notify).not.toHaveBeenCalled();
  });

  it("uses the window the host reports when none is declared", () => {
    const guard = new PromptGuard({ settings: () => settings() });
    guard.apply(conversation(2, 100), ctx(1_000_000), []);

    // The headroom above the prose that cannot be folded, which a reported
    // window is enough to unlock: without one the ceiling would stay at the
    // configured default.
    expect(guard.lastCeiling!).toBeGreaterThanOrEqual(DEFAULT_HEADROOM_TOKENS);
    expect(guard.lastCeiling!).toBeLessThan(DEFAULT_HEADROOM_TOKENS + 1_000);
  });

  it("reports what signature-only reasoning blocks weighed against what was charged", () => {
    const log = vi.fn();
    const guard = new PromptGuard({ settings: () => settings(), log });
    const messages = conversation(2, 100);
    // A reasoning block as the subscription gateway leaves them: a signature
    // and no text. Whether the adapter sends it is what the log settles.
    messages.splice(1, 0, {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinkingSignature: "s".repeat(4000) }],
    });
    guard.apply(messages, ctx(1_000_000), []);

    guard.calibrate(12_345, "anthropic/claude-opus-4-8");

    const reported = log.mock.calls.find(([event]) => (event as any).danglingSignatures > 0);
    expect(reported).toBeDefined();
    const [event] = reported!;
    expect((event as any).charged).toBe(12_345);
    expect((event as any).danglingSignatures).toBe(1000);
    expect((event as any).predictedWithout).toBe((event as any).predicted - 1000);
  });

  it("says nothing about signatures when there are none to explain", () => {
    const log = vi.fn();
    const guard = new PromptGuard({ settings: () => settings(), log });
    guard.apply(conversation(2, 100), ctx(1_000_000), []);

    guard.calibrate(999, "anthropic/claude-opus-4-8");

    expect(log.mock.calls.some(([event]) => (event as any).danglingSignatures !== undefined)).toBe(false);
  });

  it("learns the ratio from what the provider charged", () => {
    const guard = new PromptGuard({ settings: () => settings() });
    guard.apply(conversation(2, 4000), ctx(), []);
    const predicted = guard.lastTokens!;

    guard.calibrate(predicted * 2, "anthropic/claude-opus-4-8");

    expect(guard.ratioFor("anthropic/claude-opus-4-8")).toBeCloseTo(2, 3);
  });

  it("ignores a charge from a model other than the one it sized for", () => {
    const guard = new PromptGuard({ settings: () => settings() });
    guard.apply(conversation(2, 4000), ctx(), []);
    guard.calibrate(999_999, "github-copilot/gpt-5.6-sol");

    expect(guard.ratioFor("github-copilot/gpt-5.6-sol")).toBeUndefined();
    expect(guard.ratioFor("anthropic/claude-opus-4-8")).toBeUndefined();
  });

  it("forgets its folds on reset, so a new session starts whole", () => {
    const guard = new PromptGuard({ settings: () => settings({ maxPromptTokens: 100 }) });
    guard.apply(conversation(10, 8000), ctx(), []);
    guard.reset();

    const fresh = conversation(2, 100);
    guard.apply(fresh, ctx(), []);

    expect(fresh[2].content[0].text).toBe("o".repeat(100));
  });
});

describe("registerPromptGuard", () => {
  const harness = () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: (event: string, handler: Function) => handlers.set(event, handler),
      getAllTools: () => [{ name: "read", description: "d", parameters: {} }],
      getActiveTools: () => ["read"],
    } as any;
    return { handlers, pi };
  };

  it("returns folded messages from the context event", () => {
    const { handlers, pi } = harness();
    registerPromptGuard(pi, new PromptGuard({ settings: () => settings({ maxPromptTokens: 5_000 }) }));

    const messages = conversation(40, 8000);
    const out = handlers.get("context")!({ messages }, ctx());

    expect(out.messages).toBe(messages);
    expect(out.messages[2].content[0].text).toMatch(/^\[omitted: /);
  });

  it("ignores a context event without a message array", () => {
    const { handlers, pi } = harness();
    registerPromptGuard(pi, new PromptGuard({ settings: () => settings() }));

    expect(handlers.get("context")!({}, ctx())).toBeUndefined();
  });

  it("calibrates from the whole prompt, cache included", () => {
    const { handlers, pi } = harness();
    const guard = new PromptGuard({ settings: () => settings() });
    registerPromptGuard(pi, guard);

    handlers.get("context")!({ messages: conversation(2, 4000) }, ctx());
    const predicted = guard.lastTokens!;
    handlers.get("turn_end")!({ message: { usage: { input: 1, cacheRead: predicted * 2 - 2, cacheWrite: 1, output: 5 } } }, ctx());

    expect(guard.ratioFor("anthropic/claude-opus-4-8")).toBeCloseTo(2, 3);
  });
});

describe("modelKeyOf", () => {
  it("prefers the full spec and falls back to the bare id", () => {
    expect(modelKeyOf({ model: { provider: "p", id: "m" } })).toBe("p/m");
    expect(modelKeyOf({ model: { id: "m" } })).toBe("m");
    expect(modelKeyOf({})).toBe("");
  });
});
