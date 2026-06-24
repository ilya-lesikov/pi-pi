import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getLatestSynthesizedPlan,
  getPhaseArtifacts,
  loadContextFiles,
  loadBrainstormReviewOutputs,
  loadCodeReviewOutputs,
  loadPlanReviewOutputs,
} from "./context.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-context-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadContextFiles", () => {
  it("returns empty array when context directory is missing", () => {
    const cwd = makeTempDir();
    expect(loadContextFiles(cwd, "main")).toEqual([]);
  });

  it("defaults files without frontmatter to context mode and main agent", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "plain.md"), "hello world\n", "utf-8");

    expect(loadContextFiles(cwd, "main")).toEqual([{ mode: "context", content: "hello world" }]);
    expect(loadContextFiles(cwd, "explore")).toEqual([]);
  });

  it("filters by inject mode", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "system.md"),
      "---\ninject: system\nagents: main\n---\nSystem text\n",
      "utf-8",
    );
    writeFileSync(
      join(contextDir, "context.md"),
      "---\ninject: context\nagents: main\n---\nContext text\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "main", "system")).toEqual([{ mode: "system", content: "System text" }]);
    expect(loadContextFiles(cwd, "main", "context")).toEqual([{ mode: "context", content: "Context text" }]);
  });

  it("supports specific agents, agent groups, and main default", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(join(contextDir, "all.md"), "---\nagentGroups: all\n---\nall agents\n", "utf-8");
    writeFileSync(join(contextDir, "sub.md"), "---\nagentGroups: subagents\n---\nsub only\n", "utf-8");
    writeFileSync(join(contextDir, "explore.md"), "---\nagents: explore\n---\nexplore only\n", "utf-8");
    writeFileSync(join(contextDir, "default.md"), "---\n\n---\ndefault main\n", "utf-8");

    expect(loadContextFiles(cwd, "main").map((f) => f.content).sort()).toEqual(["all agents", "default main"]);
    expect(loadContextFiles(cwd, "explore").map((f) => f.content).sort()).toEqual([
      "all agents",
      "explore only",
      "sub only",
    ]);
  });

  it("handles quoted frontmatter values and bracket array syntax", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "quoted.md"),
      "---\ninject: \"system\"\nagents: ['main', \"explore\"]\n---\nquoted\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "main", "system")).toEqual([{ mode: "system", content: "quoted" }]);
    expect(loadContextFiles(cwd, "explore", "system")).toEqual([{ mode: "system", content: "quoted" }]);
  });

  it("ignores invalid inject mode and keeps default context mode", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "bad-inject.md"),
      "---\ninject: invalid\nagents: main\n---\nuses default inject\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "main", "system")).toEqual([]);
    expect(loadContextFiles(cwd, "main", "context")).toEqual([{ mode: "context", content: "uses default inject" }]);
  });

  it("filters invalid agent names", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "mixed-agents.md"),
      "---\nagents: [main, unknown, fake]\n---\nonly main allowed\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "main")).toEqual([{ mode: "context", content: "only main allowed" }]);
    expect(loadContextFiles(cwd, "explore")).toEqual([]);
  });

  it("supports brainstormReviewer agent type", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "brainstorm-reviewer.md"),
      "---\nagents: brainstormReviewer\n---\nbrainstorm reviewer only\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "brainstormReviewer")).toEqual([{ mode: "context", content: "brainstorm reviewer only" }]);
    expect(loadContextFiles(cwd, "codeReviewer")).toEqual([]);
  });

  it("parses phase/vendor/family/tier filters and matches when all filters pass", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "filtered.md"),
      "---\ninject: system\nagents: ['planner']\nphases: ['plan']\nvendors: ['anthropic']\nfamilies: ['sonnet']\ntiers: ['regular']\n---\nfiltered\n",
      "utf-8",
    );

    expect(
      loadContextFiles(cwd, "planner", "system", "plan", { vendor: "anthropic", family: "sonnet", tier: "regular" }),
    ).toEqual([{ mode: "system", content: "filtered" }]);
  });

  it("uses AND between filters and OR inside each filter", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "or-and.md"),
      "---\nagents: [codeReviewer]\nphases: [implement, review]\nvendors: [openai, anthropic]\nfamilies: [gpt, gpt-mini]\ntiers: [regular, stupid]\n---\nmatched\n",
      "utf-8",
    );

    expect(
      loadContextFiles(cwd, "codeReviewer", "context", "review", { vendor: "openai", family: "gpt-mini", tier: "stupid" }),
    ).toEqual([{ mode: "context", content: "matched" }]);

    expect(
      loadContextFiles(cwd, "codeReviewer", "context", "review", { vendor: "google", family: "gpt-mini", tier: "stupid" }),
    ).toEqual([]);
    expect(
      loadContextFiles(cwd, "codeReviewer", "context", "debug", { vendor: "openai", family: "gpt-mini", tier: "stupid" }),
    ).toEqual([]);
  });

  it("treats empty filter arrays as match-all", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "empty-filters.md"),
      "---\nagents: [planner]\nphases: []\nvendors: []\nfamilies: []\ntiers: []\n---\nno restrictions\n",
      "utf-8",
    );

    expect(
      loadContextFiles(cwd, "planner", "context", "plan", { vendor: "unknown", family: "unknown", tier: "unknown" }),
    ).toEqual([{ mode: "context", content: "no restrictions" }]);
    expect(loadContextFiles(cwd, "planner", "context")).toEqual([{ mode: "context", content: "no restrictions" }]);
  });

  it("applies filter restrictions only when phase/model info are provided", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "requires-filters.md"),
      "---\nagents: [planner]\nphases: [plan]\nvendors: [anthropic]\nfamilies: [sonnet]\ntiers: [regular]\n---\nrestricted\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "planner", "context")).toEqual([{ mode: "context", content: "restricted" }]);
    expect(loadContextFiles(cwd, "planner", "context", "plan")).toEqual([{ mode: "context", content: "restricted" }]);
    expect(
      loadContextFiles(cwd, "planner", "context", "plan", { vendor: "openai", family: "gpt", tier: "regular" }),
    ).toEqual([]);
  });

  it("skips non-markdown files", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(join(contextDir, "notes.txt"), "---\nagents: main\n---\nshould skip\n", "utf-8");
    writeFileSync(join(contextDir, "ok.md"), "---\nagents: main\n---\nshould include\n", "utf-8");

    expect(loadContextFiles(cwd, "main")).toEqual([{ mode: "context", content: "should include" }]);
  });

  it("logs and skips files that fail to read", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    const brokenPath = join(contextDir, "broken.md");
    writeFileSync(brokenPath, "broken", "utf-8");
    chmodSync(brokenPath, 0o000);
    writeFileSync(join(contextDir, "good.md"), "---\nagents: main\n---\ngood file\n", "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = loadContextFiles(cwd, "main");

    expect(result).toEqual([{ mode: "context", content: "good file" }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("Failed to read context file");
    expect(String(errorSpy.mock.calls[0][0])).toContain("broken.md");
  });
});

describe("getPhaseArtifacts", () => {
  it("returns user request and research artifacts for plan", () => {
    const taskDir = makeTempDir();
    writeFileSync(join(taskDir, "USER_REQUEST.md"), "user request", "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), "research notes", "utf-8");

    expect(getPhaseArtifacts(taskDir, "plan")).toEqual([
      { name: "USER_REQUEST.md", content: "user request" },
      { name: "RESEARCH.md", content: "research notes" },
    ]);
  });

  it("includes latest synthesized plan for plan and implement", () => {
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(taskDir, "USER_REQUEST.md"), "request", "utf-8");
    writeFileSync(join(plansDir, "20260101_synthesized.md"), "old plan", "utf-8");
    writeFileSync(join(plansDir, "20260102_synthesized.md"), "new plan", "utf-8");

    expect(getPhaseArtifacts(taskDir, "implement")).toEqual([
      { name: "USER_REQUEST.md", content: "request" },
      { name: "Synthesized Plan", content: "new plan" },
    ]);

    expect(getPhaseArtifacts(taskDir, "plan")).toEqual([
      { name: "USER_REQUEST.md", content: "request" },
      { name: "Synthesized Plan", content: "new plan" },
    ]);
  });
});

describe("getLatestSynthesizedPlan", () => {
  it("returns null when plans directory is missing or has no synthesized files", () => {
    const taskDir = makeTempDir();
    expect(getLatestSynthesizedPlan(taskDir)).toBeNull();

    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "other.md"), "not synthesized", "utf-8");

    expect(getLatestSynthesizedPlan(taskDir)).toBeNull();
  });

  it("returns content of lexicographically latest synthesized file", () => {
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    writeFileSync(join(plansDir, "001_synthesized.md"), "first", "utf-8");
    writeFileSync(join(plansDir, "010_synthesized.md"), "latest", "utf-8");

    expect(getLatestSynthesizedPlan(taskDir)).toBe("latest");
  });
});

describe("context regressions", () => {
  it("parses bracket array values without truncation when closing bracket is missing", () => {
    const cwd = makeTempDir();
    const contextDir = join(cwd, ".pp", "context");
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, "broken-array.md"),
      "---\nagents: [main, explore\n---\nregression body\n",
      "utf-8",
    );

    expect(loadContextFiles(cwd, "main")).toEqual([{ mode: "context", content: "regression body" }]);
    expect(loadContextFiles(cwd, "explore")).toEqual([{ mode: "context", content: "regression body" }]);
  });

  it("selects numerically latest synthesized plan in getLatestSynthesizedPlan", () => {
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    writeFileSync(join(plansDir, "999_synthesized.md"), "old", "utf-8");
    writeFileSync(join(plansDir, "1000_synthesized.md"), "new", "utf-8");

    expect(getLatestSynthesizedPlan(taskDir)).toBe("new");
  });

  it("selects numerically latest synthesized plan in getPhaseArtifacts implement phase", () => {
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    writeFileSync(join(plansDir, "999_synthesized.md"), "old", "utf-8");
    writeFileSync(join(plansDir, "1000_synthesized.md"), "new", "utf-8");

    expect(getPhaseArtifacts(taskDir, "implement")).toEqual([{ name: "Synthesized Plan", content: "new" }]);
  });

  it("filters brainstorm and code review outputs by pass", () => {
    const taskDir = makeTempDir();
    const brainstormReviewsDir = join(taskDir, "brainstorm-reviews");
    const codeReviewsDir = join(taskDir, "code-reviews");
    mkdirSync(brainstormReviewsDir, { recursive: true });
    mkdirSync(codeReviewsDir, { recursive: true });

    writeFileSync(join(brainstormReviewsDir, "001_alpha_round-1.md"), "brainstorm", "utf-8");
    writeFileSync(join(brainstormReviewsDir, "003_alpha_round-2.md"), "round2", "utf-8");
    writeFileSync(join(codeReviewsDir, "002_alpha_round-1.md"), "implement", "utf-8");
    writeFileSync(join(codeReviewsDir, "004_alpha_round-2.md"), "round2", "utf-8");

    expect(loadBrainstormReviewOutputs(taskDir, 1).map((r) => r.name)).toEqual([
      "001_alpha_round-1.md",
    ]);
    expect(loadCodeReviewOutputs(taskDir, 1).map((r) => r.name)).toEqual([
      "002_alpha_round-1.md",
    ]);

    expect(loadBrainstormReviewOutputs(taskDir, 2).map((r) => r.name)).toEqual([
      "003_alpha_round-2.md",
    ]);
    expect(loadCodeReviewOutputs(taskDir, 2).map((r) => r.name)).toEqual([
      "004_alpha_round-2.md",
    ]);
  });

  it("loads all plan review outputs regardless of pass", () => {
    const taskDir = makeTempDir();
    const planReviewsDir = join(taskDir, "plan-reviews");
    mkdirSync(planReviewsDir, { recursive: true });

    writeFileSync(join(planReviewsDir, "001_alpha.md"), "a", "utf-8");
    writeFileSync(join(planReviewsDir, "002_beta.md"), "b", "utf-8");

    expect(loadPlanReviewOutputs(taskDir).map((r) => r.name)).toEqual([
      "001_alpha.md",
      "002_beta.md",
    ]);
  });
});
