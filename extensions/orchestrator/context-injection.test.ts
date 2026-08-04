import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectContextFiles, renderContextInjection, normalizeForHash, summarizeContextInjectionSize, MAX_CONTEXT_FILE_BYTES, CONTEXT_INJECTION_WARN_BYTES, type ContextInjectionToggles, type CollectedContextFile } from "./context-injection.js";

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

describe("summarizeContextInjectionSize", () => {
  const mk = (path: string, bytes: number): CollectedContextFile => ({
    scope: "project", type: "agents", path, content: "a".repeat(bytes), truncated: false,
  });

  it("does not warn below the threshold", () => {
    const r = summarizeContextInjectionSize([mk("/p/AGENTS.md", 1000)]);
    expect(r.warning).toBeUndefined();
    expect(r.totalBytes).toBe(1000);
  });

  it("warns above the threshold and names the files, without dropping any", () => {
    const files = [mk("/p/AGENTS.md", CONTEXT_INJECTION_WARN_BYTES), mk("/g/CLAUDE.md", 2048)];
    const r = summarizeContextInjectionSize(files);
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain("/p/AGENTS.md");
    expect(r.warning).toContain("/g/CLAUDE.md");
    expect(r.totalBytes).toBe(CONTEXT_INJECTION_WARN_BYTES + 2048);
    // Warn-only: the caller still injects every file (the function returns no
    // filtered list; it only reports).
  });

  it("measures UTF-8 bytes, not string length", () => {
    // '\u00e9' is 2 UTF-8 bytes; 1 char.
    const f: CollectedContextFile = { scope: "project", type: "agents", path: "/p", content: "\u00e9", truncated: false };
    expect(summarizeContextInjectionSize([f]).totalBytes).toBe(2);
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
