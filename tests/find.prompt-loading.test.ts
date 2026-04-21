import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerFindTool } from "../src/find.js";

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

describe("find prompt loading", () => {
  it("uses the first paragraph of prompts/find.md as the tool description", () => {
    const tool = captureTool(registerFindTool);
    expect(tool.description).toBe(firstParagraph(resolve("prompts/find.md")));
  });
});
