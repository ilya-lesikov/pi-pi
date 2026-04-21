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

describe("doom loop prepend — bash path", () => {
  it("prepends ⚠ REPEATED-CALL WARNING to bash tool_result after 3 identical bash calls", async () => {
    const handlers = createHarness();
    const command = "echo hi";

    for (const id of ["bash-1", "bash-2"]) {
      await handlers.tool_call(
        { type: "tool_call", toolName: "bash", toolCallId: id, input: { command } },
        {},
      );
      const r = await handlers.tool_result(
        {
          type: "tool_result",
          toolName: "bash",
          toolCallId: id,
          input: { command },
          content: [{ type: "text", text: "hi\n" }],
          isError: false,
        },
        {},
      );
      expect(r).toBeDefined();
      expect((r.content[0].text as string).startsWith("⚠")).toBe(false);
    }

    await handlers.tool_call(
      { type: "tool_call", toolName: "bash", toolCallId: "bash-3", input: { command } },
      {},
    );
    const third = await handlers.tool_result(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "bash-3",
        input: { command },
        content: [{ type: "text", text: "hi\n" }],
        isError: false,
      },
      {},
    );

    expect(third).toBeDefined();
    const text = third.content[0].text as string;
    expect(text.startsWith("⚠ REPEATED-CALL WARNING")).toBe(true);
    expect(text).toContain("hi");
    expect(text).not.toContain("You appear to be stuck. Try a different approach.");
  });
});
