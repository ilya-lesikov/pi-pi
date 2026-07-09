import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const mockState = vi.hoisted(() => ({
  agentDir: "",
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockState.agentDir,
}));

import {
  getContextDirs,
  getLatestSynthesizedPlan,
  getArtifactManifest,
  formatManifestBlock,
  getPhaseArtifacts,
  loadAllContextFiles,
  loadContextFiles,
  loadBrainstormReviewOutputs,
  loadCodeReviewOutputs,
  loadPlanReviewOutputs,
  loadPhaseReviewOutputs,
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

    const result = loadContextFiles(cwd, "main");

    expect(result).toEqual([{ mode: "context", content: "good file" }]);
  });
});

describe("loadAllContextFiles", () => {
  it("loads files from all provided directories preserving directory order", () => {
    const root = makeTempDir();
    const dirA = join(root, "ctx-a");
    const dirB = join(root, "ctx-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    writeFileSync(join(dirA, "a.md"), "---\nagents: main\n---\nfrom a\n", "utf-8");
    writeFileSync(join(dirB, "b.md"), "---\nagents: main\n---\nfrom b\n", "utf-8");

    expect(loadAllContextFiles([dirA, dirB], "main")).toEqual([
      { mode: "context", content: "from a" },
      { mode: "context", content: "from b" },
    ]);
  });
});

describe("getContextDirs", () => {
  it("returns global, root, and extra repo context dirs in order", () => {
    const root = makeTempDir();
    const extra = makeTempDir();
    const agentDir = makeTempDir();
    mockState.agentDir = agentDir;
    mkdirSync(join(root, ".pp", "context"), { recursive: true });
    mkdirSync(join(extra, ".pp", "context"), { recursive: true });
    mkdirSync(join(agentDir, "extensions", "pp", "context"), { recursive: true });

    expect(
      getContextDirs(
        root,
        [
          { path: root, isRoot: true },
          { path: extra, isRoot: false },
        ],
        true,
      ),
    ).toEqual([
      join(agentDir, "extensions", "pp", "context"),
      join(root, ".pp", "context"),
      join(extra, ".pp", "context"),
    ]);
  });

  it("omits extra repos when ignoreExtraRepoConfigs is true", () => {
    const root = makeTempDir();
    const extra = makeTempDir();
    const agentDir = makeTempDir();
    mockState.agentDir = agentDir;
    mkdirSync(join(root, ".pp", "context"), { recursive: true });
    mkdirSync(join(extra, ".pp", "context"), { recursive: true });
    mkdirSync(join(agentDir, "extensions", "pp", "context"), { recursive: true });

    expect(
      getContextDirs(
        root,
        [
          { path: root, isRoot: true },
          { path: extra, isRoot: false },
        ],
        false,
      ),
    ).toEqual([
      join(agentDir, "extensions", "pp", "context"),
      join(root, ".pp", "context"),
    ]);
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

describe("getArtifactManifest", () => {
  it("returns empty when no artifacts or plan exist", () => {
    const taskDir = makeTempDir();
    expect(getArtifactManifest(taskDir)).toEqual([]);
  });

  it("extracts titles from artifact headings with a filename fallback", () => {
    const taskDir = makeTempDir();
    const artifactsDir = join(taskDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "design.md"), "# My Design\n\nbody", "utf-8");
    writeFileSync(join(artifactsDir, "notitle.md"), "no heading here", "utf-8");

    const manifest = getArtifactManifest(taskDir);
    expect(manifest).toEqual([
      { title: "My Design", path: join(artifactsDir, "design.md") },
      { title: "artifacts/notitle.md", path: join(artifactsDir, "notitle.md") },
    ]);
  });

  it("includes the latest synthesized plan with its REAL path, regardless of phase", () => {
    const taskDir = makeTempDir();
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "001_synthesized.md"), "old", "utf-8");
    writeFileSync(join(plansDir, "010_synthesized.md"), "new", "utf-8");

    const manifest = getArtifactManifest(taskDir);
    expect(manifest).toEqual([
      { title: "Synthesized implementation plan", path: join(plansDir, "010_synthesized.md") },
    ]);
  });
});

describe("formatManifestBlock", () => {
  it("emits the do-not-re-read line only when the manifest is empty", () => {
    const block = formatManifestBlock([]);
    expect(block).toContain("Do NOT re-read them from disk");
    expect(block).not.toContain("read them from disk with the read tool");
  });

  it("lists each manifest entry's path and title for on-demand reading", () => {
    const block = formatManifestBlock([
      { title: "Design", path: "/t/artifacts/design.md" },
      { title: "Synthesized implementation plan", path: "/t/plans/1_synthesized.md" },
    ]);
    expect(block).toContain("do NOT re-read them from disk");
    expect(block).toContain("- /t/artifacts/design.md  — Design");
    expect(block).toContain("- /t/plans/1_synthesized.md  — Synthesized implementation plan");
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

  it("does not let round-1 select round-10 outputs and excludes final-pass files", () => {
    const taskDir = makeTempDir();
    const codeReviewsDir = join(taskDir, "code-reviews");
    mkdirSync(codeReviewsDir, { recursive: true });

    writeFileSync(join(codeReviewsDir, "001_alpha_round-1.md"), "pass1", "utf-8");
    writeFileSync(join(codeReviewsDir, "010_alpha_round-10.md"), "pass10", "utf-8");
    writeFileSync(join(codeReviewsDir, "011_final_pass-1.md"), "synth", "utf-8");

    expect(loadCodeReviewOutputs(taskDir, 1).map((r) => r.name)).toEqual([
      "001_alpha_round-1.md",
    ]);
    expect(loadCodeReviewOutputs(taskDir, 10).map((r) => r.name)).toEqual([
      "010_alpha_round-10.md",
    ]);
  });

  it("filters plan review outputs by pass", () => {
    const taskDir = makeTempDir();
    const planReviewsDir = join(taskDir, "plan-reviews");
    mkdirSync(planReviewsDir, { recursive: true });

    writeFileSync(join(planReviewsDir, "001_alpha_round-1.md"), "a", "utf-8");
    writeFileSync(join(planReviewsDir, "002_beta_round-2.md"), "b", "utf-8");

    expect(loadPlanReviewOutputs(taskDir, 1).map((r) => r.name)).toEqual([
      "001_alpha_round-1.md",
    ]);
    expect(loadPlanReviewOutputs(taskDir, 2).map((r) => r.name)).toEqual([
      "002_beta_round-2.md",
    ]);
  });

  it("loadPhaseReviewOutputs reads brainstorm-reviews for both brainstorm and debug", () => {
    const taskDir = makeTempDir();
    const brainstormReviewsDir = join(taskDir, "brainstorm-reviews");
    mkdirSync(brainstormReviewsDir, { recursive: true });
    writeFileSync(join(brainstormReviewsDir, "001_alpha_round-1.md"), "artifact review", "utf-8");

    // Debug must resolve to the brainstorm-reviews dir (regression: it previously
    // fell through to the empty code-reviews dir, discarding reviewer outputs).
    expect(loadPhaseReviewOutputs(taskDir, "debug", 1).map((r) => r.name)).toEqual([
      "001_alpha_round-1.md",
    ]);
    expect(loadPhaseReviewOutputs(taskDir, "brainstorm", 1).map((r) => r.name)).toEqual([
      "001_alpha_round-1.md",
    ]);
  });

  it("loadPhaseReviewOutputs routes plan and implement/review to their own dirs", () => {
    const taskDir = makeTempDir();
    mkdirSync(join(taskDir, "plan-reviews"), { recursive: true });
    mkdirSync(join(taskDir, "code-reviews"), { recursive: true });
    writeFileSync(join(taskDir, "plan-reviews", "001_a_round-1.md"), "plan", "utf-8");
    writeFileSync(join(taskDir, "code-reviews", "002_a_round-1.md"), "code", "utf-8");

    expect(loadPhaseReviewOutputs(taskDir, "plan", 1).map((r) => r.name)).toEqual(["001_a_round-1.md"]);
    expect(loadPhaseReviewOutputs(taskDir, "implement", 1).map((r) => r.name)).toEqual(["002_a_round-1.md"]);
    expect(loadPhaseReviewOutputs(taskDir, "review", 1).map((r) => r.name)).toEqual(["002_a_round-1.md"]);
  });
});
