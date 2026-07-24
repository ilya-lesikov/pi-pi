import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAssumptionsBanner, readAssumptions, terminalAssumptionsSummary } from "./assumptions.js";

function taskDirWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-assumptions-"));
  if (content !== undefined) {
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "ASSUMPTIONS.md"), content, "utf-8");
  }
  return dir;
}

describe("readAssumptions", () => {
  it("treats an absent file as no assumptions", () => {
    expect(readAssumptions(taskDirWith())).toEqual([]);
  });

  it("treats an explicit _No open assumptions._ sentinel as none", () => {
    expect(readAssumptions(taskDirWith("# Assumptions\n\n_No open assumptions._\n"))).toEqual([]);
  });

  it("parses list items and classifies confidence and resolved status", () => {
    const md = [
      "# Assumptions",
      "",
      "- statement: API is idempotent; confidence: low; basis: docs; invalidation test: retry; decision impact: skip lock; status: open",
      "- statement: config lives in root; confidence: high; basis: grep; status: resolved",
    ].join("\n");
    const entries = readAssumptions(taskDirWith(md));
    expect(entries).toHaveLength(2);
    expect(entries[0].confidence).toBe("low");
    expect(entries[0].resolved).toBe(false);
    expect(entries[1].confidence).toBe("high");
    expect(entries[1].resolved).toBe(true);
  });
});

describe("openAssumptionsBanner", () => {
  it("is null when there are no open low/med entries", () => {
    expect(openAssumptionsBanner(taskDirWith())).toBeNull();
    const resolvedHigh = "# A\n\n- statement: x; confidence: high; status: resolved\n";
    expect(openAssumptionsBanner(taskDirWith(resolvedHigh))).toBeNull();
  });

  it("surfaces a count when open low/med entries exist", () => {
    const md = [
      "# A",
      "- statement: a; confidence: low; status: open",
      "- statement: b; confidence: med; status: open",
      "- statement: c; confidence: high; status: open",
    ].join("\n");
    const banner = openAssumptionsBanner(taskDirWith(md));
    expect(banner).toContain("2 unresolved");
    expect(banner).toContain("ASSUMPTIONS.md");
  });
});

describe("terminalAssumptionsSummary", () => {
  it("states none when empty", () => {
    expect(terminalAssumptionsSummary(taskDirWith())).toBe("Assumptions: none recorded.");
  });

  it("lists every recorded assumption with status regardless of confidence", () => {
    const md = [
      "# A",
      "- statement: a; confidence: low; status: open",
      "- statement: b; confidence: high; status: resolved",
    ].join("\n");
    const summary = terminalAssumptionsSummary(taskDirWith(md));
    expect(summary).toContain("Assumptions recorded this run (2)");
    expect(summary).toContain("[open, low]");
    expect(summary).toContain("[resolved, high]");
  });
});
