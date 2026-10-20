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
    expect(tracker.current()).toMatchObject({ text: "No response", level: "alarm", suffix: "esc to interrupt" });
  });

  it("goes red when a model stream stops mid-answer, not only before the first token", () => {
    const { tracker, fire, advance } = tracked();
    fire("agent_start");
    fire("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
    advance(121_000);
    expect(tracker.current()).toMatchObject({ text: "No response", level: "alarm" });
  });

  it("goes back to the tool still running beside an answered question, and keeps the question's clock", () => {
    const { tracker, fire, advance } = tracked();
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "make" } });
    fire("tool_execution_start", { toolCallId: "a", toolName: "ask_user" });
    advance(5_000);
    fire("ui_prompt_start", {});
    expect(tracker.current().since).toBe(tracker.clock() - 5_000);
    fire("tool_execution_end", { toolCallId: "a", toolName: "ask_user" });
    expect(tracker.current().text).toBe("Running bash");
  });

  it("keeps waiting on the user while a question is open, whatever starts beside it", () => {
    const { tracker, fire } = tracked();
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "a", toolName: "ask_user" });
    fire("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "make" } });
    expect(tracker.current()).toMatchObject({ text: "Waiting for your answer", level: "attention" });
  });

  it("keeps waiting on the user while a question is open, whatever finishes beside it", () => {
    const { tracker, fire } = tracked();
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "make" } });
    fire("tool_execution_start", { toolCallId: "a", toolName: "ask_user" });
    fire("tool_execution_end", { toolCallId: "b", toolName: "bash" });
    expect(tracker.current()).toMatchObject({ text: "Waiting for your answer", level: "attention" });
  });

  it("returns to what it was doing when a dialog closes, idle included", () => {
    const { tracker, fire } = tracked();
    fire("ui_prompt_start", { kind: "select" });
    expect(tracker.current().text).toBe("Waiting for your answer");
    fire("ui_prompt_end", { kind: "select" });
    expect(tracker.current()).toMatchObject({ level: "idle" });
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "make" } });
    fire("ui_prompt_start", { kind: "confirm" });
    fire("ui_prompt_end", { kind: "confirm" });
    expect(tracker.current().text).toBe("Running bash: make");
  });

  it("stays on the user while a dialog outlives the tool that opened it", () => {
    const { tracker, fire } = tracked();
    fire("agent_start");
    fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "make" } });
    fire("ui_prompt_start", { kind: "confirm" });
    fire("tool_execution_end", { toolCallId: "1", toolName: "bash" });
    expect(tracker.current().text).toBe("Waiting for your answer");
    fire("ui_prompt_end", { kind: "confirm" });
    expect(tracker.current().text).toBe("Waiting for claude-opus-4-5");
  });

  it("keeps waiting while a second dialog is open after the first one's end arrives late", () => {
    const { tracker, fire } = tracked();
    fire("ui_prompt_start", { kind: "custom" });
    fire("ui_prompt_start", { kind: "select" });
    fire("ui_prompt_end", { kind: "custom" });
    expect(tracker.current().text).toBe("Waiting for your answer");
    fire("ui_prompt_end", { kind: "select" });
    expect(tracker.current()).toMatchObject({ level: "idle" });
  });

  it("ends a /compact typed while idle as idle, and one that failed too", () => {
    const { tracker, fire } = tracked();
    fire("session_before_compact", { reason: "manual" });
    expect(tracker.current().text).toBe("Compacting context");
    fire("session_compact", { reason: "manual" });
    expect(tracker.current()).toMatchObject({ level: "idle" });
    fire("agent_start");
    fire("session_before_compact", { reason: "overflow" });
    fire("session_compact_failed", { reason: "overflow" });
    expect(tracker.current().text).toBe("Waiting for claude-opus-4-5");
  });

  it("shows pi-pi's own pauses until they run out, and compaction", () => {
    const { tracker, fire, advance, at } = tracked();
    tracker.pause("Rate-limited • waiting until 14:05", at() + 60_000);
    expect(tracker.current()).toMatchObject({ text: "Rate-limited • waiting until 14:05", level: "attention" });
    advance(61_000);
    expect(tracker.current()).toMatchObject({ text: "Idle", level: "idle" });
    fire("agent_start");
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

  it("says how long the model has been silent once, then how to stop it", () => {
    const { tracker, fire, advance } = tracked();
    setFooterStatus(tracker);
    fire("agent_start");
    advance(10_000);
    fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
    advance(125_000);
    expect(render(140)[0]).toMatch(/^! No response • 2m5s • esc to interrupt +\//);
  });

  it("shows other extensions' statuses on a third line, leaving out pi-pi's own", () => {
    const { tracker } = tracked();
    setFooterStatus(tracker);
    expect(render(120)).toHaveLength(2);
    const lines = render(120, new Map([["workers", "2 workers"], ["git", "git-auto ✓ synced"], ["docker", " docker:  2 up "]]));
    expect(lines[2]).toBe("git-auto ✓ synced • docker: 2 up");
  });
});
