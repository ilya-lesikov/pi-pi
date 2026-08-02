import { describe, it, expect, vi } from "vitest";
import {
  detectDuplicateExtensions,
  formatDuplicateFailure,
  checkDuplicateExtensions,
} from "./duplicate-extension-guard.js";

vi.mock("./log.js", () => ({
  getLogger: () => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const ROOT = "/opt/pi-pi";

function tool(name: string, path: string) {
  return { name, sourceInfo: { path } };
}

describe("detectDuplicateExtensions", () => {
  it("flags a pi-pi-owned tool name owned by an extension OUTSIDE pi-pi's tree", () => {
    // Use a non-vendored path to isolate the name-collision signal (a standalone
    // pi-lsp would ALSO trip the vendored-package-path signal).
    const tools = [
      tool("lsp", "/home/u/.pi/agent/extensions/some-other-lsp/index.js"),
    ];
    const findings = detectDuplicateExtensions(tools, [], ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0].signal).toBe("tool-name-collision");
    expect(findings[0].detail).toContain("lsp");
  });

  it("reports both signals when a standalone vendored extension also collides on a name", () => {
    const tools = [
      tool("lsp", "/home/u/.pi/agent/extensions/pi-lsp/index.js"),
    ];
    const findings = detectDuplicateExtensions(tools, [], ROOT);
    expect(findings.some((f) => f.signal === "tool-name-collision")).toBe(true);
    expect(findings.some((f) => f.signal === "vendored-package-path")).toBe(true);
  });

  it("does NOT flag pi-pi's OWN bundled copy (source under pi-pi root)", () => {
    const tools = [
      tool("lsp", "/opt/pi-pi/3p/pi-lsp/extensions/lsp/index.ts"),
      tool("Agent", "/opt/pi-pi/3p/pi-subagents/src/index.ts"),
      tool("vcc_recall", "/opt/pi-pi/3p/pi-vcc/index.ts"),
    ];
    expect(detectDuplicateExtensions(tools, [], ROOT)).toHaveLength(0);
  });

  it("flags a pi-pi-owned command name owned by an outside extension", () => {
    const commands = [
      { name: "task", sourceInfo: { path: "/usr/lib/node_modules/some-tasks/index.js" } },
    ];
    const findings = detectDuplicateExtensions([], commands, ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0].signal).toBe("command-name-collision");
    expect(findings[0].detail).toContain("task");
  });

  it("flags a vendored package id appearing in an outside extension path", () => {
    const tools = [
      // A tool with a NON-owned name but from a standalone pi-vcc install.
      tool("some_other_tool", "/home/u/.pi/agent/npm/node_modules/@monotykamary/pi-vcc/dist/index.js"),
    ];
    const findings = detectDuplicateExtensions(tools, [], ROOT);
    expect(findings.some((f) => f.signal === "vendored-package-path")).toBe(true);
    expect(findings.some((f) => f.detail.includes("pi-vcc"))).toBe(true);
  });

  it("does not false-positive on a substring package match", () => {
    const tools = [
      // "pi-tasks-helper" is NOT "pi-tasks" as a path segment.
      tool("unrelated", "/home/u/node_modules/pi-tasks-helper/index.js"),
    ];
    expect(detectDuplicateExtensions(tools, [], ROOT)).toHaveLength(0);
  });

  it("returns no findings for a clean install (only pi-pi's own tools)", () => {
    const tools = [
      tool("lsp", "/opt/pi-pi/3p/pi-lsp/extensions/lsp/index.ts"),
      tool("pp_phase_complete", "/opt/pi-pi/extensions/orchestrator/index.ts"),
      tool("exa_search", "/opt/pi-pi/extensions/orchestrator/exa.ts"),
    ];
    expect(detectDuplicateExtensions(tools, [], ROOT)).toHaveLength(0);
  });

  it("dedupes repeated findings for the same offender+signal", () => {
    const tools = [
      tool("ask_user", "/x/some-ask/index.js"),
      tool("ask_user", "/x/some-ask/index.js"),
    ];
    expect(detectDuplicateExtensions(tools, [], ROOT)).toHaveLength(1);
  });
});

describe("formatDuplicateFailure", () => {
  it("names the offender and the signal", () => {
    const msg = formatDuplicateFailure([
      { offender: "/x/pi-lsp/index.js", signal: "tool-name-collision", detail: 'tool "lsp"' },
    ]);
    expect(msg).toContain("refuses to operate");
    expect(msg).toContain("/x/pi-lsp/index.js");
    expect(msg).toContain('tool "lsp"');
  });
});

describe("checkDuplicateExtensions (gate)", () => {
  it("returns true and notifies when a duplicate is present", () => {
    const notify = vi.fn();
    const pi = {
      getAllTools: () => [tool("lsp", "/x/pi-lsp/index.js")],
      getCommands: () => [],
    };
    const gated = checkDuplicateExtensions(pi, { ui: { notify } }, ROOT);
    expect(gated).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("refuses to operate"), "error");
  });

  it("returns false for a clean install and does not notify", () => {
    const notify = vi.fn();
    const pi = {
      getAllTools: () => [tool("lsp", "/opt/pi-pi/3p/pi-lsp/extensions/lsp/index.ts")],
      getCommands: () => [],
    };
    const gated = checkDuplicateExtensions(pi, { ui: { notify } }, ROOT);
    expect(gated).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
