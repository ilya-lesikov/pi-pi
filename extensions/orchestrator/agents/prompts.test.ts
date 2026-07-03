import { describe, expect, it } from "vitest";
import { getDefaultConfig, resolvePreset } from "../config.js";
import { DELEGATION_BLOCK } from "./tool-routing.js";
import { createAdvisorAgent } from "./advisor.js";
import { createDeepDebuggerAgent } from "./deep-debugger.js";
import { createReviewerAgent } from "./reviewer.js";
import { createTaskAgent } from "./task.js";
import { createPlannerAgent } from "./planner.js";
import { createPlanReviewerAgent } from "./plan-reviewer.js";
import { createCodeReviewerAgent } from "./code-reviewer.js";
import { createBrainstormReviewerAgent } from "./brainstorm-reviewer.js";

const config = getDefaultConfig();

describe("DELEGATION_BLOCK", () => {
  it("covers all six free-form agents with lowercase registry names", () => {
    for (const name of ["explore", "librarian", "task", "advisor", "deep-debugger", "reviewer"]) {
      expect(DELEGATION_BLOCK).toContain(name);
    }
  });

  it("states the reviewer and deep-debugger gating explicitly", () => {
    expect(DELEGATION_BLOCK).toContain("ONLY when the user explicitly asks");
    expect(DELEGATION_BLOCK).toMatch(/deep-debugger diagnoses/i);
    expect(DELEGATION_BLOCK).toContain("must NOT write the actual fix");
  });
});

describe("new free-form agent factories", () => {
  it("advisor is read-only (no write/edit) and reasons in Diagnosis/Options/Recommendation", () => {
    const a = createAdvisorAgent(config);
    expect(a.frontmatter.tools).not.toContain("write");
    expect(a.frontmatter.tools).not.toContain("edit");
    expect(a.prompt).toContain("READ-ONLY");
    expect(a.prompt).toContain("Diagnosis");
    expect(a.prompt).toContain("Recommendation");
  });

  it("deep-debugger has write/edit but restricts writes to diagnosis only", () => {
    const d = createDeepDebuggerAgent(config);
    expect(d.frontmatter.tools).toContain("write");
    expect(d.frontmatter.tools).toContain("edit");
    expect(d.prompt).toContain("DIAGNOSIS ONLY");
    expect(d.prompt).toContain("MUST NOT write the actual fix");
  });

  it("reviewer is read-only, retains bash for git diff, and is verdict-first", () => {
    const r = createReviewerAgent(config);
    expect(r.frontmatter.tools).toContain("bash");
    expect(r.frontmatter.tools).not.toContain("write");
    expect(r.frontmatter.tools).not.toContain("edit");
    expect(r.prompt).toContain("git diff");
    expect(r.prompt).toContain("VERY FIRST LINE");
    expect(r.frontmatter.description).toContain("only when the user asks");
  });
});

describe("task factory no longer bakes artifacts and stays explore/librarian-only", () => {
  it("takes only config (no baked artifact arg) and does not inline USER REQUEST / SYNTHESIZED PLAN", () => {
    expect(createTaskAgent.length).toBe(1);
    const t = createTaskAgent(config);
    expect(t.prompt).not.toContain("=== USER REQUEST ===");
    expect(t.prompt).not.toContain("=== SYNTHESIZED PLAN ===");
    expect(t.prompt).not.toContain("Do NOT re-read them from disk");
    expect(t.prompt).toContain("ONLY explore/librarian");
    expect(t.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
  });
});

describe("phased factory prompts: manifest guidance replaces the do-not-re-read trailer", () => {
  const planners = resolvePreset(config, "planners");
  const planReviewers = resolvePreset(config, "planReviewers");
  const codeReviewers = resolvePreset(config, "codeReviewers");
  const brainstormReviewers = resolvePreset(config, "brainstormReviewers");
  const manifest = [{ title: "Design Doc", path: "/t/artifacts/design.md" }];

  it("planner lists manifest paths and restricts spawns to explore/librarian", () => {
    const p = createPlannerAgent("opus", planners, { userRequest: "u", research: "r", manifest }, "/out.md", []);
    expect(p.prompt).toContain("/t/artifacts/design.md");
    expect(p.prompt).toContain("read them from disk with the read tool");
    expect(p.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
  });

  it("plan-reviewer lists manifest paths and restricts spawns", () => {
    const p = createPlanReviewerAgent(
      "opus",
      planReviewers,
      { userRequest: "u", research: "r", synthesizedPlan: "p", manifest },
      "/out.md",
      [],
    );
    expect(p.prompt).toContain("/t/artifacts/design.md");
    expect(p.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
  });

  it("code-reviewer lists manifest paths and restricts spawns", () => {
    const c = createCodeReviewerAgent(
      "opus",
      codeReviewers,
      { userRequest: "u", research: "r", synthesizedPlan: "p", manifest },
      "/out.md",
      [],
    );
    expect(c.prompt).toContain("/t/artifacts/design.md");
    expect(c.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
  });

  it("brainstorm-reviewer restricts spawns and no longer ends with the old trailer verbatim", () => {
    const b = createBrainstormReviewerAgent(
      "opus",
      brainstormReviewers,
      { userRequest: "u", research: "r" },
      "/out.md",
      [],
    );
    expect(b.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
    expect(b.prompt).toContain("Do NOT re-read them from disk");
  });
});
