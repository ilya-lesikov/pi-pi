import { describe, expect, it, vi } from "vitest";
import { adjudicateContinuation, buildAdjudicationContext, parseAdjudication } from "./continuation-adjudicator.js";

function makePi(tools: Array<{ name: string; description: string; parameters: unknown }> = []): any {
  return {
    getAllTools: () => tools,
    getActiveTools: () => tools.map((tool) => tool.name),
  };
}

describe("continuation adjudication", () => {
  it("treats anything but a leading yes as no", () => {
    expect(parseAdjudication("YES")).toBe(true);
    expect(parseAdjudication("  yes.\n")).toBe(true);
    expect(parseAdjudication("**YES**")).toBe(true);
    expect(parseAdjudication("NO")).toBe(false);
    expect(parseAdjudication("")).toBe(false);
    // A hedged answer is not a mandate to restart work.
    expect(parseAdjudication("Probably yes")).toBe(false);
    expect(parseAdjudication("yesterday's run finished")).toBe(false);
  });

  // The replay only earns its prompt-cache hit if it reuses the prefix the turn
  // itself ran with, so system prompt, tools and history all have to come along.
  it("replays the turn's own prompt prefix with the question appended", () => {
    const pi = makePi([
      { name: "read", description: "read a file", parameters: { type: "object" } },
      { name: "retired", description: "not active", parameters: { type: "object" } },
    ]);
    pi.getActiveTools = () => ["read"];
    const contextMessages = [
      { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: 1 },
    ];
    const final = { role: "assistant", content: [{ type: "text", text: "Did part of it." }], timestamp: 2 };

    const context = buildAdjudicationContext(pi, { getSystemPrompt: () => "SYSTEM" }, contextMessages, final);

    expect(context.systemPrompt).toBe("SYSTEM");
    expect(context.tools).toEqual([{ name: "read", description: "read a file", parameters: { type: "object" } }]);
    expect(context.messages.slice(0, 2)).toEqual([contextMessages[0], final]);
    const question = context.messages[context.messages.length - 1];
    expect(question.role).toBe("user");
    expect(question.content[0].text).toContain("YES or NO");
  });

  it("answers no when the check cannot run or fails", async () => {
    const pi = makePi();
    await expect(adjudicateContinuation(pi, { model: { provider: "p", id: "m" } }, [], null)).resolves.toBe(false);
    await expect(adjudicateContinuation(pi, { modelRegistry: { complete: vi.fn() } }, [], null)).resolves.toBe(false);
    const failing = { model: { provider: "p", id: "m" }, modelRegistry: { complete: vi.fn(async () => { throw new Error("provider down"); }) } };
    await expect(adjudicateContinuation(pi, failing, [], null)).resolves.toBe(false);
  });

  it("reads the verdict off the completion", async () => {
    const pi = makePi();
    const ctx = (answer: string) => ({
      model: { provider: "p", id: "m" },
      getSystemPrompt: () => "SYSTEM",
      modelRegistry: { complete: vi.fn(async () => ({ content: [{ type: "text", text: answer }] })) },
    });
    await expect(adjudicateContinuation(pi, ctx("YES"), [], null)).resolves.toBe(true);
    await expect(adjudicateContinuation(pi, ctx("NO"), [], null)).resolves.toBe(false);
    // A tool call instead of a word is not an answer.
    const toolCall = {
      model: { provider: "p", id: "m" },
      modelRegistry: { complete: vi.fn(async () => ({ content: [{ type: "toolCall", name: "read", arguments: {} }] })) },
    };
    await expect(adjudicateContinuation(pi, toolCall, [], null)).resolves.toBe(false);
  });
});
