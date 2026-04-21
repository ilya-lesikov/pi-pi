import { describe, it, expect, vi, beforeEach } from "vitest";

const builtinExecute = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@mariozechner/pi-coding-agent");
  return {
    ...actual,
    createGrepTool: () => ({ execute: builtinExecute }),
  };
});

import { registerGrepTool } from "../src/grep.js";

function captureGrepTool() {
  let capturedTool: any;
  registerGrepTool(
    {
      registerTool(def: any) {
        capturedTool = def;
      },
    } as any,
  );
  return capturedTool;
}

describe("grep builtin parameter narrowing", () => {
  beforeEach(() => {
    builtinExecute.mockReset();
    builtinExecute.mockResolvedValue({
      content: [{ type: "text", text: "" }],
      details: {},
      isError: false,
    });
  });

  it("rejects invalid strings before invoking builtin grep", async () => {
    const tool = captureGrepTool();
    const result = await tool.execute(
      "grep-invalid-strings",
      {
        pattern: "anything",
        context: "1x",
        limit: "2x",
      },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type).toBe("text");
    expect(result.content?.[0]?.text).toBe('Invalid context: expected a base-10 integer, received "1x".');
    expect(builtinExecute).toHaveBeenCalledTimes(0);
  });
});
