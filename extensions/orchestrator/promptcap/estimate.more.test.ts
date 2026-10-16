import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_TOKENS, Estimator, danglingSignatureBytes, fixedBytes, messagesBytes, toolCallBytes } from "./estimate.js";

describe("Estimator", () => {
  it("returns the raw estimate until a model has a learned ratio", () => {
    const estimator = new Estimator();
    const messages = [{ role: "user", content: "x".repeat(400) }];
    expect(estimator.tokens(messages, 0, "m")).toBe(100);
    estimator.observe("m", 100, 200);
    expect(estimator.tokens(messages, 0, "m")).toBe(200);
  });

  it("ignores readings without a model key or with non-positive counts", () => {
    const estimator = new Estimator();
    estimator.observe("", 1, 1);
    estimator.observe("m", 0, 1);
    estimator.observe("m", 1, 0);
    expect(estimator.snapshot()).toEqual({});
  });

  it("restores only positive ratios for models not yet observed", () => {
    const estimator = new Estimator();
    estimator.observe("live", 100, 150);
    estimator.restore({ live: 9, seeded: 2, zero: 0, junk: "x" as any });
    expect(estimator.snapshot()).toEqual({ live: 1.5, seeded: 2 });
    expect(estimator.ratioFor("seeded")).toBe(2);
  });
});

describe("byte accounting", () => {
  it("counts tools by their JSON and skips ones that cannot be serialised", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(fixedBytes("ab", [{ a: 1 }, cyclic, undefined])).toBe(2 + 7);
    expect(fixedBytes(undefined, undefined)).toBe(0);
  });

  it("charges images a flat cost and ignores unknown parts and non-objects", () => {
    const messages = [
      null as any,
      { role: "user", content: [{ type: "image", data: "x".repeat(1_000_000) }, { type: "audio" }, null] },
      { role: "toolResult", toolName: "t", toolCallId: "id", content: [{ type: "text", text: "abc" }] },
      { role: "toolResult" },
      { role: "assistant" },
    ];
    expect(messagesBytes(messages)).toBe(DEFAULT_IMAGE_TOKENS * 4 + 1 + 2 + 3);
    expect(messagesBytes(messages, 10)).toBe(40 + 6);
  });

  it("counts a tool call with no arguments by its envelope", () => {
    expect(toolCallBytes({})).toBe(toolCallBytes({ name: "", id: "" }));
    expect(toolCallBytes({ arguments: {} }) - toolCallBytes({})).toBe(2);
  });

  it("reports signatures of empty, unredacted thinking blocks only", () => {
    const messages = [
      { content: "s" },
      { content: [{ type: "thinking", thinking: " ", thinkingSignature: "abcd" }, { type: "thinking", thinking: "real", thinkingSignature: "zz" }, { type: "thinking", redacted: true, thinkingSignature: "rr" }, { type: "thinking" }] },
    ];
    expect(danglingSignatureBytes(messages)).toBe(4);
  });
});
