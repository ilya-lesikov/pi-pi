import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomFooter, resolveGitBranchSync, setFooterContext, setFooterTracker } from "./custom-footer.js";
import { LLM_API_PROVIDER } from "./routing.js";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => cb(null, "", "")),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

// Marks colored spans so tests can see which severity a segment got.
const theme = { fg: (color: string, text: string) => (color === "dim" ? text : `<${color}>${text}</${color}>`) } as any;

function ctx(overrides: Record<string, any> = {}): any {
  return {
    cwd: "/tmp/project",
    model: { id: "m1", provider: "test" },
    sessionManager: { getSessionName: () => "my session", getEntries: () => [] },
    getContextUsage: () => ({ tokens: 1_500, contextWindow: 200_000, percent: 10 }),
    ...overrides,
  };
}

function tracker(values: Partial<Record<string, number | boolean>> = {}): any {
  return {
    getTotalProcessedInputTokens: () => values.input ?? 0,
    getTotalOutputTokens: () => values.output ?? 0,
    getCacheHitRate: () => values.cache ?? 0,
    getTotalCost: () => values.cost ?? 0,
    isCacheSupported: () => values.cacheSupported ?? false,
  };
}

function render(width = 200, branch: string | null = "main"): string[] {
  const footer = createCustomFooter({ requestRender: () => {} } as any, theme, {} as any, () => branch);
  try {
    return footer.render(width);
  } finally {
    footer.dispose?.();
  }
}

beforeEach(() => {
  setFooterTracker(undefined as any);
  setFooterContext(ctx());
});

describe("stats line", () => {
  it("formats token counts at every magnitude", () => {
    setFooterTracker(tracker({ input: 1_234_567, output: 45_678 }));
    setFooterContext(ctx({ getContextUsage: () => ({ tokens: 9_999, contextWindow: 12_000_000, percent: 5 }) }));
    const [, stats] = render();
    expect(stats).toContain("↑1.2M ↓46k");
    expect(stats).toContain("5.0%/10.0k/12M (auto)");
  });

  it("shows the cache hit rate only where caching is supported, and always the cost", () => {
    setFooterTracker(tracker({ cache: 0.426, cost: 1.5, cacheSupported: true }));
    expect(render()[1]).toContain("⚡43% $1.50");
    setFooterTracker(tracker({ cache: 0.426 }));
    expect(render()[1]).not.toContain("⚡");
    expect(render()[1]).toContain("$0.00");
  });

  it("colors context usage by how close it is to the window", () => {
    setFooterContext(ctx({ getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }) }));
    expect(render()[1]).toContain("<warning>75.0%/150k/200k (auto)</warning>");
    setFooterContext(ctx({ getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 }) }));
    expect(render()[1]).toContain("<error>95.0%");
  });

  it("flags per-token billing and shows the latest thinking level", () => {
    setFooterContext(ctx({
      model: { id: "claude-x", provider: LLM_API_PROVIDER },
      sessionManager: {
        getSessionName: () => undefined,
        getEntries: () => [
          { type: "thinking_level_change", thinkingLevel: "low" },
          { type: "thinking_level_change", thinkingLevel: "high" },
          { type: "message" },
        ],
      },
    }));
    expect(render()[1]).toMatch(/claude-x \[paid\] • high • pp v\S+$/);
  });

  it("degrades without a session context", () => {
    setFooterContext(undefined as any);
    const [, stats] = render();
    expect(stats).toContain("?%/?/0 (auto)");
    expect(stats).toMatch(/no-model • off • pp v\S+$/);
  });

  it("truncates the model side first, then drops it, as width shrinks", () => {
    const wide = render(200)[1];
    expect(wide).toMatch(/\(auto\) +\(test\) m1 • off • pp v\S+$/);
    const narrow = render(44)[1];
    expect(visibleWidth(narrow)).toBe(44);
    expect(narrow).toContain("(auto)  (test) m");
    expect(narrow).not.toContain("• off");
    const tiny = render(10)[1];
    expect(tiny).toContain("...");
    expect(tiny).not.toContain("m1");
  });

  it("drops the model side when there is no room for it beyond the padding", () => {
    const leftOnly = render(200)[1].split("  ")[0].length;
    expect(render(leftOnly + 1)[1]).toBe(render(200)[1].slice(0, leftOnly));
  });
});

describe("path line", () => {
  it("abbreviates the home directory and appends the session name", () => {
    setFooterContext(ctx({ cwd: join(homedir(), "src", "app") }));
    expect(render()[0]).toMatch(/ ~\/src\/app \(main\) • my session$/);
  });
});

describe("resolveGitBranchSync edge cases", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a .git file that is not a gitdir pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-footer-more-"));
    dirs.push(root);
    writeFileSync(join(root, ".git"), "garbage\n");
    expect(resolveGitBranchSync(root)).toBeNull();
  });

  it("resolves a relative gitdir pointer against the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-footer-more-"));
    dirs.push(root);
    mkdirSync(join(root, "store"));
    writeFileSync(join(root, "store", "HEAD"), "ref: refs/heads/feature/x\n");
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: ../store\n");
    expect(resolveGitBranchSync(join(root, "wt"))).toBe("feature/x");
  });

  it("defaults to the footer context's cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-footer-more-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/ctx-branch\n");
    setFooterContext(ctx({ cwd: root }));
    expect(resolveGitBranchSync()).toBe("ctx-branch");
  });
});

describe("detached HEAD confirmation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
  });

  it("asks git once per entry into the detached state, and again after leaving it", () => {
    let callback: ((e: Error | null, out: string) => void) | undefined;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => { callback = cb; });
    let branch = "detached";
    const requestRender = vi.fn();
    const footer = createCustomFooter({ requestRender } as any, theme, {} as any, () => branch);
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    callback!(new Error("not a symbolic ref"), "");
    vi.advanceTimersByTime(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(requestRender).not.toHaveBeenCalled();

    branch = "main";
    vi.advanceTimersByTime(5_000);
    expect(footer.render(200)[0]).toContain("(main)");
    branch = "detached";
    vi.advanceTimersByTime(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    callback!(null, "\n");
    expect(footer.render(200)[0]).toContain("(detached)");
    footer.dispose?.();
  });

  it("ignores a git answer that arrives after dispose", () => {
    let callback: ((e: Error | null, out: string) => void) | undefined;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => { callback = cb; });
    const requestRender = vi.fn();
    const footer = createCustomFooter({ requestRender } as any, theme, {} as any, () => "detached");
    vi.advanceTimersByTime(5_000);
    footer.dispose?.();
    callback!(null, "late-branch\n");
    expect(requestRender).not.toHaveBeenCalled();
  });
});
