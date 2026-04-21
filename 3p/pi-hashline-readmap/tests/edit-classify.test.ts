import { describe, it, expect } from "vitest";
import { classifyEdit } from "../src/edit-classify.js";

describe("classifyEdit internal heuristics", () => {
  it("classifies no-op when old and new content are identical", () => {
    const result = classifyEdit("const x = 1;\n", "const x = 1;\n");
    expect(result.classification).toBe("no-op");
  });

  it("classifies whitespace-only when all changes are whitespace", () => {
    const old = "function hello() {\n  const x = 1;\n  return x;\n}\n";
    const nw = "function hello() {\n    const x = 1;\n    return x;\n}\n";
    const result = classifyEdit(old, nw);
    expect(result.classification).toBe("whitespace-only");
  });

  it("classifies semantic when all changes are non-whitespace", () => {
    const old = "const x = 1;\nconst y = 2;\n";
    const nw = "const x = 10;\nconst y = 20;\n";
    const result = classifyEdit(old, nw);
    expect(result.classification).toBe("semantic");
  });

  it("classifies mixed when some changes are whitespace and some are semantic", () => {
    const old = "const x = 1;\n  const y = 2;\n";
    const nw = "const x = 10;\nconst y = 2;\n";
    const result = classifyEdit(old, nw);
    expect(result.classification).toBe("mixed");
  });

  it("classifies semantic for added lines", () => {
    const old = "line1\nline2\n";
    const nw = "line1\nnewline\nline2\n";
    const result = classifyEdit(old, nw);
    expect(result.classification).toBe("semantic");
  });

  it("classifies semantic for deleted lines", () => {
    const old = "line1\nline2\nline3\n";
    const nw = "line1\nline3\n";
    const result = classifyEdit(old, nw);
    expect(result.classification).toBe("semantic");
  });
});
