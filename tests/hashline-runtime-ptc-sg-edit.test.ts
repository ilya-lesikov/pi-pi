import { describe, it, expect } from "vitest";

async function captureTools() {
  const { registerSgTool } = await import("../src/sg.js");
  const { registerEditTool } = await import("../src/edit.js");
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
  };
  registerSgTool(pi as any);
  registerEditTool(pi as any);
  return tools;
}

describe("hashline runtime ptc metadata — ast_search and edit", () => {
  it("registers opt-in metadata for ast_search and mutating metadata for edit", async () => {
    const tools = await captureTools();
    expect(tools.ast_search.ptc).toEqual({
      callable: true,
      enabled: true,
      policy: "read-only",
      readOnly: true,
      pythonName: "ast_search",
      defaultExposure: "opt-in",
    });
    expect(tools.edit.ptc).toEqual({
      callable: true,
      enabled: true,
      policy: "mutating",
      readOnly: false,
      pythonName: "edit",
      defaultExposure: "not-safe-by-default",
    });
  });
});
