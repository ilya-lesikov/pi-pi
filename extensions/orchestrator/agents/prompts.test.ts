import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config.js";
import { delegationBlock, toolsBlock, parseToolNames, principlesBlock } from "./tool-routing.js";
import { createAdvisorAgent } from "./advisor.js";
import { createDeepDebuggerAgent } from "./deep-debugger.js";
import { createReviewerAgent } from "./reviewer.js";
import { createTaskAgent } from "./task.js";
import { createExploreAgent } from "./explore.js";
import { createLibrarianAgent } from "./librarian.js";

const config = getDefaultConfig();

const poolEntry = { model: "anthropic/claude-fable-latest", thinking: "high" };
const gptEntry = { model: "openai/gpt-latest", thinking: "high" };

const workerFactories = (): [string, { frontmatter: { tools: string; description: string; max_turns?: number }; prompt: string }][] => [
  ["explore", createExploreAgent(config)],
  ["librarian", createLibrarianAgent(config)],
  ["task", createTaskAgent(config)],
  ["advisor", createAdvisorAgent(poolEntry)],
  ["deep-debugger", createDeepDebuggerAgent(gptEntry)],
  ["reviewer", createReviewerAgent(gptEntry)],
];

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
    expect(block).toContain("NEVER spawn a same-provider model at your tier or weaker");
    expect(block).toContain("DIFFERENT family");
    expect(block).toContain("dissenting view");
  });

  it("keeps specialists selective without imposing workflow gates", () => {
    const block = delegationBlock("opus", pools);
    expect(block).toContain("worth the risk it removes");
    expect(block).toContain("diagnoses ONLY");
    expect(block).toContain("ONE cheap localizing probe");
    expect(block).not.toContain("OPEN with");
  });

  it("renders the configured pool roster with model metadata", () => {
    const block = delegationBlock("opus", pools);
    expect(block).toContain("advisor_x_high");
    expect(block).toContain("anthropic/claude-fable-latest");
    expect(block).toContain("tier xsmart");
  });

  it("routes on domain-neutral fit rather than coding-only triggers", () => {
    const block = delegationBlock("opus", pools);
    expect(block).not.toMatch(/Locating code/);
    expect(block).not.toMatch(/implementation slice/);
    expect(block).not.toMatch(/A code review of your changes/);
    expect(block).toMatch(/outside this repo \(docs, APIs, the web, standards\)/);
  });

  it("tells the caller that subagents start with empty context", () => {
    const block = delegationBlock("opus", pools);
    expect(block).toContain("EMPTY context");
    expect(block).toMatch(/recall the main-session\s*\n?history/);
  });
});

describe("toolsBlock only advertises granted tools", () => {
  it("omits pp_register_repo and lsp/cbm guidance for a minimal agent", () => {
    const block = toolsBlock(parseToolNames("read, bash, grep, find, web_search, web_fetch"));
    expect(block).not.toContain("pp_register_repo");
    expect(block).not.toContain("lsp goToDefinition");
    expect(block).not.toContain("cbm_search");
    expect(block).toContain("web_search");
  });

  it("includes pp_register_repo and the lsp/grep guidance for the main tool set", () => {
    const block = toolsBlock(["read", "bash", "edit", "write", "grep", "find", "ls", "lsp", "cbm_search", "pp_register_repo"]);
    expect(block).toContain("pp_register_repo");
    expect(block).toContain("Prefer lsp goToDefinition over grep");
    expect(block).toContain("cbm_search");
  });

  it("describes both root and current-session recall only when granted", () => {
    const block = toolsBlock(["read", "vcc_recall"]);
    expect(block).toContain("vcc_recall: retrieve full detail");
    expect(block).toContain('source:"current"');
    expect(block).toContain('source:"root"');
    expect(toolsBlock(["read", "grep"])).not.toContain("vcc_recall");
  });

  it("describes the generic read/run capabilities, not just code navigation", () => {
    const block = toolsBlock(["read", "ls", "find", "bash"]);
    expect(block).toMatch(/source, config, docs, logs, data/);
    expect(block).toMatch(/builds, tests, queries, data processing/);
  });
});

describe("pre-1.0 principles", () => {
  it("preserves the universal principles from the pre-1.0 prompt", () => {
    for (const phrase of [
      "Verify, don't assume",
      "Never guess paths, types, or APIs",
      "Evidence over claims",
      "Show fresh tool output",
      "Match existing patterns",
      "Reading one neighboring file is not enough",
      "Be concise and dense",
      "Think critically",
    ]) {
      expect(principlesBlock()).toContain(phrase);
    }
  });

  it("the shared block is embedded in every worker prompt", () => {
    for (const [, f] of workerFactories()) {
      expect(f.prompt).toContain("Evidence over claims");
      expect(f.prompt).toContain("Verify, don't assume");
    }
  });

  it("read-only workers do NOT carry code-editing rules", () => {
    const readOnly = workerFactories().filter(([name]) => name !== "task");
    for (const [, f] of readOnly) {
      expect(f.prompt).not.toContain("Keep everything as private as possible");
      expect(f.prompt).not.toContain("NEVER comment a private (non-exported) symbol");
    }
  });

  it("the edit-capable task factory leaves code-editing rules to skills", () => {
    const t = createTaskAgent(config);
    expect(t.prompt).not.toContain("Keep everything as private as possible");
    expect(t.prompt).not.toContain("NEVER comment a private (non-exported) symbol");
  });
});

describe("every worker can recall root and current-session history", () => {
  it("grants vcc_recall", () => {
    for (const [, f] of workerFactories()) {
      expect(parseToolNames(f.frontmatter.tools)).toContain("vcc_recall");
    }
  });

  it("instructs the worker how to select root and current history", () => {
    for (const [, f] of workerFactories()) {
      expect(f.prompt).toMatch(/recall the main session's history|recall the main-session|main session's history/i);
      expect(f.prompt).toContain('source:"current"');
      expect(f.prompt).toContain('source:"root"');
    }
  });
});

describe("workers are functional roles, not coding-only roles", () => {
  it("descriptions and prompts admit non-code material", () => {
    const descs = Object.fromEntries(workerFactories().map(([n, f]) => [n, f.frontmatter.description]));
    expect(descs.explore).toMatch(/config, data, logs, or code/);
    expect(descs.librarian).toMatch(/standards|vendors|prior art/);
    expect(descs.task).toMatch(/data or operational steps|documents/);
    expect(descs.reviewer).toMatch(/document, a config or data change/);
    expect(descs["deep-debugger"]).toMatch(/pipeline or command|bad output or data/);
  });

  it("no worker is described as exclusively about code", () => {
    for (const [, f] of workerFactories()) {
      expect(f.frontmatter.description).not.toMatch(/\bcodebase\b/);
    }
  });
});

describe("worker execution limits", () => {
  it("defaults every pi-pi worker to unlimited turns", () => {
    for (const [, worker] of workerFactories()) {
      expect(worker.frontmatter.max_turns).toBeUndefined();
    }
  });

  it("applies user-configured turn limits to simple workers and pool entries", () => {
    const configured = getDefaultConfig();
    configured.agents.subagents.simple.explore.maxTurns = 12;
    configured.agents.subagents.simple.librarian.maxTurns = 13;
    configured.agents.subagents.simple.task.maxTurns = 14;

    expect(createExploreAgent(configured).frontmatter.max_turns).toBe(12);
    expect(createLibrarianAgent(configured).frontmatter.max_turns).toBe(13);
    expect(createTaskAgent(configured).frontmatter.max_turns).toBe(14);
    expect(createAdvisorAgent({ ...poolEntry, maxTurns: 15 }).frontmatter.max_turns).toBe(15);
    expect(createReviewerAgent({ ...gptEntry, maxTurns: 16 }).frontmatter.max_turns).toBe(16);
    expect(createDeepDebuggerAgent({ ...gptEntry, maxTurns: 17 }).frontmatter.max_turns).toBe(17);
  });
});

describe("free-form agent factories", () => {
  it("advisor is read-only (no write/edit) and reasons in Diagnosis/Options/Recommendation", () => {
    const a = createAdvisorAgent(poolEntry);
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
    const d = createDeepDebuggerAgent(gptEntry);
    expect(d.frontmatter.tools).toContain("write");
    expect(d.frontmatter.tools).toContain("edit");
    expect(d.prompt).toContain("DIAGNOSIS ONLY");
    expect(d.prompt).toContain("MUST NOT apply the actual fix");
  });

  it("reviewer is read-only, retains bash for git diff, and is verdict-first", () => {
    const r = createReviewerAgent(gptEntry);
    expect(r.frontmatter.tools).toContain("bash");
    expect(r.frontmatter.tools).not.toContain("write");
    expect(r.frontmatter.tools).not.toContain("edit");
    expect(r.prompt).toContain("git diff");
    expect(r.prompt).toContain("VERY FIRST LINE");
    expect(r.frontmatter.description).toContain("materially reduces risk");
  });
});

describe("task stays a bounded, self-contained worker", () => {
  it("takes only config (no baked artifact arg) and does not inline artifacts", () => {
    expect(createTaskAgent.length).toBe(1);
    const t = createTaskAgent(config);
    expect(t.prompt).not.toContain("=== USER REQUEST ===");
    expect(t.prompt).not.toContain("=== SYNTHESIZED PLAN ===");
    expect(t.prompt).toContain("You have no subagents");
    expect(t.prompt).not.toContain("Agent(subagent_type");
  });

  it("is explicitly never the whole-task owner", () => {
    const t = createTaskAgent(config);
    expect(t.prompt).toContain("You own YOUR SLICE ONLY, never the whole task");
    expect(t.prompt).toMatch(/STOP and report that back/);
    expect(t.frontmatter.description).toMatch(/not for open-ended design, whole-task ownership/);
  });

  it("keeps domain-specific software policy out of the generic worker", () => {
    const prompt = createTaskAgent(config).prompt;
    for (const phrase of ["SOURCE CODE", "Test-first policy", "Keep everything as private", "NEVER comment a private"]) {
      expect(prompt).not.toContain(phrase);
    }
    expect(prompt).toContain("fresh evidence");
    expect(prompt).toContain("vcc_recall");
  });
});

describe("routing-contract descriptions (what / when / exclusion)", () => {
  it("every worker description states a fit and an exclusion and carries the (pi-pi) suffix", () => {
    for (const [, f] of workerFactories()) {
      const d = f.frontmatter.description;
      expect(d).toMatch(/not for|not when|not every|not as|never/i);
      expect(d.endsWith("(pi-pi)")).toBe(true);
    }
  });

  it("keeps the role-specific fits and protected exclusions", () => {
    const descs = Object.fromEntries(workerFactories().map(([n, f]) => [n, f.frontmatter.description]));
    expect(descs.explore).toMatch(/locat|find|map/i);
    expect(descs.librarian).toMatch(/outside|docs|research/i);
    expect(descs.task).toMatch(/slice/i);
    expect(descs.advisor).toMatch(/judgment|tradeoff|why is this broken/i);
    expect(descs["deep-debugger"]).toContain("not every error");
    expect(descs.reviewer).toContain("not as a routine step");
  });

  it("delegationBlock remains the sole owner of numeric routing thresholds", () => {
    const pools = {
      advisors: [{ name: "advisor_x_high", model: "anthropic/claude-fable-latest", family: "fable", tier: "xsmart", thinking: "high" }],
      reviewers: [{ name: "reviewer_y_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
      deepDebuggers: [{ name: "deep-debugger_z_high", model: "openai/gpt-latest", family: "gpt", tier: "smart", thinking: "high" }],
    };
    expect(delegationBlock("opus", pools)).toContain("2–3 parallel");
    expect(delegationBlock("opus", pools)).toContain("4+ only");
    for (const [, f] of workerFactories()) {
      expect(f.frontmatter.description).not.toMatch(/2–3|4\+/);
    }
  });
});

describe("affordance-aligned evidence gates", () => {
  it("the edit-capable task delegate carries the evidence gate + N/A path", () => {
    const t = createTaskAgent(config);
    expect(t.prompt).toContain("Verification gate");
    expect(t.prompt).toContain("what remains unverified and why");
    expect(t.prompt).toMatch(/fresh evidence/i);
  });

  it("the read-only reviewer restricts evidence to what its tools can produce", () => {
    const r = createReviewerAgent(gptEntry);
    expect(r.prompt).toMatch(/MUST NOT run tests|Do NOT run test suites/i);
    expect(r.prompt).toContain("OPEN QUESTIONS");
  });
});

describe("advisor anti-sycophancy", () => {
  it("requires taking a position + naming what would change it, behavior-framed with any quoted phrase marked as an example", () => {
    const a = createAdvisorAgent(poolEntry).prompt;
    expect(a).toContain("Take a position");
    expect(a).toMatch(/what evidence would change|what would change/i);
    expect(a).toMatch(/in any language|targets the behavior/i);
    expect(a).toMatch(/illustrative anti-patterns[^\n]{0,40}'that could work'/);
  });
});
