import { describe, it, expect } from "vitest";
import { formatReadCallText } from "../src/read-render-helpers.js";

describe("formatReadCallText invalid pagination", () => {
  it("omits numeric suffixes when offset or limit is not positive", () => {
    const negativeOffset = formatReadCallText({ path: "src/foo.ts", offset: -5 });
    expect(negativeOffset.suffix).toBeUndefined();

    const zeroOffset = formatReadCallText({ path: "src/foo.ts", offset: 0, limit: 1 });
    expect(zeroOffset.suffix).toBeUndefined();

    const zeroLimit = formatReadCallText({ path: "src/foo.ts", offset: 1, limit: 0 });
    expect(zeroLimit.suffix).toBeUndefined();

    const validRange = formatReadCallText({ path: "src/foo.ts", offset: 10, limit: 20 });
    expect(validRange).toEqual({ path: "src/foo.ts", suffix: "lines 10-29" });
  });
});
