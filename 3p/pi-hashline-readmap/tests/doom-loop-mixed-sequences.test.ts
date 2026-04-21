import { describe, it, expect } from "vitest";
import init from "../index.js";

function createHarness() {
  const handlers: Record<string, Function> = {};

  init(
    {
      registerTool() {},
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
      events: { emit() {}, on() {} },
    } as any,
  );

  return handlers;
}

function makeToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    toolName,
    toolCallId,
    input,
  };
}

function makeToolResult(toolName: string, toolCallId: string, input: Record<string, unknown>, text: string) {
  return {
    type: "tool_result" as const,
    toolName,
    toolCallId,
    input,
    content: [{ type: "text" as const, text }],
    isError: false,
    details: undefined,
  };
}

describe("doom loop detection — mixed sequences", () => {
  it("does not warn for mixed sequences that are not three identical back-to-back repetitions", async () => {
    const handlers = createHarness();
    const sequence = [
      { toolName: "read", input: { path: "src/read.ts" }, text: "read-a" },
      { toolName: "grep", input: { pattern: "hashline", path: "src" }, text: "grep-b" },
      { toolName: "read", input: { path: "src/edit.ts" }, text: "read-c" },
      { toolName: "read", input: { path: "src/read.ts" }, text: "read-a" },
      { toolName: "grep", input: { pattern: "warning", path: "src" }, text: "grep-different" },
      { toolName: "read", input: { path: "src/edit.ts" }, text: "read-c" },
      { toolName: "read", input: { path: "src/read.ts" }, text: "read-a" },
      { toolName: "grep", input: { pattern: "hashline", path: "src" }, text: "grep-b" },
      { toolName: "read", input: { path: "src/edit.ts" }, text: "read-c" },
    ];

    let finalResult: any;
    for (const [index, entry] of sequence.entries()) {
      const toolCallId = `mixed-${index}`;
      await handlers.tool_call(makeToolCall(entry.toolName, toolCallId, entry.input), {});
      const result = await handlers.tool_result(
        makeToolResult(entry.toolName, toolCallId, entry.input, entry.text),
        {},
      );
      if (index === sequence.length - 1) {
        finalResult = result;
      }
    }

    expect(finalResult).toBeUndefined();
  });
});
