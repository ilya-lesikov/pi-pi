import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkDuplicateExtensions, detectDuplicateExtensions } from "./duplicate-extension-guard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("duplicate detection against the real install root", () => {
  it("accepts pi-pi's own tools where this checkout actually lives", () => {
    const tools = [{ name: "lsp", sourceInfo: { path: join(ROOT, "extensions", "orchestrator", "index.ts") } }];
    expect(detectDuplicateExtensions(tools, [])).toEqual([]);
  });

  it("flags an owned tool with no source path, naming its source instead", () => {
    expect(detectDuplicateExtensions([{ name: "ask_user", sourceInfo: { source: "npm:pi-ask-user" } }], [])).toEqual([
      { offender: "npm:pi-ask-user", signal: "tool-name-collision", detail: "tool \"ask_user\"" },
    ]);
    expect(detectDuplicateExtensions([{ name: "Agent" }], [])[0]!.offender).toBe("unknown");
  });

  it("treats another extension's todo tool as a clash only under Paseo, where pi-pi registers one", () => {
    const todo = [{ name: "todo", sourceInfo: { path: "/home/u/node_modules/rpiv-todo/index.ts" } }];
    expect(detectDuplicateExtensions(todo, [])).toEqual([]);
    process.env.PASEO_AGENT_ID = "a";
    try {
      expect(detectDuplicateExtensions(todo, [])[0]).toMatchObject({ signal: "tool-name-collision", detail: "tool \"todo\"" });
    } finally {
      delete process.env.PASEO_AGENT_ID;
    }
  });

  it("flags a command shipped from a vendored package outside pi-pi", () => {
    const findings = detectDuplicateExtensions([], [{ name: "tasks", sourceInfo: { path: "/home/u/node_modules/pi-tasks/index.ts" } }]);
    expect(findings).toEqual([{ offender: "/home/u/node_modules/pi-tasks/index.ts", signal: "vendored-package-path", detail: "vendored package \"pi-tasks\"" }]);
  });
});

describe("checkDuplicateExtensions resilience", () => {
  it("does not gate the session when the inventory cannot be read", () => {
    const notify = vi.fn();
    const pi = { getAllTools: () => { throw new Error("not bound yet"); } };
    expect(checkDuplicateExtensions(pi, { ui: { notify } })).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats a host without inventory APIs as clean", () => {
    expect(checkDuplicateExtensions({}, {})).toBe(false);
  });

  it("still gates when notifying the user throws", () => {
    const pi = { getAllTools: () => [{ name: "lsp", sourceInfo: { path: "/elsewhere/pi-lsp/index.ts" } }], getCommands: () => [] };
    const ctx = { ui: { notify: () => { throw new Error("ui gone"); } } };
    expect(checkDuplicateExtensions(pi, ctx)).toBe(true);
  });
});
