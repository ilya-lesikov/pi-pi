import { describe, expect, it } from "vitest";
import {
  DelegationDetector,
  classifyTool,
  commandFamily,
  isDiscretionarySpawn,
  broadSearchPhaseEnabled,
  stuckDebugPhaseEnabled,
  delegationNudgeMessage,
  BROAD_SEARCH_MIN_CALLS,
  STUCK_DEBUG_MIN_FAILURES,
  STUCK_DEBUG_MIN_PHASE_TURNS,
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

function feedSearch(d: DelegationDetector, paths: string[]): void {
  paths.forEach((p, i) => {
    const id = `t${i}`;
    d.recordToolStart(id, "read", { path: p });
    d.recordToolEnd(id, "read", false);
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

  it("is suppressed once an explore spawn is observed in the window", () => {
    const d = new DelegationDetector();
    feedSearch(d, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    d.onExploreSpawned();
    expect(d.evaluate("implement", 5)).toBeNull();
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
      d.recordToolEnd(`b${i}`, "bash", false);
    });
    expect(d.evaluate("implement", 5)).toMatchObject({ signal: "broad-search" });
  });

  it("does NOT count non-search bash toward broad-search", () => {
    const d = new DelegationDetector();
    ["git status", "go build ./...", "npm test", "cd x", "make"].forEach((c, i) => {
      d.recordToolStart(`b${i}`, "bash", { command: c });
      d.recordToolEnd(`b${i}`, "bash", false);
    });
    expect(d.evaluate("implement", 5)).toBeNull();
  });
});

describe("DelegationDetector stuck-debug", () => {
  it("fires after repeated failures on the same command family", () => {
    const d = new DelegationDetector();
    for (let i = 0; i < STUCK_DEBUG_MIN_FAILURES; i++) {
      d.recordToolStart(`f${i}`, "bash", { command: "go test ./..." });
      d.recordToolEnd(`f${i}`, "bash", true);
    }
    expect(d.evaluate("implement", 3)).toMatchObject({ signal: "stuck-debug", recommendedRole: "deep-debugger" });
  });

  it("does NOT fire on a single failure", () => {
    const d = new DelegationDetector();
    d.recordToolStart("f0", "bash", { command: "go test ./..." });
    d.recordToolEnd("f0", "bash", true);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("does NOT fire when stderr-bearing commands SUCCEED (isError=false)", () => {
    const d = new DelegationDetector();
    for (let i = 0; i < STUCK_DEBUG_MIN_FAILURES + 2; i++) {
      d.recordToolStart(`f${i}`, "bash", { command: "go test ./..." });
      d.recordToolEnd(`f${i}`, "bash", false);
    }
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("resets the streak when the failing family later succeeds", () => {
    const d = new DelegationDetector();
    d.recordToolStart("f0", "bash", { command: "go test ./..." });
    d.recordToolEnd("f0", "bash", true);
    d.recordToolStart("f1", "bash", { command: "go test ./..." });
    d.recordToolEnd("f1", "bash", true);
    // Success converges — streak cleared.
    d.recordToolStart("f2", "bash", { command: "go test ./..." });
    d.recordToolEnd("f2", "bash", false);
    d.recordToolStart("f3", "bash", { command: "go test ./..." });
    d.recordToolEnd("f3", "bash", true);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("does not confuse failures across DIFFERENT command families", () => {
    const d = new DelegationDetector();
    d.recordToolStart("f0", "bash", { command: "go test ./..." });
    d.recordToolEnd("f0", "bash", true);
    d.recordToolStart("f1", "bash", { command: "npm run build" });
    d.recordToolEnd("f1", "bash", true);
    d.recordToolStart("f2", "bash", { command: "pytest" });
    d.recordToolEnd("f2", "bash", true);
    expect(d.evaluate("implement", 3)).toBeNull();
  });

  it("fires on a long edit loop with no convergence", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false);
    expect(d.evaluate("implement", STUCK_DEBUG_MIN_PHASE_TURNS)).toMatchObject({ signal: "stuck-debug" });
  });

  it("edit-loop leg is cleared by a pp_commit convergence signal", () => {
    const d = new DelegationDetector();
    d.onPhaseChange(0);
    d.recordToolStart("e0", "edit", { path: "x.ts" });
    d.recordToolEnd("e0", "edit", false);
    d.recordToolStart("c0", "pp_commit", {});
    d.recordToolEnd("c0", "pp_commit", false);
    expect(d.evaluate("implement", STUCK_DEBUG_MIN_PHASE_TURNS)).toBeNull();
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
