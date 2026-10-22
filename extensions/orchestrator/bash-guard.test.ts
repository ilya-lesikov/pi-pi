import { describe, expect, it } from "vitest";
import { registerBashGuard } from "./bash-guard.js";
import { parseToolNames, toolsBlock } from "./agents/tool-routing.js";

function guard(timeoutSec: number) {
  let handler: (event: any) => Promise<unknown> = async () => {};
  const pi: any = { on: (name: string, fn: any) => { if (name === "tool_call") handler = fn; }, registerTool: () => { throw new Error("registered a tool"); } };
  registerBashGuard(pi, () => timeoutSec);
  return async (toolName: string, input: Record<string, unknown>) => {
    await handler({ type: "tool_call", toolName, toolCallId: "c", input });
    return input;
  };
}

describe("bash guard", () => {
  it("gives a bash call without a timeout the default one, without a bash tool of its own", async () => {
    const call = guard(600);
    expect(await call("bash", { command: "make" })).toEqual({ command: "make", timeout: 600 });
    expect(await call("bash", { command: "make", timeout: null })).toEqual({ command: "make", timeout: 600 });
  });

  it("leaves a call's own timeout, other tools, and a disabled default alone", async () => {
    const call = guard(600);
    expect(await call("bash", { command: "make", timeout: 5 })).toEqual({ command: "make", timeout: 5 });
    expect(await call("bash", { command: "make", timeout: 0 })).toEqual({ command: "make", timeout: 0 });
    expect(await call("read", { path: "x" })).toEqual({ path: "x" });
    expect(await guard(0)("bash", { command: "make" })).toEqual({ command: "make" });
  });

  it("tells an agent with bash, and only one, how to run commands that do not exit", () => {
    const withBash = toolsBlock(parseToolNames("read, bash"));
    expect(withBash).toMatch(/in a bash call of its own, in the background/);
    expect(withBash).toMatch(/set bash's `timeout` on any command that can take more than a few seconds/);
    expect(toolsBlock(parseToolNames("read, grep"))).not.toMatch(/bash's `timeout`/);
  });
});
