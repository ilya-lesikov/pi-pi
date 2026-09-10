import { describe, it, expect } from "vitest";
import { fold, FoldState, Tier, incompressibleTokens, cutBytes, cutBytesFromEnd, type AgentMessage } from "./fold.js";
import { byteLength, Estimator, fixedBytes, messagesBytes } from "./estimate.js";
import { limitsFor, DEFAULT_KEEP_FRACTION, DEFAULT_HEADROOM_TOKENS, DEFAULT_MAX_PROMPT_TOKENS, type PromptcapSettings } from "./limits.js";

const call = (id: string, name: string, args: Record<string, unknown>, thinking?: string): AgentMessage => ({
  role: "assistant",
  content: [
    ...(thinking ? [{ type: "thinking", thinking, thinkingSignature: "sig" }] : []),
    { type: "toolCall", id, name, arguments: args },
  ],
});

const result = (id: string, name: string, text: string, isError = false): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const prose = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] });

/** A conversation of `n` answered calls, each carrying a `size`-byte result. */
const conversation = (n: number, size: number): AgentMessage[] => {
  const messages: AgentMessage[] = [user("go")];
  for (let i = 0; i < n; i++) {
    messages.push(call(`t${i}`, "read", { path: `/f${i}`, body: "x".repeat(300) }, `thought ${i}`));
    messages.push(result(`t${i}`, "read", "o".repeat(size)));
  }
  return messages;
};

const settings = (over: Partial<PromptcapSettings> = {}): PromptcapSettings => ({
  enabled: true,
  perModel: {},
  ...over,
});

describe("fold", () => {
  it("leaves a prompt under the ceiling untouched", () => {
    const messages = conversation(3, 400);
    const before = JSON.parse(JSON.stringify(messages));
    const out = fold(messages, 0, { ceiling: 1_000_000, lowWater: 500_000 }, new FoldState());
    expect(messages).toEqual(before);
    expect(out.folded).toBe(0);
  });

  it("digests the oldest calls first and stops at the low-water mark", () => {
    const messages = conversation(10, 4000);
    const total = Math.floor(messagesBytes(messages) / 4);
    const out = fold(messages, 0, { ceiling: Math.floor(total * 0.6), lowWater: Math.floor(total * 0.4) }, new FoldState());

    expect(out.tokens).toBeLessThanOrEqual(Math.floor(total * 0.4));
    // The newest call keeps its output; the oldest does not.
    expect(messages[2].content[0].text).toMatch(/^\[omitted: 4000B; t0\]$/);
    expect(messages[20].content[0].text).toBe("o".repeat(4000));
  });

  it("caps a digested call's arguments per value, keeping every key", () => {
    const messages = [user("go"), call("t0", "write", { path: "/a", body: "y".repeat(5000) }), result("t0", "write", "ok")];
    const state = new FoldState();
    fold(messages, 0, { ceiling: 1000, lowWater: 200 }, state);

    expect(state.tierOf("t0")).toBe(Tier.Digest);
    const args = messages[1].content[0].arguments;
    expect(Object.keys(args).sort()).toEqual(["body", "path"]);
    expect(args.path).toBe("/a");
    expect(byteLength(args.body)).toBeLessThan(300);
    expect(args.body).toMatch(/…\[\+4800B\]$/);
  });

  it("caps a list argument by element count before bytes", () => {
    const messages = [
      user("go"),
      call("t0", "grep", { files: ["a", "b", "c", "d", "e", "f", "g"] }),
      result("t0", "grep", "o".repeat(4000)),
    ];
    const state = new FoldState();
    fold(messages, 0, { ceiling: 1000, lowWater: 900 }, state);

    expect(state.tierOf("t0")).toBe(Tier.Digest);
    expect(messages[1].content[0].arguments.files).toEqual(["a", "b", "c", "d", "e", "…[+2]"]);
  });

  it("keeps both ends of a digested error", () => {
    const failure = "HEAD".padEnd(1200, "-") + "TAIL".padStart(600, "-");
    const messages = [user("go"), call("t0", "bash", { cmd: "make" }), result("t0", "bash", failure, true)];
    const state = new FoldState();

    fold(messages, 0, { ceiling: 420, lowWater: 390 }, state);

    expect(state.tierOf("t0")).toBe(Tier.Digest);
    const digested = messages[2].content[0].text;
    expect(digested.startsWith("HEAD")).toBe(true);
    expect(digested.endsWith("TAIL")).toBe(true);
    expect(digested).toContain("[omitted: 300B; t0]");
  });

  it("drops an error's text entirely at breadcrumb", () => {
    const failure = "HEAD".padEnd(1200, "-") + "TAIL".padStart(600, "-");
    const messages = [user("go"), call("t0", "bash", { cmd: "make" }), result("t0", "bash", failure, true)];
    const state = new FoldState();

    fold(messages, 0, { ceiling: 10, lowWater: 5 }, state);

    expect(state.tierOf("t0")).toBe(Tier.Breadcrumb);
    expect(messages[2].content[0].text).toBe("[omitted: 1800B; t0]");
  });

  it("never touches user or assistant prose, even when it alone overflows", () => {
    const long = "p".repeat(40_000);
    const messages = [user(long), prose(long), call("t0", "read", { p: "/a" }), result("t0", "read", "o".repeat(100))];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[0].content[0].text).toBe(long);
    expect(messages[1].content[0].text).toBe(long);
  });

  it("never folds a call still awaiting its result", () => {
    const messages = [...conversation(6, 4000), call("pending", "bash", { cmd: "sleep 1" })];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[messages.length - 1].content[0].arguments).toEqual({ cmd: "sleep 1" });
  });

  it("drops thinking that belongs to a folded call but not after the last user message", () => {
    const messages = [
      user("first"),
      call("t0", "read", { p: "/a" }, "old reasoning"),
      result("t0", "read", "o".repeat(9000)),
      user("second"),
      call("t1", "read", { p: "/b" }, "fresh reasoning"),
      result("t1", "read", "o".repeat(9000)),
    ];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[1].content[0].thinking).toBe("");
    expect(messages[4].content[0].thinking).toBe("fresh reasoning");
  });

  it("keeps redacted thinking intact", () => {
    const messages = [
      user("go"),
      { role: "assistant", content: [
        { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
        { type: "toolCall", id: "t0", name: "read", arguments: { p: "/a" } },
      ] },
      result("t0", "read", "o".repeat(9000)),
    ];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[1].content[0].thinking).toBe("[Reasoning redacted]");
  });

  it("is monotonic: a call folded once stays folded when the budget widens", () => {
    const state = new FoldState();
    const tight = conversation(10, 4000);
    fold(tight, 0, { ceiling: 100, lowWater: 50 }, state);
    expect(state.size).toBeGreaterThan(0);

    const roomy = conversation(10, 4000);
    const out = fold(roomy, 0, { ceiling: 10_000_000, lowWater: 5_000_000 }, state);

    expect(out.folded).toBe(10);
    expect(roomy[2].content[0].text).toMatch(/^\[omitted: 4000B; t0\]$/);
  });

  it("keeps the prefix byte-identical as the conversation grows", () => {
    const state = new FoldState();
    const first = conversation(10, 4000);
    fold(first, 0, { ceiling: 4000, lowWater: 2000 }, state);
    const prefix = JSON.stringify(first.slice(0, 11));

    const second = [...conversation(10, 4000).map((m) => JSON.parse(JSON.stringify(m)))];
    second.push(call("t10", "read", { path: "/f10" }), result("t10", "read", "o".repeat(4000)));
    fold(second, 0, { ceiling: 4000, lowWater: 2000 }, state);

    expect(JSON.stringify(second.slice(0, 11))).toBe(prefix);
  });

  it("reaches the incompressible floor and no further", () => {
    const messages = conversation(10, 4000);
    const floor = incompressibleTokens(messages, 0);
    const out = fold(messages, 0, { ceiling: 1, lowWater: 1 }, new FoldState());

    expect(out.tokens).toBe(floor);
  });

  it("scales the estimate by the calibration ratio", () => {
    const messages = conversation(4, 1000);
    const plain = fold([...messages.map((m) => JSON.parse(JSON.stringify(m)))], 0, { ceiling: 1e9, lowWater: 1e9 }, new FoldState());
    const scaled = fold(messages, 0, { ceiling: 1e9, lowWater: 1e9 }, new FoldState(), 2);

    expect(scaled.tokens).toBe(plain.tokens * 2);
  });

  it("counts an image result's payload in the notice it leaves behind", () => {
    const messages = [
      user("go"),
      call("t0", "read", { path: "/a.png" }),
      {
        role: "toolResult",
        toolCallId: "t0",
        toolName: "read",
        content: [{ type: "text", text: "1024x768" }, { type: "image", data: "b".repeat(40_000), mimeType: "image/png" }],
        isError: false,
      },
    ];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[2].content[0].text).toBe(`[omitted: ${40_000 + 8}B; t0]`);
  });

  it("never folds the newest load of a skill", () => {
    const messages = [
      user("go"),
      call("s0", "load_skill", { name: "repository-work" }),
      result("s0", "load_skill", "OLD skill text ".repeat(500)),
      call("s1", "load_skill", { name: "repository-work" }),
      result("s1", "load_skill", "NEW skill text ".repeat(500)),
      call("t0", "read", { path: "/a" }),
      result("t0", "read", "o".repeat(9000)),
    ];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[4].content[0].text).toBe("NEW skill text ".repeat(500));
    expect(messages[2].content[0].text).toMatch(/^\[omitted: /);
    expect(messages[6].content[0].text).toMatch(/^\[omitted: /);
  });

  it("pins each distinct skill separately", () => {
    const messages = [
      user("go"),
      call("s0", "load_skill", { name: "repository-work" }),
      result("s0", "load_skill", "repo skill ".repeat(500)),
      call("s1", "load_skill", { name: "software-engineering" }),
      result("s1", "load_skill", "eng skill ".repeat(500)),
    ];
    fold(messages, 0, { ceiling: 10, lowWater: 5 }, new FoldState());

    expect(messages[2].content[0].text).toBe("repo skill ".repeat(500));
    expect(messages[4].content[0].text).toBe("eng skill ".repeat(500));
  });
});

describe("cutBytes", () => {
  it("does not split a multi-byte character", () => {
    expect(cutBytes("привет", 5)).toBe("пр");
    expect(cutBytesFromEnd("привет", 5)).toBe("ет");
  });

  it("returns the whole string when it already fits", () => {
    expect(cutBytes("abc", 10)).toBe("abc");
    expect(cutBytesFromEnd("abc", 10)).toBe("abc");
  });
});

describe("Estimator", () => {
  it("counts bytes, not characters", () => {
    const cyrillic = [user("привет")];
    const latin = [user("privet")];
    expect(messagesBytes(cyrillic)).toBe(12);
    expect(messagesBytes(latin)).toBe(6);
  });

  it("counts the system prompt and the tool schemas", () => {
    expect(fixedBytes("hello", [{ name: "read" }])).toBe(5 + byteLength(JSON.stringify({ name: "read" })));
  });

  it("returns the raw estimate before any calibration", () => {
    const estimator = new Estimator();
    expect(estimator.tokens([user("x".repeat(400))], 0, "m")).toBe(100);
  });

  it("adopts the first reading whole and smooths later ones", () => {
    const estimator = new Estimator();
    estimator.observe("m", 100, 200);
    expect(estimator.ratioFor("m")).toBe(2);
    estimator.observe("m", 100, 100);
    expect(estimator.ratioFor("m")).toBeCloseTo(1.75, 5);
  });

  it("converges on what the provider really charges", () => {
    // Every reading is the raw estimate against a charge twice its size, which
    // is what the guard hands over. Feeding it a prediction the ratio had
    // already scaled would make each reading describe the last correction
    // instead, and settle the ratio at the square root of the truth.
    const estimator = new Estimator();
    for (let i = 0; i < 40; i++) estimator.observe("m", 1000, 2000);
    expect(estimator.ratioFor("m")).toBeCloseTo(2, 3);
  });

  it("ignores a reading with nothing to learn from", () => {
    const estimator = new Estimator();
    estimator.observe("m", 0, 100);
    estimator.observe("m", 100, 0);
    estimator.observe("", 100, 100);
    expect(estimator.ratioFor("m")).toBeUndefined();
  });
});

describe("thinking signatures", () => {
  it("counts a signature as foldable, so it does not sit in the floor", () => {
    // A signature is several times the size of the text it certifies, and the
    // adapter drops a block whose text is empty — so leaving it out of what
    // folding can reach put the larger half of every thought in the floor.
    const withSignature: AgentMessage[] = [
      user("go"),
      { role: "assistant", content: [
        { type: "thinking", thinking: "мысль", thinkingSignature: "s".repeat(8000) },
        { type: "toolCall", id: "t0", name: "read", arguments: { path: "/f" } },
      ]},
      result("t0", "read", "o".repeat(100)),
      user("дальше"),
    ];
    const bare: AgentMessage[] = JSON.parse(JSON.stringify(withSignature));
    (bare[1].content as any[])[0].thinkingSignature = "";

    const gap = incompressibleTokens(withSignature, 0, 1) - incompressibleTokens(bare, 0, 1);
    expect(gap).toBeLessThan(200);
  });

  it("drops the signature with the text it certifies", () => {
    const messages: AgentMessage[] = [
      user("go"),
      { role: "assistant", content: [
        { type: "thinking", thinking: "мысль", thinkingSignature: "s".repeat(8000) },
        { type: "toolCall", id: "t0", name: "read", arguments: { path: "/f" } },
      ]},
      result("t0", "read", "o".repeat(8000)),
      user("дальше"),
    ];

    fold(messages, 0, { ceiling: 100, lowWater: 50 }, new FoldState(), 1);

    const block = (messages[1].content as any[])[0];
    expect(block.thinking).toBe("");
    expect(block.thinkingSignature).toBe("");
  });

  it("leaves redacted reasoning alone, signature and all", () => {
    // There the signature is the payload the provider replays, not a
    // certificate attached to text.
    const messages: AgentMessage[] = [
      user("go"),
      { role: "assistant", content: [
        { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
        { type: "toolCall", id: "t0", name: "read", arguments: { path: "/f" } },
      ]},
      result("t0", "read", "o".repeat(8000)),
      user("дальше"),
    ];

    fold(messages, 0, { ceiling: 100, lowWater: 50 }, new FoldState(), 1);

    expect((messages[1].content as any[])[0].thinkingSignature).toBe("opaque");
  });
});

describe("limitsFor", () => {
  it("uses the default ceiling when no window is known", () => {
    const { ceiling, lowWater } = limitsFor(settings(), "some/model", 0);
    expect(ceiling).toBe(DEFAULT_MAX_PROMPT_TOKENS);
    expect(lowWater).toBe(Math.floor(DEFAULT_MAX_PROMPT_TOKENS * DEFAULT_KEEP_FRACTION));
  });

  it("leaves the configured ceiling alone when no window bounds the climb", () => {
    const { ceiling } = limitsFor(settings({ maxPromptTokens: 150_000 }), "m", 400_000);
    expect(ceiling).toBe(150_000);
  });

  it("climbs the ceiling with the incompressible floor when a window is known", () => {
    const roomy = limitsFor(settings(), "m", 0, 1_000_000);
    const grown = limitsFor(settings(), "m", 400_000, 1_000_000);
    expect(grown.ceiling).toBeGreaterThan(roomy.ceiling);
    expect(grown.ceiling).toBe(400_000 + DEFAULT_HEADROOM_TOKENS);
  });

  it("keeps the headroom absolute, so the window does not scale it", () => {
    const small = limitsFor(settings(), "m", 100_000, 400_000);
    const large = limitsFor(settings(), "m", 100_000, 1_000_000);
    expect(large.ceiling).toBe(100_000 + DEFAULT_HEADROOM_TOKENS);
    expect(small.ceiling).toBe(large.ceiling);
  });

  it("never lets the ceiling reach the window", () => {
    const { ceiling } = limitsFor(settings(), "m", 900_000, 200_000);
    expect(ceiling).toBe(200_000 - 40_000 - 10_000);
  });

  it("keeps a fixed share of the headroom per fold, whatever the prose", () => {
    for (const floor of [10_000, 100_000, 400_000]) {
      const { ceiling, lowWater } = limitsFor(settings(), "m", floor, 1_000_000);
      expect(lowWater - floor).toBe(Math.floor(DEFAULT_HEADROOM_TOKENS * DEFAULT_KEEP_FRACTION));
      expect(ceiling - lowWater).toBe(DEFAULT_HEADROOM_TOKENS - Math.floor(DEFAULT_HEADROOM_TOKENS * DEFAULT_KEEP_FRACTION));
    }
  });

  it("aims at the floor when the floor already sits above the ceiling", () => {
    const { ceiling, lowWater } = limitsFor(settings(), "m", 900_000, 200_000);
    expect(lowWater).toBe(900_000);
    expect(lowWater).toBeGreaterThan(ceiling);
  });

  it("honours a configured headroom and fold depth", () => {
    // The floor clears the default ceiling, so the configured headroom is what
    // decides where folding starts rather than that default.
    const { ceiling, lowWater } = limitsFor(settings({ headroomTokens: 60_000, keepFraction: 0.5 }), "m", 200_000, 1_000_000);
    expect(ceiling).toBe(260_000);
    expect(lowWater).toBe(230_000);
  });

  it("prefers a declared window over the one the host reports", () => {
    const declared = limitsFor(settings({ perModel: { m: { contextWindow: 1_000_000 } } }), "m", 0, 200_000);
    expect(declared.ceiling).toBe(DEFAULT_HEADROOM_TOKENS);
  });

  it("matches a per-model override on the bare id", () => {
    const { ceiling } = limitsFor(settings({ perModel: { "claude-opus-4-8": { maxPromptTokens: 42_000 } } }), "anthropic/claude-opus-4-8", 0);
    expect(ceiling).toBe(42_000);
  });
});
