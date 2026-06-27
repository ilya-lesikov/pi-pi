import { describe, it, expect } from "vitest";
import { compareModelVersion } from "./model-version.js";

function latest(models: string[]): string {
  return models.slice().sort((a, b) => compareModelVersion(b, a))[0];
}

describe("compareModelVersion", () => {
  it("ranks a higher semantic minor above a dated snapshot in the same family", () => {
    expect(compareModelVersion("claude-opus-4-6", "claude-opus-4-20250101")).toBeGreaterThan(0);
    expect(latest(["claude-opus-4-6", "claude-opus-4-20250101", "claude-opus-4-5"])).toBe("claude-opus-4-6");
  });

  it("orders ordinary numeric versions normally", () => {
    expect(compareModelVersion("gpt-4-2", "gpt-4-10")).toBeLessThan(0);
    expect(latest(["gpt-4-2", "gpt-4-10", "gpt-4-1"])).toBe("gpt-4-10");
  });

  it("orders two dated snapshots by date", () => {
    expect(compareModelVersion("claude-opus-4-20250201", "claude-opus-4-20250101")).toBeGreaterThan(0);
    expect(latest(["claude-opus-4-20250101", "claude-opus-4-20250201"])).toBe("claude-opus-4-20250201");
  });

  it("falls back to lexical comparison when numeric parts are equal", () => {
    expect(compareModelVersion("model-a", "model-b")).toBeLessThan(0);
  });
});
