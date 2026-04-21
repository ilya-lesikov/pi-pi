import { describe, it, expect } from "vitest";

async function captureTools() {
  const { registerReadTool } = await import("../src/read.js");
  const { registerGrepTool } = await import("../src/grep.js");
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
  };
  registerReadTool(pi as any);
  registerGrepTool(pi as any);
  return tools;
}

describe("hashline runtime ptc metadata — read and grep", () => {
  it("registers safe-by-default read-only callable metadata for read and grep", async () => {
    const tools = await captureTools();
    expect(tools.read.ptc).toEqual({
      callable: true,
      enabled: true,
      policy: "read-only",
      readOnly: true,
      pythonName: "read",
      defaultExposure: "safe-by-default",
    });
    expect(tools.grep.ptc).toEqual({
      callable: true,
      enabled: true,
      policy: "read-only",
      readOnly: true,
      pythonName: "grep",
      defaultExposure: "safe-by-default",
    });
  });
});
