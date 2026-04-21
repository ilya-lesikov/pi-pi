import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("index.ts nu integration", () => {
  const content = readFileSync(resolve(__dirname, "../index.ts"), "utf-8");

  it("imports registerNuTool", () => {
    expect(content).toContain("registerNuTool");
    expect(content).toContain("./src/nu.js");
  });

  it("calls registerNuTool(pi)", () => {
    expect(content).toContain("registerNuTool(pi)");
  });
});
