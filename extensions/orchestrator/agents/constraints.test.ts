import { describe, expect, it } from "vitest";
import { closingBlockInstruction, completionLine, constraintsBlock } from "./constraints.js";

describe("completionLine", () => {
  it("guided plan and implement instruct calling pp_phase_complete on completion", () => {
    for (const phase of ["plan", "implement"] as const) {
      const line = completionLine(phase, "guided");
      expect(line).toContain("call pp_phase_complete");
      expect(line).not.toContain("Do NOT advance on your own");
      expect(line).not.toMatch(/do not.*wait for.*input/i);
    }
  });

  it("guided review and debug stay hands-off (no unprompted self-complete)", () => {
    for (const phase of ["review", "debug"] as const) {
      const line = completionLine(phase, "guided");
      expect(line).toContain("Do NOT advance on your own or call pp_phase_complete unprompted");
    }
  });

  it("guided brainstorm never self-completes", () => {
    const line = completionLine("brainstorm", "guided");
    expect(line).toContain("Do NOT call pp_phase_complete yourself");
  });

  it("autonomous phases always self-complete regardless of phase", () => {
    for (const phase of ["plan", "implement", "review", "brainstorm"] as const) {
      expect(completionLine(phase, "autonomous")).toContain("call pp_phase_complete");
    }
  });

  it("guided handoff phases require the standardized closing block", () => {
    for (const phase of ["brainstorm", "review", "debug"] as const) {
      const line = completionLine(phase, "guided");
      expect(line).toContain("the standardized block");
      expect(line).toContain("Advance via the /pp menu");
    }
  });

  it("autonomous phases do not emit the prose closing block", () => {
    expect(completionLine("brainstorm", "autonomous")).not.toContain("Advance via the /pp menu");
  });
});

describe("closingBlockInstruction", () => {
  it("spells out the exact block with a blank line between summary and advance, no rules", () => {
    const block = closingBlockInstruction("brainstorm");
    expect(block).toContain("Advance via the /pp menu to move into plan");
    expect(block).not.toContain("────");
    expect(block).toContain("/pp");
    expect(block).toContain("✅ <one-sentence summary of what this phase produced>\n\n▶ Advance via the /pp menu to move into plan.");
  });

  it("prepends the Review Summary schema ONLY for the review phase, before the closing block", () => {
    const review = closingBlockInstruction("review");
    expect(review).toContain("## Review Summary");
    expect(review).toContain("| # | Severity | Location | Finding |");
    expect(review).toContain("BLOCKER");
    // The ✅/▶ lines must remain the final lines of the block.
    expect(review.trimEnd().endsWith("▶ Advance via the /pp menu to move into plan.")).toBe(true);
    expect(review.indexOf("## Review Summary")).toBeLessThan(review.indexOf("✅ <one-sentence summary"));
  });

  it("does NOT emit the Review Summary schema for brainstorm or debug closes", () => {
    for (const phase of ["brainstorm", "debug"] as const) {
      expect(closingBlockInstruction(phase)).not.toContain("## Review Summary");
    }
  });
});

describe("constraintsBlock", () => {
  it("guided implement block tells the agent to self-complete", () => {
    const block = constraintsBlock("implement", "guided");
    expect(block).toContain("call pp_phase_complete");
    expect(block).not.toContain("Do NOT advance on your own");
  });

  it("guided plan block tells the agent to self-complete", () => {
    const block = constraintsBlock("plan", "guided");
    expect(block).toContain("call pp_phase_complete");
  });
});
