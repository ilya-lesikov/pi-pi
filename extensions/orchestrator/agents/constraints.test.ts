import { describe, expect, it } from "vitest";
import { completionLine, constraintsBlock } from "./constraints.js";

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
