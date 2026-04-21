import { describe, it, expect } from "vitest";
import { formatDoomLoopMessage, type DoomLoopWarning } from "../src/doom-loop.js";

describe("formatDoomLoopMessage — identical-tail", () => {
  it("emits the stable marker, a repeat-count phrase, a compact fingerprint, and a grep-specific suggestion", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "grep",
      fingerprint: 'grep:{"glob":"*.ts","pattern":"addRoute"}',
    };

    const out = formatDoomLoopMessage(warning);

    expect(out).toMatch(/^⚠ REPEATED-CALL WARNING/);
    expect(out).toContain("3rd identical tool call");
    expect(out).toContain("grep");
    expect(out).toMatch(/ignoreCase|ast_search|literal|narrower|summary/);
  });

  it("keeps each rendered step under 80 characters", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "grep",
      fingerprint:
        'grep:{"ignoreCase":true,"limit":50,"pattern":"reallylongpatternthatshouldgettruncatedbecauseitistoolong","path":"src"}',
    };

    const out = formatDoomLoopMessage(warning);
    const fingerprintLine = out
      .split("\n")
      .find((line) => line.trim().startsWith("•") || line.includes("grep"));
    expect(fingerprintLine).toBeDefined();
    const compactLine = out
      .split("\n")
      .find((line) => /^\s*[→•\-]\s*grep/.test(line));
    expect(compactLine).toBeDefined();
    expect(compactLine!.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a generic suggestion for unknown tools", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "weirdtool",
      fingerprint: "weirdtool:{}",
    };
    const out = formatDoomLoopMessage(warning);
    expect(out.toLowerCase()).toContain("different approach");
  });
});

describe("formatDoomLoopMessage — repeated-subsequence", () => {
  it("emits ⚠ ALTERNATING-CALL WARNING, the repeating steps, and suggestions for each distinct tool", () => {
    const out = formatDoomLoopMessage({
      kind: "repeated-subsequence",
      toolName: "read",
      fingerprint: 'read:{"path":"src/bar.ts"}',
      steps: [
        { toolName: "grep", input: { pattern: "foo" } },
        { toolName: "read", input: { path: "src/bar.ts" } },
      ],
    });

    expect(out).toMatch(/^⚠ ALTERNATING-CALL WARNING/);
    expect(out.toLowerCase()).toMatch(/neither call|not producing new information/);

    const stepLines = out.split("\n").filter((line) => /^\s*[→•\-]\s*(grep|read)\b/.test(line));
    expect(stepLines.length).toBeGreaterThanOrEqual(2);
    for (const line of stepLines) expect(line.length).toBeLessThanOrEqual(80);

    const grepIdx = out.indexOf("For grep:");
    const readIdx = out.indexOf("For read:");
    expect(grepIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    expect(grepIdx).toBeLessThan(readIdx);
  });

  it("dedupes distinct tools and falls back to the generic line for unknown ones", () => {
    const out = formatDoomLoopMessage({
      kind: "repeated-subsequence",
      toolName: "read",
      fingerprint: 'read:{"path":"a"}',
      steps: [
        { toolName: "read", input: { path: "a" } },
        { toolName: "weirdtool", input: {} },
        { toolName: "read", input: { path: "a" } },
      ],
    });

    expect((out.match(/For read:/g) ?? []).length).toBe(1);
    expect(out).toContain("For weirdtool:");
    expect(out.toLowerCase()).toContain("different approach");
  });
});
