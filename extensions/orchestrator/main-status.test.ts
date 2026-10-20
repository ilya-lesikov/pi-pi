import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { MainStatusTracker } from "./main-status.js";
import { createCustomFooter, setFooterContext, setFooterOrchestrator, setFooterStatus, setFooterTracker } from "./custom-footer.js";

function tracked(hooks = { holdingWorkers: () => 0, activeWaits: () => 0 }) {
  let now = 1_000_000;
  const tracker = new MainStatusTracker(hooks, () => now);
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  tracker.register({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
  const fire = (event: string, payload: any = {}) => handlers.get(event)?.(payload, { model: { id: "claude-opus-4-5" } });
  return { tracker, fire, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("MainStatusTracker", () => {
  it("follows a run: waiting for the model, thinking, writing, a tool, then idle", () => {
    const { tracker, fire, advance } = tracked();
    expect(tracker.current()).toMatchObject({ text: "Idle", level: "idle" });
    fire("agent_start");
    expect(tracker.current()).toMatchObject({ text: "Waiting for claude-opus-4-5", level: "normal" });
    fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
    expect(tracker.current().text).toBe("Thinking");
    fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
    expect(tracker.current().text).toBe("Writing the answer");
    fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npx vitest run\n  extensions" } });
    expect(tracker.current().text).toBe("Running bash: npx vitest run extensions");
    fire("tool_execution_end", { toolCallId: "1", toolName: "bash" });
    expect(tracker.current().text).toBe("Waiting for claude-opus-4-5");
    advance(120_000);
    fire("agent_settled");
    advance(120_000);
    expect(tracker.current()).toMatchObject({ text: "Idle • done 2m ago", level: "idle" });
  });

  it("says when it waits on the user, on workers, or for a model that has gone quiet", () => {
    let holding = 0;
    let waits = 0;
    const { tracker, fire, advance } = tracked({ holdingWorkers: () => holding, activeWaits: () => waits });
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "a", toolName: "ask_user" });
    expect(tracker.current()).toMatchObject({ text: "Waiting for your answer", level: "attention" });
    fire("tool_execution_end", { toolCallId: "a", toolName: "ask_user" });
    fire("tool_execution_start", { toolCallId: "w", toolName: "agent_wait" });
    waits = 2;
    expect(tracker.current().text).toBe("Waiting on 2 workers");
    fire("tool_execution_end", { toolCallId: "w", toolName: "agent_wait" });
    holding = 1;
    expect(tracker.current().text).toBe("Waiting for 1 worker to report");
    holding = 0;
    advance(121_000);
    expect(tracker.current()).toMatchObject({ text: "No response for 2m1s", level: "alarm", suffix: "esc to interrupt" });
  });

  it("shows pi-pi's own pauses and compaction", () => {
    const { tracker, fire } = tracked();
    fire("agent_start");
    tracker.pause("Rate-limited • waiting until 14:05");
    expect(tracker.current()).toMatchObject({ text: "Rate-limited • waiting until 14:05", level: "attention" });
    fire("session_before_compact");
    expect(tracker.current().text).toBe("Compacting context");
  });
});

describe("footer status line", () => {
  const theme = { fg: (_color: string, text: string) => text } as any;
  function render(width: number, statuses = new Map<string, string>(), cwd = "/home/u/git/github.com/acme/pi-pi") {
    setFooterTracker(undefined as any);
    setFooterOrchestrator(undefined as any);
    setFooterContext({ cwd, model: { id: "m1", provider: "test" }, sessionManager: { getSessionName: () => undefined, getEntries: () => [] }, getContextUsage: () => undefined } as any);
    const footer = createCustomFooter({ requestRender: vi.fn() } as any, theme, { getExtensionStatuses: () => statuses } as any, () => "main");
    try {
      return footer.render(width);
    } finally {
      footer.dispose?.();
    }
  }

  it("puts what the agent does on the left and the directory on the right, shortening the directory first", () => {
    const { tracker, fire } = tracked();
    setFooterStatus(tracker);
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npx vitest run extensions/orchestrator" } });
    const wide = render(140)[0]!;
    expect(wide).toMatch(/^⠋ Running bash: npx vitest run extensions\/orchestrator • 0s +\/home\/u\/git\/github\.com\/acme\/pi-pi \(main\)$/);
    expect(wide).toHaveLength(140);
    expect(render(100)[0]).toMatch(/ \/home\/…\/acme\/pi-pi \(main\)$/);
    expect(render(70)[0]).toMatch(/• 0s +pi-pi \(main\)$/);
    const narrow = render(40)[0]!;
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
    expect(narrow).toContain("• 0s");
  });

  it("shows other extensions' statuses on a third line, leaving out pi-pi's own", () => {
    const { tracker } = tracked();
    setFooterStatus(tracker);
    expect(render(120)).toHaveLength(2);
    const lines = render(120, new Map([["workers", "2 workers"], ["git", "git-auto ✓ synced"], ["docker", " docker:  2 up "]]));
    expect(lines[2]).toBe("git-auto ✓ synced • docker: 2 up");
  });
});
