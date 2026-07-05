import { describe, expect, it } from "vitest";
import {
  DelegationDetector,
  classifyTool,
  commandFamily,
  isDiscretionarySpawn,
  spawnMatchesSignal,
  isPendingExpired,
  broadSearchPhaseEnabled,
  stuckDebugPhaseEnabled,
  delegationNudgeMessage,
  BROAD_SEARCH_WINDOW,
  BROAD_SEARCH_MIN_CALLS,
  STUCK_DEBUG_MIN_FAILURES,
  STUCK_DEBUG_MIN_PHASE_TURNS,
  NUDGE_SPAWN_CORRELATION_TURNS,
} from "./delegation-nudge.js";

describe("classifyTool", () => {
  it("treats read/grep/ls as search with a path", () => {
    expect(classifyTool("read", { path: "src/a.ts" })).toMatchObject({ isSearch: true, path: "src/a.ts", isBash: false });
    expect(classifyTool("ls", { path: "src/" })).toMatchObject({ isSearch: true, isBash: false });
    expect(classifyTool("grep", { path: "src/b.ts" })).toMatchObject({ isSearch: true });
  });

  it("treats find pattern as the path target", () => {
    expect(classifyTool("find", { pattern: "**/*.ts" })).toMatchObject({ isSearch: true, path: "**/*.ts" });
  });

  it("classifies allowlisted bash commands as search", () => {
    expect(classifyTool("bash", { command: "grep -rn foo src/" })).toMatchObject({ isSearch: true, isBash: true });
    expect(classifyTool("bash", { command: "rg foo" })).toMatchObject({ isSearch: true, isBash: true });
    expect(classifyTool("bash", { command: "find . -name '*.ts'" })).toMatchObject({ isSearch: true, isBash: true });
  });

  it("does NOT classify git/build/test bash as search", () => {
    expect(classifyTool("bash", { command: "git status" })).toMatchObject({ isSearch: false, isBash: true });
    expect(classifyTool("bash", { command: "go test ./..." })).toMatchObject({ isSearch: false, isBash: true });
    expect(classifyTool("bash", { command: "cd /foo && npm run build" })).toMatchObject({ isSearch: false, isBash: true });
  });

  it("ignores leading env assignments when finding the executable", () => {
    expect(classifyTool("bash", { command: "FOO=bar grep pattern file" })).toMatchObject({ isSearch: true });
  });

  it("is defensive against malformed args", () => {
    expect(classifyTool("read", undefined)).toMatchObject({ isSearch: true });
    expect(classifyTool("bash", {})).toMatchObject({ isSearch: false, isBash: true });
    expect(classifyTool("unknown-tool", { foo: 1 })).toMatchObject({ isSearch: false, isBash: false });
  });
});

describe("commandFamily", () => {
  it("keeps the subcommand for multiplexers", () => {
    expect(commandFamily("go test ./...")).toBe("go test");
    expect(commandFamily("npm run build")).toBe("npm run");
    expect(commandFamily("git commit -m x")).toBe("git commit");
  });
  it("uses the executable alone for non-multiplexers", () => {
    expect(commandFamily("pytest -q")).toBe("pytest");
    expect(commandFamily("./gradlew build")).toBe("gradlew");
  });
});

describe("isDiscretionarySpawn", () => {
  it("accepts the six free-form roles", () => {
    for (const t of ["explore", "librarian", "task", "advisor", "deep-debugger", "reviewer"]) {
      expect(isDiscretionarySpawn(t)).toBe(true);
    }
  });
  it("rejects orchestrated triad spawns and empties", () => {
    expect(isDiscretionarySpawn("planner_opus")).toBe(false);
    expect(isDiscretionarySpawn("code_reviewer_gemini")).toBe(false);
    expect(isDiscretionarySpawn(undefined)).toBe(false);
    expect(isDiscretionarySpawn("")).toBe(false);
  });
});

describe("phase gating", () => {
  it("broad-search fires in brainstorm/implement/quick only", () => {
    expect(broadSearchPhaseEnabled("brainstorm")).toBe(true);
    expect(broadSearchPhaseEnabled("implement")).toBe(true);
    expect(broadSearchPhaseEnabled("quick")).toBe(true);
    expect(broadSearchPhaseEnabled("plan")).toBe(false);
    expect(broadSearchPhaseEnabled("review")).toBe(false);
  });
  it("stuck-debug fires in debug/implement/quick only (not brainstorm/plan/review)", () => {
    expect(stuckDebugPhaseEnabled("debug")).toBe(true);
    expect(stuckDebugPhaseEnabled("implement")).toBe(true);
    expect(stuckDebugPhaseEnabled("quick")).toBe(true);
    expect(stuckDebugPhaseEnabled("brainstorm")).toBe(false);
    expect(stuckDebugPhaseEnabled("plan")).toBe(false);
    expect(stuckDebugPhaseEnabled("review")).toBe(false);
  });
});

function feedSearch(d: DelegationDetector, paths: string[], turnIndex = 0): void {
  paths.forEach((p, i) => {
    const id = `t${i}-${Math.random()}`;
    d.recordToolStart(id, "read", { path: p });
    d.recordToolEnd(id, "read", false, turnIndex);
  });
}

describe("DelegationDetector broad-search", () => {
  it("does NOT fire below the call threshold", () => {
    const d = new DelegationDetector();
    feedSearch(d, ["a.ts", "b.ts"]);
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("does NOT fire when calls hit threshold but distinct paths do not", () => {
    const d = new DelegationDetector();
    // BROAD_SEARCH_MIN_CALLS reads of the SAME file — an edit loop, not discovery.
    feedSearch(d, Array(BROAD_SEARCH_MIN_CALLS).fill("same.ts"));
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("fires past threshold with enough distinct paths", () => {
    const d = new DelegationDetector();
    feedSearch(d, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(d.evaluate("implement", 5)).toMatchObject({ signal: "broad-search", recommendedRole: "explore" });
  });

  it("is suppressed by an explore spawn while it is still within the rolling window", () => {
    const d = new DelegationDetector();
    feedSearch(d, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    d.onExploreSpawned();
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("can fire again once the explore spawn has rolled out of the window (M4)", () => {
    const d = new DelegationDetector();
    feedSearch(d, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    d.onExploreSpawned();
    expect(d.evaluate("implement", 5)).toBeNull();
    // Enough NEW distinct search calls to push the spawn fully out of the window.
    const more = Array.from({ length: BROAD_SEARCH_WINDOW }, (_, i) => `n${i}.ts`);
    feedSearch(d, more);
    expect(d.evaluate("implement", 6)).toMatchObject({ signal: "broad-search" });
  });

  it("counts allowlisted bash-search targets toward the distinct set", () => {
    const d = new DelegationDetector();
    const cmds = [
      "grep -rn foo src/a.ts",
      "grep -rn foo src/b.ts",
      "rg bar src/c.ts",
      "find src/d -name x",
      "cat src/e.ts",
    ];
    cmds.forEach((c, i) => {
      d.recordToolStart(`b${i}`, "bash", { command: c });
      d.recordToolEnd(`b${i}`, "bash", false, 0);
    });
    expect(d.evaluate("implement", 5)).toMatchObject({ signal: "broad-search" });
  });

  it("counts `cd <repo> && grep` wrapped searches (M1)", () => {
    const d = new DelegationDetector();
    const cmds = [
      "cd /repo && grep -rn foo src/a.ts",
      "cd /repo && grep -rn foo src/b.ts",
      "cd /repo && rg bar src/c.ts",
      "cd /repo && find src/d -name x",
      "cd /repo && cat src/e.ts",
    ];
    cmds.forEach((c, i) => {
      d.recordToolStart(`b${i}`, "bash", { command: c });
      d.recordToolEnd(`b${i}`, "bash", false, 0);
    });
    expect(d.evaluate("implement", 5)).toMatchObject({ signal: "broad-search" });
  });

  it("does NOT count non-search bash toward broad-search", () => {
    const d = new DelegationDetector();
    ["git status", "go build ./...", "npm test", "cd x", "make"].forEach((c, i) => {
      d.recordToolStart(`b${i}`, "bash", { command: c });
      d.recordToolEnd(`b${i}`, "bash", false, 0);
    });
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("ages searches out of the rolling TOOL-call window when non-search calls intervene (P2-1)", () => {
    const d = new DelegationDetector();
    const search = (p: string) => { const id = `s-${Math.random()}`; d.recordToolStart(id, "read", { path: p }); d.recordToolEnd(id, "read", false, 0); };
    const nonSearch = () => { const id = `n-${Math.random()}`; d.recordToolStart(id, "edit", { path: "z.ts" }); d.recordToolEnd(id, "edit", false, 0); };
    // 5 distinct searches, each separated by 2 non-search calls -> spread over 15 tool calls,
    // so no 8-tool window ever holds >=5 searches.
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].forEach((p) => { search(p); nonSearch(); nonSearch(); });
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("does NOT treat bare bash search PATTERNS as distinct paths (P2-2)", () => {
    const d = new DelegationDetector();
    ["rg Foo", "rg Bar", "grep Baz", "rg Qux", "grep Quux"].forEach((c, i) => {
      d.recordToolStart(`p${i}`, "bash", { command: c });
      d.recordToolEnd(`p${i}`, "bash", false, 0);
    });
    // Search calls count, but no distinct PATHS -> distinct clause not satisfied.
    expect(d.evaluate("implement", 5)).toBeNull();
  });

  it("still counts bash searches that DO carry a path (P2-2)", () => {
    const d = new DelegationDetector();
    ["grep Foo src/a.ts", "grep Bar src/b.ts", "rg Baz src/c.ts", "grep Qux src/d.ts", "rg Quux src/e.ts"].forEach((c, i) => {
      d.recordToolStart(`p${i}`, "bash", { command: c });
      d.recordToolEnd(`p${i}`, "bash", false, 0);
    });
    expect(d.evaluate("implement", 5)).toMatchObject({ signal: "broad-search" });
  });
});

describe("DelegationDetector stuck-debug", () => {
  function failN(d: DelegationDetector, command: string, n: number, isError = true) {
    for (let i = 0; i < n; i++) {
      const id = `f${i}-${Math.random()}`;
      d.recordToolStart(id, "bash", { command });
      d.recordToolEnd(id, "bash", isError, 0);
    }
  }

  it("fires after repeated failures on the same command family", () => {
    const d = new DelegationDetector();
    failN(d, "go test ./...", STUCK_DEBUG_MIN_FAILURES);
    expect(d.evaluate("implement", 3)).toMatchObject({ signal: "stuck-debug", recommendedRole: "deep-debugger" });
  });

  it("matches command family across `cd && go test` wrapping (M1)", () => {
    const d = new DelegationDetector();
    failN(d, "cd /repo && go test ./...", STUCK_DEBUG_MIN_FAILURES);
    expect(d.evaluate("implement", 3)).toMatchObject({ signal: "stuck-debug" });
  });

  it("does NOT fire on a single failure", () => {
    const d = new DelegationDetector();
    failN(d, "go test ./...", 1);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("does NOT fire when stderr-bearing commands SUCCEED (isError=false)", () => {
    const d = new DelegationDetector();
    failN(d, "go test ./...", STUCK_DEBUG_MIN_FAILURES + 2, false);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("resets the streak when the failing family later succeeds", () => {
    const d = new DelegationDetector();
    failN(d, "go test ./...", 2);
    failN(d, "go test ./...", 1, false);
    failN(d, "go test ./...", 1);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("does not confuse failures across DIFFERENT command families", () => {
    const d = new DelegationDetector();
    failN(d, "go test ./...", 1);
    failN(d, "npm run build", 1);
    failN(d, "pytest", 1);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("fires on a long edit loop with no convergence", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false, 1);
    expect(d.evaluate("implement", STUCK_DEBUG_MIN_PHASE_TURNS)).toMatchObject({ signal: "stuck-debug" });
  });

  it("edit-loop leg is cleared by a pp_commit convergence signal", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false, 1);
    d.recordToolStart("c0", "pp_commit", {});
    d.recordToolEnd("c0", "pp_commit", false, 2);
    expect(d.evaluate("implement", STUCK_DEBUG_MIN_PHASE_TURNS)).toBeNull();
  });

  it("does NOT re-fire on an edit AFTER a commit past the 20-turn mark (M5)", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    // Edit + commit at turn 21 (past threshold from phase start).
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false, 21);
    d.recordToolStart("c0", "pp_commit", {});
    d.recordToolEnd("c0", "pp_commit", false, 21);
    // A subsequent edit must NOT immediately re-fire — the window restarted at the commit.
    d.recordToolStart("e1", "edit", { path: "y.ts" });
    d.recordToolEnd("e1", "edit", false, 22);
    expect(d.evaluate("implement", 22)).toBeNull();
    // Only after another full 20 turns without convergence does it fire again.
    expect(d.evaluate("implement", 21 + STUCK_DEBUG_MIN_PHASE_TURNS)).toMatchObject({ signal: "stuck-debug" });
  });

  it("a FAILED pp_commit does NOT converge the edit loop (P2-3)", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false, 1);
    // Failed commit (isError=true) must NOT clear the signal.
    d.recordToolStart("c0", "pp_commit", {});
    d.recordToolEnd("c0", "pp_commit", true, 2);
    expect(d.evaluate("implement", STUCK_DEBUG_MIN_PHASE_TURNS)).toMatchObject({ signal: "stuck-debug" });
  });
});

describe("effectiveness helpers", () => {
  it("spawnMatchesSignal maps signals to roles (M2)", () => {
    expect(spawnMatchesSignal("broad-search", "explore")).toBe(true);
    expect(spawnMatchesSignal("broad-search", "task")).toBe(false);
    expect(spawnMatchesSignal("broad-search", "librarian")).toBe(false);
    expect(spawnMatchesSignal("stuck-debug", "deep-debugger")).toBe(true);
    expect(spawnMatchesSignal("stuck-debug", "advisor")).toBe(true);
    expect(spawnMatchesSignal("stuck-debug", "explore")).toBe(false);
    expect(spawnMatchesSignal("broad-search", undefined)).toBe(false);
  });

  it("isPendingExpired respects the correlation window (M3)", () => {
    const pending = { nudgeId: "n1", signal: "broad-search" as const, recommendedRole: "explore", firedTurnIndex: 10 };
    expect(isPendingExpired(pending, 10 + NUDGE_SPAWN_CORRELATION_TURNS)).toBe(false);
    expect(isPendingExpired(pending, 10 + NUDGE_SPAWN_CORRELATION_TURNS + 1)).toBe(true);
  });
});

describe("delegationNudgeMessage", () => {
  it("recommends explore for broad-search and is [PI-PI]-prefixed", () => {
    const m = delegationNudgeMessage("broad-search", "implement");
    expect(m.startsWith("[PI-PI]")).toBe(true);
    expect(m).toContain("explore");
  });
  it("recommends deep-debugger/advisor for stuck-debug", () => {
    const m = delegationNudgeMessage("stuck-debug", "implement");
    expect(m.startsWith("[PI-PI]")).toBe(true);
    expect(m).toContain("deep-debugger");
    expect(m).toContain("advisor");
  });
});
