import { describe, it, expect } from "vitest";
import { formatEditResultText } from "../src/edit-render-helpers.js";

describe("formatEditResultText semantic badge", () => {
  it("includes ws-only badge for whitespace-only classification", () => {
    const result = formatEditResultText({
      isError: false,
      diff: "+1 const x = 1;",
      warnings: [],
      noopEdits: [],
      errorText: "",
      semanticClassification: "whitespace-only",
    });
    expect(result.semanticBadge).toBe("ws-only");
  });

  it("includes ✓ semantic badge for semantic classification", () => {
    const result = formatEditResultText({
      isError: false,
      diff: "+1 const x = 10;",
      warnings: [],
      noopEdits: [],
      errorText: "",
      semanticClassification: "semantic",
    });
    expect(result.semanticBadge).toBe("✓ semantic");
  });

  it("includes mixed badge for mixed classification", () => {
    const result = formatEditResultText({
      isError: false,
      diff: "+1 const x = 10;",
      warnings: [],
      noopEdits: [],
      errorText: "",
      semanticClassification: "mixed",
    });
    expect(result.semanticBadge).toBe("mixed");
  });

  it("returns undefined badge when no classification provided", () => {
    const result = formatEditResultText({
      isError: false,
      diff: "+1 const x = 10;",
      warnings: [],
      noopEdits: [],
      errorText: "",
    });
    expect(result.semanticBadge).toBeUndefined();
  });

  it("returns undefined badge on error path", () => {
    const result = formatEditResultText({
      isError: true,
      diff: "",
      warnings: [],
      noopEdits: [],
      errorText: "File not found",
      semanticClassification: "semantic",
    });
    expect(result.semanticBadge).toBeUndefined();
  });
});
