import { describe, it, expect } from "vitest";
import { isSgAvailable } from "../src/sg.js";

describe("isSgAvailable", () => {
  it("returns a boolean", () => {
    const result = isSgAvailable();
    expect(typeof result).toBe("boolean");
  });
});
