import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

async function getSgTool() {
  const { registerSgTool } = await import("../src/sg.js");
  let captured: any = null;
  const mockPi = { registerTool(def: any) { captured = def; } };
  registerSgTool(mockPi as any);
  if (!captured) throw new Error("sg tool was not registered");
  return captured;
}

describe("sg prompt loading", () => {
  it("uses the first prompt paragraph as the exact ast_search description", async () => {
    const tool = await getSgTool();
    expect(tool.description).toBe(
      "AST-aware structural code search. Use this when grep is too brittle and you need to match code shape rather than raw text. Prefer over grep for finding function calls, imports, JSX elements, or syntax patterns. Returns anchored matches suitable for edit.",
    );
  });

  it("keeps the prompt snippet in prompts/sg.md", () => {
    const content = readFileSync(resolve(root, "prompts/sg.md"), "utf8");
    expect(content).toContain("Use for AST-aware code pattern search when text search is too brittle.");
  });
});
