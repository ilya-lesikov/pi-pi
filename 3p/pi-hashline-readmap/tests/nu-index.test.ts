import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("index.ts nu integration removed", () => {
  const content = readFileSync(resolve(__dirname, "../index.ts"), "utf-8");

  it("does not import registerNuTool", () => {
    expect(content).not.toContain("registerNuTool");
  });

  it("does not reference nu tool", () => {
    expect(content).not.toContain("nuTool");
  });
});
