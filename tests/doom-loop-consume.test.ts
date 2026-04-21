import { describe, it, expect } from "vitest";
import {
  createDoomLoopState,
  recordToolCall,
  consumeDoomLoopWarning,
} from "../src/doom-loop.js";

describe("consumeDoomLoopWarning — identical-tail", () => {
  it("returns a structured DoomLoopWarning object after 3 identical calls", () => {
    const state = createDoomLoopState();
    const input = { pattern: "addRoute", glob: "*.ts" };

    recordToolCall(state, "grep", "call-1", input);
    recordToolCall(state, "grep", "call-2", input);
    recordToolCall(state, "grep", "call-3", input);

    const warning = consumeDoomLoopWarning(state, "call-3");
    expect(warning).not.toBeNull();
    expect(warning).toMatchObject({
      kind: "identical-tail",
      toolName: "grep",
    });
    expect(typeof warning!.fingerprint).toBe("string");
    expect(warning!.fingerprint.length).toBeGreaterThan(0);
  });

  it("returns null when no loop was detected", () => {
    const state = createDoomLoopState();
    recordToolCall(state, "grep", "only", { pattern: "foo" });
    expect(consumeDoomLoopWarning(state, "only")).toBeNull();
  });
});

describe("consumeDoomLoopWarning — repeated-subsequence", () => {
  it("returns kind 'repeated-subsequence' with ordered steps when [A,B][A,B][A,B] detected", () => {
    const state = createDoomLoopState();
    const sequence = [
      { toolName: "grep", input: { pattern: "foo" } },
      { toolName: "read", input: { path: "src/bar.ts" } },
    ];

    let lastId = "";
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const [i, step] of sequence.entries()) {
        lastId = `r${repeat}-${i}`;
        recordToolCall(state, step.toolName, lastId, step.input);
      }
    }

    const warning = consumeDoomLoopWarning(state, lastId);
    expect(warning).not.toBeNull();
    if (warning === null) throw new Error("expected warning");
    expect(warning.kind).toBe("repeated-subsequence");
    if (warning.kind !== "repeated-subsequence") return;
    expect(warning.toolName).toBe("read");
    expect(warning.steps).toHaveLength(2);
    expect(warning.steps[0]).toEqual({ toolName: "grep", input: { pattern: "foo" } });
    expect(warning.steps[1]).toEqual({ toolName: "read", input: { path: "src/bar.ts" } });
  });
});

describe("consumeDoomLoopWarning — one-shot semantics", () => {
  it("returns the warning exactly once for a given toolCallId", () => {
    const state = createDoomLoopState();
    const input = { pattern: "x" };
    recordToolCall(state, "grep", "a", input);
    recordToolCall(state, "grep", "b", input);
    recordToolCall(state, "grep", "c", input);

    const first = consumeDoomLoopWarning(state, "c");
    const second = consumeDoomLoopWarning(state, "c");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
