/**
 * blocked-call-rendering.test.ts — LOCAL PATCH (pi-pi) guard.
 *
 * A call the host rejects before the tool runs (pi-pi blocks an Agent spawn
 * whose subagent_type is not registered) returns the reason as text with an
 * empty `details` object. That object is truthy, so the result renderer used to
 * fall through to its last branch and report "Aborted (max turns exceeded)" —
 * a turn limit that was never set, with the actual reason nowhere on screen.
 */
import { describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

const theme = { fg: (_color: string, s: string) => s, bold: (s: string) => s } as any;

const render = (result: any) =>
  agentTool().renderResult(result, { expanded: false, isPartial: false }, theme).text as string;

describe("Agent result rendering", () => {
  it("shows the rejection reason instead of a turn limit that was never reached", () => {
    const reason = "subagent_type must be one of: explore, librarian, task";
    const text = render({ content: [{ type: "text", text: reason }], details: {} });

    expect(text).toContain(reason);
    expect(text).not.toContain("max turns");
  });

  it("still reports a real turn-limit abort as one", () => {
    const text = render({
      content: [{ type: "text", text: "" }],
      details: { status: "aborted", toolUses: 3, turnCount: 30, maxTurns: 30, durationMs: 1000 },
    });

    expect(text).toContain("Aborted (max turns exceeded)");
  });

  it("does not blame the turn limit for an abort that had none", () => {
    const text = render({
      content: [{ type: "text", text: "" }],
      details: { status: "aborted", toolUses: 3, turnCount: 4, durationMs: 1000 },
    });

    expect(text).toContain("Aborted");
    expect(text).not.toContain("max turns");
  });

  it("still renders the spinner for a streaming run, whose details do carry a status", () => {
    const streaming = agentTool().renderResult(
      {
        content: [{ type: "text", text: "3 tool uses..." }],
        details: { status: "running", toolUses: 3, durationMs: 10, activity: "thinking…", spinnerFrame: 0 },
      },
      { expanded: false, isPartial: true },
      theme,
    );

    expect((streaming as { text?: string }).text).toBeUndefined();
  });
});
