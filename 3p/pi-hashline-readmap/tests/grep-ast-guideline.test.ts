import { describe, it, expect, vi } from "vitest";
import { registerGrepTool } from "../src/grep.js";

// Minimal mock for ExtensionAPI
function createMockPi() {
  const tools: any[] = [];
  return {
    registerTool(tool: any) {
      tools.push(tool);
    },
    get tools() {
      return tools;
    },
    events: { emit: vi.fn(), on: vi.fn() },
    on: vi.fn(),
  } as any;
}

describe("registerGrepTool with astSearchGuideline", () => {
  it("includes astSearchGuideline in promptGuidelines when provided", () => {
    const pi = createMockPi();
    const guideline = "Use `ast_search` for structural code patterns.";
    const tool = registerGrepTool(pi, { astSearchGuideline: guideline });
    expect((tool as any).promptGuidelines).toBeDefined();
    expect((tool as any).promptGuidelines).toContain(guideline);
  });

  it("does not include ast_search guideline when option is not provided", () => {
    const pi = createMockPi();
    const tool = registerGrepTool(pi);
    const guidelines = (tool as any).promptGuidelines;
    // Should either be undefined or not contain ast_search text
    if (guidelines) {
      for (const g of guidelines) {
        expect(g).not.toContain("ast_search");
      }
    }
  });
});
