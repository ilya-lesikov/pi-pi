/**
 * notification-error-rendering.test.ts — LOCAL PATCH (pi-pi) guard.
 *
 * A failed agent produces no result, so the notification body fell back to
 * "No output." and the actual reason (an auth failure, a provider 401, a
 * crashed tool) existed only inside get_subagent_result. The completion
 * notification is what the user and the parent model actually read, so the
 * error has to be rendered there.
 */
import { describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";

function renderer() {
  const renderers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn((type: string, fn: any) => renderers.set(type, fn)),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return renderers.get("subagent-notification");
}

const theme = { fg: (color: string, s: string) => `<${color}>${s}</${color}>`, bold: (s: string) => s } as any;

const details = (over: Record<string, unknown>) => ({
  id: "a1",
  description: "Probe delegation availability",
  status: "error",
  toolUses: 0,
  turnCount: 0,
  totalTokens: 0,
  durationMs: 1000,
  resultPreview: "No output.",
  ...over,
});

describe("subagent notification rendering", () => {
  it("shows the failure reason instead of an empty-result placeholder", () => {
    const render = renderer();
    const error = '401 {"type":"authentication_error","message":"OAuth access token has been revoked."}';
    const collapsed = render({ details: details({ error }) }, { expanded: false }, theme).text;
    expect(collapsed).toContain("authentication_error");
    expect(collapsed).not.toContain("No output.");
    expect(collapsed).toContain("<error>");

    const expanded = render({ details: details({ error }) }, { expanded: true }, theme).text;
    expect(expanded).toContain("OAuth access token has been revoked");
  });

  it("renders the full error when expanded and keeps results untouched on success", () => {
    const render = renderer();
    const error = "line one\nline two";
    const expanded = render({ details: details({ error }) }, { expanded: true }, theme).text;
    expect(expanded).toContain("line one");
    expect(expanded).toContain("line two");

    const ok = render(
      { details: details({ status: "completed", error: undefined, resultPreview: "all good" }) },
      { expanded: false },
      theme,
    ).text;
    expect(ok).toContain("all good");
    expect(ok).not.toContain("<error>");
  });
});
