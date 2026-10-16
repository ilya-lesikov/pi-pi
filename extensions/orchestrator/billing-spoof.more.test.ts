import { describe, expect, it, vi } from "vitest";
import { BILLING_PREFIX, CC_IDENTITY, injectBillingHeader, registerBillingHook } from "./billing-spoof.js";

function payload(messages: unknown, system: unknown = [{ type: "text", text: CC_IDENTITY }]): any {
  return { model: "claude-opus", system, messages };
}

function cch(p: any): string {
  return /cch=([0-9a-f]+);/.exec(p.system[0].text)![1];
}

describe("billing header hashing input", () => {
  it("hashes the first user message's first text block, whatever its shape", () => {
    const asString = payload([{ role: "assistant", content: "ignored" }, { role: "user", content: "hello world" }]);
    const asBlocks = payload([{ role: "user", content: [{ type: "image" }, { type: "text", text: "hello world" }] }]);
    expect(injectBillingHeader(asString)).toBe(true);
    expect(injectBillingHeader(asBlocks)).toBe(true);
    expect(cch(asString)).toBe(cch(asBlocks));
  });

  it("hashes empty text when there is no user text to hash", () => {
    const none = payload([{ role: "assistant", content: "x" }]);
    const imageOnly = payload([{ role: "user", content: [{ type: "image" }] }]);
    const otherContent = payload([{ role: "user", content: 42 }]);
    for (const p of [none, imageOnly, otherContent]) injectBillingHeader(p);
    expect(new Set([cch(none), cch(imageOnly), cch(otherContent)]).size).toBe(1);
  });

  it("recognizes the identity block given as a bare string entry", () => {
    const p = payload([{ role: "user", content: "x" }], [CC_IDENTITY]);
    expect(injectBillingHeader(p)).toBe(true);
    expect(p.system[0].text.startsWith(BILLING_PREFIX)).toBe(true);
    expect(p.system[1]).toBe(CC_IDENTITY);
  });

  it("refuses payloads that are not objects, lack messages, or lack a system list", () => {
    expect(injectBillingHeader(null)).toBe(false);
    expect(injectBillingHeader("claude")).toBe(false);
    expect(injectBillingHeader({ model: "claude-x", system: [{ text: CC_IDENTITY }] })).toBe(false);
    expect(injectBillingHeader({ model: "claude-x", system: "x", messages: [] })).toBe(false);
    expect(injectBillingHeader(payload([], [{ text: 5 }, null]))).toBe(false);
  });
});

describe("registerBillingHook", () => {
  it("reports a failed injection and still returns the payload", async () => {
    let handler: any;
    const pi: any = { on: (_name: string, fn: any) => { handler = fn; } };
    const log = vi.fn();
    registerBillingHook(pi, log);
    const hostile: any = { model: "claude-x", system: [{ text: CC_IDENTITY }] };
    Object.defineProperty(hostile, "messages", { get: () => { throw new Error("boom"); } });
    expect(await handler({ payload: hostile })).toBe(hostile);
    expect(log).toHaveBeenCalledWith("billing header injection failed", expect.objectContaining({ message: "boom" }));
  });
});
