import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("bash-filter imports", () => {
  it("does not keep an unused testOutput import", () => {
    const source = readFileSync(resolve(process.cwd(), "src/rtk/bash-filter.ts"), "utf-8");
    expect(source).not.toContain('import * as testOutput from "./test-output.ts";');
  });
});
