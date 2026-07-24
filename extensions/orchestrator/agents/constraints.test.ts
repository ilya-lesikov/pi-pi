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

  it("guided review stays hands-off (no unprompted self-complete)", () => {
    for (const phase of ["review"] as const) {
      const line = completionLine(phase, "guided");
      expect(line).toContain("Do NOT advance on your own or call pp_phase_complete unprompted");
    }
  });

  it("guided brainstorm never self-completes", () => {
    const line = completionLine("brainstorm", "guided");
    expect(line).toContain("Do NOT call pp_phase_complete yourself");
  });

  it("guided brainstorm/review carve out a /pp banner exception", () => {
    for (const phase of ["brainstorm", "review"] as const) {
      expect(completionLine(phase, "guided")).toContain(
        "a /pp menu banner",
      );
      expect(completionLine(phase, "guided")).toContain("e.g. an auto-review loop");
    }
  });

  it("autonomous/plan/implement completion lines carry no /pp banner exception", () => {
    for (const phase of ["plan", "implement"] as const) {
      expect(completionLine(phase, "guided")).not.toContain("a /pp menu banner");
    }
    for (const phase of ["brainstorm", "review", "plan", "implement"] as const) {
      expect(completionLine(phase, "autonomous")).not.toContain("a /pp menu banner");
    }
  });

  it("autonomous phases always self-complete regardless of phase", () => {
    for (const phase of ["plan", "implement", "review", "brainstorm"] as const) {
      expect(completionLine(phase, "autonomous")).toContain("call pp_phase_complete");
    }
  });

  it("guided handoff phases require the standardized closing block", () => {
    for (const phase of ["brainstorm", "review"] as const) {
      const line = completionLine(phase, "guided");
      expect(line).toContain("the standardized block");
      expect(line).toContain("Advance via the /pp menu");
    }
  });

  it("autonomous phases do not emit the prose closing block", () => {
    expect(completionLine("brainstorm", "autonomous")).not.toContain("Advance via the /pp menu");
  });

  it("quick phase does not self-complete for a mere question/answer", () => {
    const line = completionLine("quick", "guided");
    expect(line).toContain("ONLY after you have actually performed the requested work");
    expect(line).toMatch(/do NOT call pp_phase_complete/i);
    expect(line).toContain("/pp");
  });

  it("quick phase still self-completes after real work", () => {
    const line = completionLine("quick", "guided");
    expect(line).toContain("call pp_phase_complete");
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

  it("does NOT emit the Review Summary schema for brainstorm closes", () => {
    for (const phase of ["brainstorm"] as const) {
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

  it("guided brainstorm/review blocks embed the /pp banner exception", () => {
    for (const phase of ["brainstorm", "review"] as const) {
      const block = constraintsBlock(phase, "guided");
      expect(block).toContain("a /pp menu banner");
      expect(block).toContain("e.g. an auto-review loop");
    }
  });

  it("guided phases tell the agent to ask rather than silently assume", () => {
    for (const phase of ["brainstorm", "plan", "implement", "review"] as const) {
      const block = constraintsBlock(phase, "guided");
      expect(block).toContain("do NOT silently assume");
      expect(block).toContain("ask the");
      expect(block).not.toContain("artifacts/ASSUMPTIONS.md");
    }
  });

  it("autonomous phases record unverified assumptions in artifacts/ASSUMPTIONS.md with the fixed fields", () => {
    for (const phase of ["brainstorm", "plan", "implement", "review"] as const) {
      const block = constraintsBlock(phase, "autonomous");
      expect(block).toContain("artifacts/ASSUMPTIONS.md");
      for (const field of ["statement", "confidence", "basis", "invalidation test", "decision impact"]) {
        expect(block).toContain(field);
      }
      expect(block).toContain("_No open assumptions._");
      expect(block).toContain("never fabricate");
    }
  });
});
