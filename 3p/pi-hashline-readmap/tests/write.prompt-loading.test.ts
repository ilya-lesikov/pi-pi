import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerWriteTool } from "../src/write.js";

function firstParagraph(path: string): string {
  const content = readFileSync(path, "utf8").trim();
  return content.split(/\n\s*\n/, 1)[0]?.trim() ?? content;
}

function captureTool(register: (pi: any) => void) {
  let tool: any;
  register({
    registerTool(def: any) {
      tool = def;
    },
  });
  return tool;
}

describe("prompt loading — write", () => {
  it("creates prompts/write.md and uses its first paragraph as the tool description", () => {
    const promptPath = resolve("prompts/write.md");
    expect(existsSync(promptPath)).toBe(true);

    const tool = captureTool(registerWriteTool);
    expect(tool.description).toBe(firstParagraph(promptPath));
  });

  it("documents binary no-anchor behavior, safe display escaping, and best-effort map appends", () => {
    const promptPath = resolve("prompts/write.md");
    const content = readFileSync(promptPath, "utf8");
    expect(content).toContain("no anchors to feed into `edit`");
    expect(content).toContain("control characters");
    expect(content).toContain("map append is best-effort");
  });
});
