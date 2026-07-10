import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log.js", () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { registerStateFileTools } from "./pp-state-tools.js";

const tempDirs: string[] = [];

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-state-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
  renderShell?: string;
  renderCall?: (args: any, theme: any, context: any) => any;
  renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

const theme = { fg: (_c: string, t: string) => t } as any;

function setup() {
  const cwd = makeTempCwd();
  const taskDir = join(cwd, ".pp", "state", "brainstorm", "abc_brainstorm");
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  mkdirSync(join(taskDir, "plans"), { recursive: true });

  const tools = new Map<string, RegisteredTool>();
  const orchestrator: any = {
    cwd,
    active: { dir: taskDir },
    pi: { registerTool: (t: RegisteredTool) => tools.set(t.name, t) },
  };
  registerStateFileTools(orchestrator);
  return { cwd, taskDir, orchestrator, tools };
}

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text).join("\n");
}

const VALID_RESEARCH = [
  "## Affected Code",
  "- foo.ts:bar — does a thing",
  "## Architecture Context",
  "- how it connects",
  "## Constraints & Edge Cases",
  "- MUST: keep it working",
].join("\n");

describe("pp_write_state_file", () => {
  it("creates a valid RESEARCH.md and returns compact output (no diff)", async () => {
    const { taskDir, tools } = setup();
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "RESEARCH.md", content: VALID_RESEARCH });
    expect(res.isError).toBeFalsy();
    expect(res.details).toEqual({});
    expect(textOf(res)).toMatch(/^Created RESEARCH\.md \(\+\d+\/-\d+ lines\)$/);
    expect(textOf(res)).not.toContain("Affected Code");
    expect(readFileSync(join(taskDir, "RESEARCH.md"), "utf-8")).toBe(VALID_RESEARCH);
  });

  it("reports 'Updated' on overwrite", async () => {
    const { tools } = setup();
    await tools.get("pp_write_state_file")!.execute("1", { path: "RESEARCH.md", content: VALID_RESEARCH });
    const res = await tools.get("pp_write_state_file")!.execute("2", { path: "RESEARCH.md", content: VALID_RESEARCH + "\n- more" });
    expect(textOf(res)).toMatch(/^Updated RESEARCH\.md/);
  });

  it("rejects invalid RESEARCH.md structure without writing", async () => {
    const { taskDir, tools } = setup();
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "RESEARCH.md", content: "## Wrong Section\nx" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("RESEARCH.md structure is invalid");
    expect(() => readFileSync(join(taskDir, "RESEARCH.md"), "utf-8")).toThrow();
  });

  it("accepts an artifact starting with a top-level heading", async () => {
    const { tools } = setup();
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "artifacts/design.md", content: "# Design\n\nbody" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/artifacts\/design\.md/);
  });

  it("rejects a path escaping the task dir", async () => {
    const { tools } = setup();
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "../../../evil.md", content: "# x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/escapes the active task directory/);
  });

  it("rejects a non-.md file", async () => {
    const { tools } = setup();
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "notes.txt", content: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Only \.md/);
  });

  it("rejects managed review outputs and non-synthesized plans", async () => {
    const { tools } = setup();
    for (const p of [
      "code-reviews/1_gpt.md",
      "brainstorm-reviews/1_gemini.md",
      "plan-reviews/1_opus.md",
      "plans/1_gpt.md",
      "scratch.md",
      "artifacts/nested/deep.md",
    ]) {
      const res = await tools.get("pp_write_state_file")!.execute("1", { path: p, content: "# x" });
      expect(res.isError, `expected ${p} to be rejected`).toBe(true);
      expect(textOf(res)).toMatch(/Not an editable state file/);
    }
  });

  it("allows the synthesized plan", async () => {
    const { tools } = setup();
    const plan = [
      "# Plan",
      "## Scope",
      "Do the thing.",
      "## Checklist",
      "- [ ] item — Done when: it works",
    ].join("\n");
    const res = await tools.get("pp_write_state_file")!.execute("1", { path: "plans/123_synthesized.md", content: plan });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/plans\/123_synthesized\.md/);
  });
});

describe("pp_edit_state_file", () => {
  beforeEach(() => {});

  it("replaces a unique span and returns compact output", async () => {
    const { taskDir, tools } = setup();
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const res = await tools.get("pp_edit_state_file")!.execute("1", {
      path: "RESEARCH.md",
      oldText: "does a thing",
      newText: "does a different thing",
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^Updated RESEARCH\.md \(\+\d+\/-\d+ lines\)$/);
    expect(readFileSync(join(taskDir, "RESEARCH.md"), "utf-8")).toContain("does a different thing");
  });

  it("errors when oldText is not found", async () => {
    const { taskDir, tools } = setup();
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const res = await tools.get("pp_edit_state_file")!.execute("1", { path: "RESEARCH.md", oldText: "nope", newText: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/);
  });

  it("errors on ambiguous oldText unless replaceAll", async () => {
    const { taskDir, tools } = setup();
    // Use an artifact (an allowed, unstructured-body state file) with duplicate spans.
    writeFileSync(join(taskDir, "artifacts", "dup.md"), "# Dup\nx\nx\n", "utf-8");
    const ambiguous = await tools.get("pp_edit_state_file")!.execute("1", { path: "artifacts/dup.md", oldText: "x", newText: "y" });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toMatch(/matches 2 locations/);

    const all = await tools.get("pp_edit_state_file")!.execute("2", { path: "artifacts/dup.md", oldText: "x", newText: "y", replaceAll: true });
    expect(all.isError).toBeFalsy();
    expect(readFileSync(join(taskDir, "artifacts", "dup.md"), "utf-8")).toBe("# Dup\ny\ny\n");
  });

  it("errors when the file does not exist", async () => {
    const { tools } = setup();
    const res = await tools.get("pp_edit_state_file")!.execute("1", { path: "RESEARCH.md", oldText: "a", newText: "b" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not exist/);
  });

  it("rejects an edit that breaks structure without writing", async () => {
    const { taskDir, tools } = setup();
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const res = await tools.get("pp_edit_state_file")!.execute("1", {
      path: "RESEARCH.md",
      oldText: "## Affected Code",
      newText: "## Renamed Section",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("RESEARCH.md structure is invalid");
    expect(readFileSync(join(taskDir, "RESEARCH.md"), "utf-8")).toContain("## Affected Code");
  });
});

describe("state-file tool rendering (hidden on success, visible on failure/hang)", () => {
  for (const name of ["pp_write_state_file", "pp_edit_state_file"]) {
    it(`${name} owns its shell and renders nothing on the call`, () => {
      const { tools } = setup();
      const tool = tools.get(name)!;
      expect(tool.renderShell).toBe("self");
      const callComp = tool.renderCall!({}, theme, {});
      expect(callComp.render(80)).toEqual([]);
    });

    it(`${name} renders nothing on a successful result`, () => {
      const { tools } = setup();
      const tool = tools.get(name)!;
      const comp = tool.renderResult!({ content: [{ type: "text", text: "Created X" }] }, { isPartial: false }, theme, { isError: false });
      expect(comp.render(80)).toEqual([]);
    });

    it(`${name} renders a visible line while partial (hang)`, () => {
      const { tools } = setup();
      const tool = tools.get(name)!;
      const comp = tool.renderResult!({ content: [] }, { isPartial: true }, theme, { isError: false });
      expect(comp.render(80).length).toBe(1);
    });

    it(`${name} renders a visible line on error`, () => {
      const { tools } = setup();
      const tool = tools.get(name)!;
      const comp = tool.renderResult!({ content: [{ type: "text", text: "boom" }], isError: true }, { isPartial: false }, theme, { isError: true });
      const rows = comp.render(80);
      expect(rows.length).toBe(1);
      expect(rows[0]).toContain("boom");
    });
  }
});
