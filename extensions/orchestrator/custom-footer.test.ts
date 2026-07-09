import { describe, expect, it, beforeEach } from "vitest";
import { createCustomFooter, setFooterContext, setFooterTracker, setFooterOrchestrator } from "./custom-footer.js";

const theme = { fg: (_color: string, text: string) => text } as any;
const footerData = { getGitBranch: () => "main" } as any;

function render(width = 200): string[] {
  const footer = createCustomFooter({} as any, theme, footerData);
  return footer.render(width);
}

function makeCtx(usage?: { tokens: number | null; contextWindow: number; percent: number | null }): any {
  return {
    cwd: "/tmp/project",
    model: { id: "test-model", provider: "test" },
    sessionManager: { getSessionName: () => undefined, getEntries: () => [] },
    getContextUsage: () => usage,
  };
}

describe("createCustomFooter", () => {
  beforeEach(() => {
    setFooterTracker(undefined as any);
    setFooterOrchestrator(undefined as any);
  });

  it("renders exactly two lines (no status/LSP line)", () => {
    setFooterContext(makeCtx());
    const lines = render();
    expect(lines).toHaveLength(2);
  });

  it("line 1 shows task/phase/mode when a task is active", () => {
    setFooterContext(makeCtx());
    setFooterOrchestrator({
      active: { type: "implement", dir: "/tmp/task", state: { phase: "plan", mode: "autonomous", description: "build the widget" } },
    } as any);
    const [line1] = render();
    expect(line1).toContain("task: implement");
    expect(line1).toContain("phase: plan");
    expect(line1).toContain("mode: autonomous");
  });

  it("renders a dedicated task-name line as line 2 when a task is active", () => {
    setFooterContext(makeCtx());
    setFooterOrchestrator({
      active: { type: "implement", dir: "/tmp/task", state: { phase: "plan", mode: "autonomous", description: "build the widget" } },
    } as any);
    const lines = render();
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("build the widget");
  });

  it("line 1 shows autonomous mode in a read-only phase for an autonomous task", () => {
    setFooterContext(makeCtx());
    setFooterOrchestrator({
      active: { type: "implement", dir: "/tmp/task", state: { phase: "brainstorm", mode: "autonomous", description: "build the widget" } },
    } as any);
    const [line1] = render();
    expect(line1).toContain("phase: brainstorm");
    expect(line1).toContain("mode: autonomous");
  });

  it("line 1 shows guided mode for a guided task", () => {
    setFooterContext(makeCtx());
    setFooterOrchestrator({
      active: { type: "implement", dir: "/tmp/task", state: { phase: "implement", mode: "guided", description: "build the widget" } },
    } as any);
    const [line1] = render();
    expect(line1).toContain("mode: guided");
  });

  it("line 1 omits the mode segment for a quick task", () => {
    setFooterContext(makeCtx());
    setFooterOrchestrator({
      active: { type: "quick", dir: "/tmp/task", state: { phase: "quick", mode: "autonomous", description: "build the widget" } },
    } as any);
    const [line1] = render();
    expect(line1).toContain("task: quick");
    expect(line1).not.toContain("mode:");
  });

  it("line 1 omits task metadata when no task is active", () => {
    setFooterContext(makeCtx());
    const [line1] = render();
    expect(line1).not.toContain("task:");
    expect(line1).toContain("main");
  });

  it("context indicator shows percent/used/max", () => {
    setFooterContext(makeCtx({ tokens: 38000, contextWindow: 1000000, percent: 3.8 }));
    const [, line2] = render();
    expect(line2).toContain("3.8%/38k/1.0M (auto)");
  });

  it("context indicator degrades gracefully when tokens are null", () => {
    setFooterContext(makeCtx({ tokens: null, contextWindow: 1000000, percent: null }));
    const [, line2] = render();
    expect(line2).toContain("?%/?/1.0M (auto)");
  });
});
