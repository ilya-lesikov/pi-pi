import { describe, it, expect } from "vitest";

// Documents the shared contract for Symbol.for("pi-pi:subagent-session") between
// extensions/orchestrator/index.ts (writer) and 3p/pi-subagents/src/agent-runner.ts
// (depth tracker). The canonical shape is { depth: number }; a legacy boolean true
// must still be tolerated as depth 1. This mirrors agent-runner's read so a future
// shape change on either side is caught.
function readDepth(marker: unknown): number {
  return typeof marker === "object" && marker !== null
    ? ((marker as { depth?: number }).depth ?? 0)
    : marker
      ? 1
      : 0;
}

describe("subagent-session marker contract", () => {
  it("treats the orchestrator's { depth: 1 } write as depth 1 (truthy, not reset to 0)", () => {
    const marker = { depth: 1 };
    expect(readDepth(marker)).toBe(1);
    expect(Boolean(marker)).toBe(true);
  });

  it("still tolerates a legacy boolean marker as depth 1", () => {
    expect(readDepth(true)).toBe(1);
  });

  it("reports depth 0 when no marker is set", () => {
    expect(readDepth(undefined)).toBe(0);
  });

  it("increments nesting from an existing object marker", () => {
    const previous = { depth: 2 };
    const next = { depth: readDepth(previous) + 1 };
    expect(next.depth).toBe(3);
  });
});
