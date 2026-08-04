import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectContextFiles, renderContextInjection, normalizeForHash, MAX_CONTEXT_FILE_BYTES, type ContextInjectionToggles } from "./context-injection.js";

const ALL_OFF: ContextInjectionToggles = {
  globalAgents: false, globalClaude: false,
  ancestorAgents: false, ancestorClaude: false,
  projectAgents: false, projectClaude: false,
};

describe("collectContextFiles", () => {
  let root: string;
  let cwd: string;
  const prevEnv = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ctx-inj-"));
    // Layout: <root>/agentdir (global), <root>/parent (ancestor), <root>/parent/proj (cwd)
    mkdirSync(join(root, "agentdir"), { recursive: true });
    mkdirSync(join(root, "parent", "proj"), { recursive: true });
    cwd = join(root, "parent", "proj");
    process.env.PI_CODING_AGENT_DIR = join(root, "agentdir");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it("reads BOTH AGENTS.md and CLAUDE.md from the project scope independently", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "project agents");
    writeFileSync(join(cwd, "CLAUDE.md"), "project claude");
    const files = collectContextFiles(cwd, { ...ALL_OFF, projectAgents: true, projectClaude: true });
    expect(files.map((f) => f.type).sort()).toEqual(["agents", "claude"]);
    expect(files.find((f) => f.type === "agents")!.content).toBe("project agents");
    expect(files.find((f) => f.type === "claude")!.content).toBe("project claude");
  });

  it("respects each toggle independently (only enabled scope/type is read)", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "project agents");
    writeFileSync(join(cwd, "CLAUDE.md"), "project claude");
    const onlyAgents = collectContextFiles(cwd, { ...ALL_OFF, projectAgents: true });
    expect(onlyAgents).toHaveLength(1);
    expect(onlyAgents[0].type).toBe("agents");
  });

  it("reads the global scope from PI_CODING_AGENT_DIR", () => {
    writeFileSync(join(root, "agentdir", "AGENTS.md"), "global agents");
    const files = collectContextFiles(cwd, { ...ALL_OFF, globalAgents: true });
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("global");
    expect(files[0].content).toBe("global agents");
  });

  it("reads ancestor directories above the project (not the project itself)", () => {
    writeFileSync(join(root, "parent", "AGENTS.md"), "ancestor agents");
    const files = collectContextFiles(cwd, { ...ALL_OFF, ancestorAgents: true });
    expect(files.some((f) => f.scope === "ancestor" && f.content === "ancestor agents")).toBe(true);
  });

  it("returns nothing when all toggles are off", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "x");
    expect(collectContextFiles(cwd, ALL_OFF)).toHaveLength(0);
  });

  it("does not crash on absent files", () => {
    expect(collectContextFiles(cwd, { ...ALL_OFF, projectAgents: true, globalClaude: true })).toHaveLength(0);
  });

  it("dedupes a path shared between scopes (global dir also an ancestor)", () => {
    // Point global at the ancestor dir; enabling both must not double-read.
    process.env.PI_CODING_AGENT_DIR = join(root, "parent");
    writeFileSync(join(root, "parent", "AGENTS.md"), "shared");
    const files = collectContextFiles(cwd, { ...ALL_OFF, globalAgents: true, ancestorAgents: true });
    expect(files).toHaveLength(1);
  });

  it("caps oversize files and marks them truncated", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "a".repeat(MAX_CONTEXT_FILE_BYTES + 5000));
    const files = collectContextFiles(cwd, { ...ALL_OFF, projectAgents: true });
    expect(files[0].truncated).toBe(true);
    expect(files[0].content.length).toBe(MAX_CONTEXT_FILE_BYTES);
  });

  it("injects byte-identical AGENTS.md and CLAUDE.md in one dir only once", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "same body\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "same body\n");
    const files = collectContextFiles(cwd, { ...ALL_OFF, projectAgents: true, projectClaude: true });
    expect(files).toHaveLength(1);
  });

  it("keeps the most-specific scope when the same content appears globally and in the project", () => {
    writeFileSync(join(root, "agentdir", "AGENTS.md"), "shared guidance\n");
    writeFileSync(join(cwd, "AGENTS.md"), "shared guidance\n");
    const files = collectContextFiles(cwd, { ...ALL_OFF, globalAgents: true, projectAgents: true });
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("project");
  });

  it("dedups CRLF vs LF copies (newline-only normalization)", () => {
    writeFileSync(join(root, "agentdir", "AGENTS.md"), "line one\r\nline two\r\n");
    writeFileSync(join(cwd, "AGENTS.md"), "line one\nline two\n");
    const files = collectContextFiles(cwd, { ...ALL_OFF, globalAgents: true, projectAgents: true });
    expect(files).toHaveLength(1);
    expect(files[0].scope).toBe("project");
  });

  it("does NOT dedup two files that share the first 64 KiB but differ after", () => {
    const prefix = "x".repeat(MAX_CONTEXT_FILE_BYTES);
    writeFileSync(join(root, "agentdir", "AGENTS.md"), prefix + "GLOBAL-TAIL");
    writeFileSync(join(cwd, "AGENTS.md"), prefix + "PROJECT-TAIL");
    const files = collectContextFiles(cwd, { ...ALL_OFF, globalAgents: true, projectAgents: true });
    expect(files).toHaveLength(2);
  });
});

describe("normalizeForHash", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeForHash("a\r\nb\rc")).toBe("a\nb\nc");
  });
  it("strips exactly one trailing LF but keeps additional trailing blanks", () => {
    expect(normalizeForHash("body\n")).toBe("body");
    expect(normalizeForHash("body\n\n")).toBe("body\n");
  });
  it("leaves interior whitespace untouched", () => {
    expect(normalizeForHash("a  b\tc")).toBe("a  b\tc");
  });
});

describe("renderContextInjection", () => {
  it("returns empty string for no files", () => {
    expect(renderContextInjection([])).toBe("");
  });
  it("wraps each file with scope/type/source provenance", () => {
    const out = renderContextInjection([
      { scope: "project", type: "agents", path: "/p/AGENTS.md", content: "hi", truncated: false },
    ]);
    expect(out).toContain('scope="project"');
    expect(out).toContain('type="agents"');
    expect(out).toContain('source="/p/AGENTS.md"');
    expect(out).toContain("hi");
  });
});
