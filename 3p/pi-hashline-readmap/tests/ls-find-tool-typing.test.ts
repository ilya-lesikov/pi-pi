import { describe, it, expect, vi } from "vitest";
import { registerLsTool } from "../src/ls.js";
import { registerFindTool } from "../src/find.js";

describe("ls/find tool registration contract", () => {
  it("returns the same tool definitions passed to registerTool with ptc metadata", () => {
    const pi = { registerTool: vi.fn() };

    const lsTool = registerLsTool(pi as any);
    const findTool = registerFindTool(pi as any);

    expect(pi.registerTool).toHaveBeenNthCalledWith(1, lsTool);
    expect(pi.registerTool).toHaveBeenNthCalledWith(2, findTool);
    expect(lsTool).toMatchObject({
      name: "ls",
      ptc: {
        pythonName: "ls",
        policy: "read-only",
        defaultExposure: "safe-by-default",
      },
    });
    expect(findTool).toMatchObject({
      name: "find",
      ptc: {
        pythonName: "find",
        policy: "read-only",
        defaultExposure: "safe-by-default",
      },
    });
    expect(typeof lsTool.execute).toBe("function");
    expect(typeof findTool.execute).toBe("function");
  });
});
