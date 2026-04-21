import { describe, it, expect } from "vitest";

describe("vitest global setup", () => {
  it("sets PI_HASHLINE_NO_PERSIST_MAPS=1 before tests run", () => {
    expect(process.env.PI_HASHLINE_NO_PERSIST_MAPS).toBe("1");
  });
});
