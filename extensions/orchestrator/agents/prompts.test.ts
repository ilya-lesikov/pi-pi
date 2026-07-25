import { describe, expect, it } from "vitest";
import { getDefaultConfig, resolvePreset } from "../config.js";
import { delegationBlock, toolsBlock, parseToolNames, PRINCIPLES_BLOCK, IMPLEMENTATION_PRINCIPLES_BLOCK } from "./tool-routing.js";
import { createAdvisorAgent } from "./advisor.js";
import { createDeepDebuggerAgent } from "./deep-debugger.js";
import { createReviewerAgent } from "./reviewer.js";
import { createTaskAgent } from "./task.js";
import { createExploreAgent } from "./explore.js";
import { createLibrarianAgent } from "./librarian.js";
import { createPlannerAgent } from "./planner.js";
import { createPlanReviewerAgent } from "./plan-reviewer.js";
import { createCodeReviewerAgent } from "./code-reviewer.js";
import { createBrainstormReviewerAgent } from "./brainstorm-reviewer.js";

const config = getDefaultConfig();

describe("delegationBlock", () => {
  const pools = {
    advisors: [{ name: "advisor_x_high", model: "anthropic/claude-fable-latest", family: "fable", tier: "xsmart", thinking: "high" }],
    reviewers: [{ name: "reviewer_y_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
    deepDebuggers: [{ name: "deep-debugger_z_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
  };

  it("covers the free-form roles and the model-named pool rules", () => {
    const block = delegationBlock("opus", pools);
    for (const name of ["explore", "librarian", "task", "advisor", "deep-debugger", "reviewer"]) {
      expect(block).toContain(name);
    }
    expect(block).toContain("model-named");
    expect(block).toContain("SAME PROVIDER");
    expect(block).toContain("opus MAY call fable");
  });

  it("states the reviewer and deep-debugger gating explicitly", () => {
    const block = delegationBlock("opus", pools);
    expect(block).toContain("ONLY when the user explicitly asks");
    expect(block).toMatch(/deep-debugger diagnoses/i);
    expect(block).toContain("must NOT write the actual fix");
  });

  it("renders the configured pool roster with model metadata", () => {
    const block = delegationBlock("opus", pools);
    expect(block).toContain("advisor_x_high");
    expect(block).toContain("anthropic/claude-fable-latest");
    expect(block).toContain("tier xsmart");
  });
});

describe("toolsBlock only advertises granted tools", () => {
  it("omits pp_register_repo and lsp/cbm guidance for a minimal agent", () => {
    const block = toolsBlock(parseToolNames("read, bash, grep, find, exa_search, exa_fetch"));
    expect(block).not.toContain("pp_register_repo");
    expect(block).not.toContain("lsp goToDefinition");
    expect(block).not.toContain("cbm_search");
    expect(block).toContain("exa_search");
  });

  it("includes pp_register_repo and the lsp/grep guidance for the main tool set", () => {
    const block = toolsBlock(["read", "bash", "edit", "write", "grep", "find", "ls", "lsp", "cbm_search", "pp_register_repo"]);
    expect(block).toContain("pp_register_repo");
    expect(block).toContain("NEVER grep for definitions");
    expect(block).toContain("cbm_search");
  });
});

describe("PRINCIPLES_BLOCK degrees-of-freedom split", () => {
  it("implementation-only code-style rules live in the implementation block, not the shared block", () => {
    for (const phrase of [
      "NEVER comment a private (non-exported) symbol",
      "volatile detail",
      "Prefer fewer, larger functions",
      "inline it",
      "Keep everything as private as possible",
      "DO NOT WRITE COMMENTS",
      "No temporary artifacts",
      "Smallest viable change",
      "Understand before modifying",
    ]) {
      expect(IMPLEMENTATION_PRINCIPLES_BLOCK).toContain(phrase);
      expect(PRINCIPLES_BLOCK).not.toContain(phrase);
    }
  });

  it("shared reasoning/evidence rules stay in the shared block", () => {
    for (const phrase of ["Verify, don't assume", "Evidence over claims", "Match existing patterns", "Think critically"]) {
      expect(PRINCIPLES_BLOCK).toContain(phrase);
    }
  });

  const planners = resolvePreset(config, "planners");
  const artifacts = { userRequest: "u", research: "r", manifest: [] as { title: string; path: string }[] };
  const readOnlyFactories: [string, { prompt: string }][] = [
    ["explore", createExploreAgent(config)],
    ["librarian", createLibrarianAgent(config)],
    ["advisor", createAdvisorAgent({ model: "anthropic/claude-fable-latest", thinking: "high" })],
    ["deep-debugger", createDeepDebuggerAgent({ model: "openai/gpt-latest", thinking: "high" })],
    ["reviewer", createReviewerAgent({ model: "openai/gpt-latest", thinking: "high" })],
    ["planner", createPlannerAgent("opus", planners, artifacts, "/out.md", [])],
    ["plan-reviewer", createPlanReviewerAgent("opus", resolvePreset(config, "planReviewers"), { userRequest: "u", research: "r", synthesizedPlan: "p", manifest: [] }, "/out.md", [])],
    ["code-reviewer", createCodeReviewerAgent("opus", resolvePreset(config, "codeReviewers"), { userRequest: "u", research: "r", synthesizedPlan: "p", manifest: [] }, "/out.md", [])],
    ["brainstorm-reviewer", createBrainstormReviewerAgent("opus", resolvePreset(config, "brainstormReviewers"), artifacts, "/out.md", [])],
  ];

  it("the shared block is embedded in ALL ten agent factory prompts", () => {
    const all = [...readOnlyFactories.map(([, f]) => f), createTaskAgent(config)];
    for (const f of all) {
      expect(f.prompt).toContain("Evidence over claims");
      expect(f.prompt).toContain("Verify, don't assume");
    }
  });

  it("read-only factories do NOT carry implementation-only code-style rules", () => {
    for (const [, f] of readOnlyFactories) {
      expect(f.prompt).not.toContain("Keep everything as private as possible");
      expect(f.prompt).not.toContain("NEVER comment a private (non-exported) symbol");
    }
  });

  it("the edit-capable task factory DOES carry implementation-only code-style rules", () => {
    const t = createTaskAgent(config);
    expect(t.prompt).toContain("Keep everything as private as possible");
    expect(t.prompt).toContain("NEVER comment a private (non-exported) symbol");
  });
});

describe("new free-form agent factories", () => {
  it("advisor is read-only (no write/edit) and reasons in Diagnosis/Options/Recommendation", () => {
    const a = createAdvisorAgent({ model: "anthropic/claude-fable-latest", thinking: "high" });
    expect(a.frontmatter.tools).not.toContain("write");
    expect(a.frontmatter.tools).not.toContain("edit");
    expect(a.prompt).toContain("READ-ONLY");
    expect(a.prompt).toContain("Diagnosis");
    expect(a.prompt).toContain("Recommendation");
    expect(a.prompt).toContain("<identity>");
  });

  it("advisor resolves the configured pool-entry model + thinking", () => {
    const a = createAdvisorAgent({ model: "openai/gpt-latest", thinking: "xhigh" });
    expect(a.frontmatter.model).toContain("gpt");
    expect(a.frontmatter.thinking).toBe("xhigh");
  });

  it("deep-debugger has write/edit but restricts writes to diagnosis only", () => {
    const d = createDeepDebuggerAgent({ model: "openai/gpt-latest", thinking: "high" });
    expect(d.frontmatter.tools).toContain("write");
    expect(d.frontmatter.tools).toContain("edit");
    expect(d.prompt).toContain("DIAGNOSIS ONLY");
    expect(d.prompt).toContain("MUST NOT write the actual fix");
  });

  it("reviewer is read-only, retains bash for git diff, and is verdict-first", () => {
    const r = createReviewerAgent({ model: "openai/gpt-latest", thinking: "high" });
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

  it("brainstorm-reviewer restricts spawns and lists manifest paths when provided", () => {
    const b = createBrainstormReviewerAgent(
      "opus",
      brainstormReviewers,
      { userRequest: "u", research: "r", manifest },
      "/out.md",
      [],
    );
    expect(b.prompt).toContain("Do NOT spawn task, advisor, deep-debugger, or reviewer");
    expect(b.prompt).toContain("/t/artifacts/design.md");
    expect(b.prompt).toContain("read them from disk with the read tool");
  });
});

describe("routing-contract descriptions (what / when / exclusion)", () => {
  it("explore, librarian, and task descriptions state a fit and an exclusion, third person, with the (pi-pi) suffix", () => {
    const descs = {
      explore: createExploreAgent(config).frontmatter.description,
      librarian: createLibrarianAgent(config).frontmatter.description,
      task: createTaskAgent(config).frontmatter.description,
    };
    for (const d of Object.values(descs)) {
      expect(d).toContain("best");
      expect(d).toMatch(/not for|not when/i);
      expect(d.endsWith("(pi-pi)")).toBe(true);
    }
    expect(descs.explore).toMatch(/locat|find|trac/i);
    expect(descs.librarian).toMatch(/external|docs|librar/i);
    expect(descs.task).toMatch(/implementation|slice/i);
  });

  it("extends the advisor / deep-debugger / reviewer descriptions with what+when+exclusion, preserving protected exclusions", () => {
    const advisor = createAdvisorAgent({ model: "anthropic/claude-fable-latest", thinking: "high" }).frontmatter.description;
    const debugger_ = createDeepDebuggerAgent({ model: "openai/gpt-latest", thinking: "high" }).frontmatter.description;
    const reviewer = createReviewerAgent({ model: "openai/gpt-latest", thinking: "high" }).frontmatter.description;
    for (const d of [advisor, debugger_, reviewer]) {
      expect(d).toMatch(/not for|not every|not as|never/i);
      expect(d.endsWith("(pi-pi)")).toBe(true);
    }
    expect(debugger_).toContain("not every error");
    expect(reviewer).toContain("only when the user asks");
    expect(advisor).toMatch(/judgment|tradeoff|why is this broken/i);
  });

  it("delegationBlock remains the sole owner of numeric routing thresholds", () => {
    const pools = {
      advisors: [{ name: "advisor_x_high", model: "anthropic/claude-fable-latest", family: "fable", tier: "xsmart", thinking: "high" }],
      reviewers: [{ name: "reviewer_y_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
      deepDebuggers: [{ name: "deep-debugger_z_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
    };
    expect(delegationBlock("opus", pools)).toContain("2–3 parallel");
    expect(delegationBlock("opus", pools)).toContain("4+ only");
    for (const d of [createExploreAgent(config).frontmatter.description, createTaskAgent(config).frontmatter.description]) {
      expect(d).not.toMatch(/2–3|4\+/);
    }
  });
});

describe("affordance-aligned evidence gates", () => {
  it("the edit-capable task delegate carries the evidence gate + N/A path", () => {
    const t = createTaskAgent(config);
    expect(t.prompt).toContain("Verification gate");
    expect(t.prompt).toContain("not applicable");
    expect(t.prompt).toMatch(/in any language/i);
  });

  it("read-only reviewer / code-reviewer restrict evidence to what their tools can produce", () => {
    const r = createReviewerAgent({ model: "openai/gpt-latest", thinking: "high" });
    const c = createCodeReviewerAgent("opus", resolvePreset(config, "codeReviewers"), { userRequest: "u", research: "r", synthesizedPlan: "p", manifest: [] }, "/out.md", []);
    for (const p of [r.prompt, c.prompt]) {
      expect(p).toMatch(/MUST NOT run tests|not run test suites/i);
      expect(p).toMatch(/OPEN QUESTIONS|Open Questions/);
    }
  });
});

describe("advisor anti-sycophancy", () => {
  it("requires taking a position + naming what would change it, behavior-framed with any quoted phrase marked as an example", () => {
    const a = createAdvisorAgent({ model: "anthropic/claude-fable-latest", thinking: "high" }).prompt;
    expect(a).toContain("Take a position");
    expect(a).toMatch(/what evidence would change|what would change/i);
    expect(a).toMatch(/in any language|targets the behavior/i);
    expect(a).toMatch(/illustrative|e\.g\.|for example|example/i);
  });
});
