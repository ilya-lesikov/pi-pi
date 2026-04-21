import { describe, it, expect, vi, afterEach } from "vitest";
import { statAllWithConcurrency, _testable } from "../src/find-stat.js";
describe("statAllWithConcurrency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns stat results in the same order as the input paths", async () => {
    const results = await statAllWithConcurrency(["package.json", "tsconfig.json"], ".", 4);
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[0]!.size).toBeGreaterThan(0);
    expect(results[1]!.size).toBeGreaterThan(0);
  });
  it("returns null for paths that fail to stat (e.g. missing files)", async () => {
    const results = await statAllWithConcurrency(
      ["package.json", "this-file-does-not-exist-xyz.zzz"],
      ".",
      4,
    );
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
  });
  it("caps concurrency at 32 even if the caller passes a larger number", async () => {
    const realStat = _testable.stat;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(_testable, "stat").mockImplementation(async (path) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await realStat(path);
      } finally {
        inFlight--;
      }
    });

    await statAllWithConcurrency(new Array(100).fill("package.json"), ".", 100);
    expect(maxInFlight).toBeLessThanOrEqual(32);
  });
  it("treats non-finite concurrency as the default cap instead of returning null placeholders", async () => {
    const results = await statAllWithConcurrency(["package.json"], ".", Number.NaN);
    expect(results).toHaveLength(1);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.size).toBeGreaterThan(0);
  });
});
