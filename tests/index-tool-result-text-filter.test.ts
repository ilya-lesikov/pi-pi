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

describe("index tool_result text aggregation", () => {
  it("ignores non-string text chunks when composing bash output", async () => {
    const handlers = createHarness();

    const result = await handlers.tool_result(
      {
        toolName: "bash",
        toolCallId: "bash-1",
        input: { command: "echo hello" },
        content: [{ type: "text" }, { type: "text", text: "hello" }],
      },
      {},
    );

    expect(result).toBeDefined();
    expect(result.content[0].text).toBe("hello");
  });
});
