import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomFooter,
  setFooterContext,
  setFooterTracker,
  setFooterOrchestrator,
  resolvePackageVersion,
  resolveGitBranchSync,
} from "./custom-footer.js";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    cb(null, "", "");
  }),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const theme = { fg: (_color: string, text: string) => text } as any;
const footerData = { getGitBranch: () => "main" } as any;

function render(width = 200, branch: string | null = "main"): string[] {
  const footer = createCustomFooter({ requestRender: () => {} } as any, theme, footerData, () => branch);
  try {
    return footer.render(width);
  } finally {
    footer.dispose?.();
  }
}

function makeRepo(head: string, asWorktreeFile = false): string {
  const root = mkdtempSync(join(tmpdir(), "pp-footer-"));
  const gitDir = asWorktreeFile ? join(root, "realgit") : join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `${head}\n`);
  if (asWorktreeFile) {
    mkdirSync(join(root, "wt"), { recursive: true });
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${gitDir}\n`);
    return join(root, "wt");
  }
  return root;
}

function makeCtx(usage?: { tokens: number | null; contextWindow: number; percent: number | null }): any {
  return {
    cwd: "/tmp/project",
    model: { id: "test-model", provider: "test" },
    sessionManager: { getSessionName: () => undefined, getEntries: () => [] },
    getContextUsage: () => usage,
  };
}

describe("createCustomFooter", () => {
  beforeEach(() => {
    setFooterTracker(undefined as any);
    setFooterOrchestrator(undefined as any);
  });

  it("renders exactly two lines (no status/LSP line)", () => {
    setFooterContext(makeCtx());
    const lines = render();
    expect(lines).toHaveLength(2);
  });

  it("line 1 uses the native session name and never renders workflow metadata", () => {
    const ctx = makeCtx();
    ctx.sessionManager.getSessionName = () => "persistent session";
    setFooterContext(ctx);
    setFooterOrchestrator({} as any);
    const [line1] = render();
    expect(line1).toContain("persistent session");
    expect(line1).not.toContain("task:");
    expect(line1).not.toContain("phase:");
    expect(line1).not.toContain("mode:");
  });

  it("line 1 omits task metadata when no task is active", () => {
    setFooterContext(makeCtx());
    const [line1] = render();
    expect(line1).not.toContain("task:");
    expect(line1).toContain("(main)");
  });

  it("line 1 omits the branch segment when the resolver reports no repo", () => {
    setFooterContext(makeCtx());
    const [line1] = render(200, null);
    expect(line1).not.toContain("(");
  });

  it("line 1 renders a detached HEAD as (detached)", () => {
    setFooterContext(makeCtx());
    const [line1] = render(200, "detached");
    expect(line1).toContain("(detached)");
  });

  it("context indicator shows percent/used/max", () => {
    setFooterContext(makeCtx({ tokens: 38000, contextWindow: 1000000, percent: 3.8 }));
    const [, line2] = render();
    expect(line2).toContain("3.8%/38k/1.0M (auto)");
  });

  it("context indicator degrades gracefully when tokens are null", () => {
    setFooterContext(makeCtx({ tokens: null, contextWindow: 1000000, percent: null }));
    const [, line2] = render();
    expect(line2).toContain("?%/?/1.0M (auto)");
  });

  it("line 1 shows the pi-pi package version", () => {
    setFooterContext(makeCtx());
    const [line1] = render();
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(line1).toContain(`pp v${pkg.version}`);
  });
});

describe("resolveGitBranchSync", () => {
  const repos: string[] = [];
  const repo = (head: string, asWorktreeFile = false): string => {
    const dir = makeRepo(head, asWorktreeFile);
    repos.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the branch name from a normal repo", () => {
    expect(resolveGitBranchSync(repo("ref: refs/heads/feature/x"))).toBe("feature/x");
  });

  it("follows the gitdir indirection when .git is a file", () => {
    expect(resolveGitBranchSync(repo("ref: refs/heads/wt-branch", true))).toBe("wt-branch");
  });

  it("walks up to the enclosing repo", () => {
    const root = repo("ref: refs/heads/main");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(resolveGitBranchSync(nested)).toBe("main");
  });

  it("returns null when there is no repo", () => {
    const bare = mkdtempSync(join(tmpdir(), "pp-norepo-"));
    repos.push(bare);
    expect(resolveGitBranchSync(bare)).toBeNull();
  });

  it("returns null when HEAD is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-nohead-"));
    repos.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(resolveGitBranchSync(root)).toBeNull();
  });

  it("returns 'detached' when HEAD is not a ref", () => {
    expect(resolveGitBranchSync(repo("9f1c0de0f0a1b2c3d4e5f60718293a4b5c6d7e8f"))).toBe("detached");
  });

  it("returns 'detached' for a .invalid ref without shelling out", () => {
    execFileMock.mockClear();
    expect(resolveGitBranchSync(repo("ref: refs/heads/.invalid"))).toBe("detached");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("branch refresh lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setFooterContext(makeCtx());
    setFooterTracker(undefined as any);
    setFooterOrchestrator(undefined as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks up a branch change and requests a render only when the value changes", () => {
    const requestRender = vi.fn();
    let branch = "main";
    const resolve = vi.fn(() => branch);
    const footer = createCustomFooter({ requestRender } as any, theme, footerData, resolve);

    expect(footer.render(200)[0]).toContain("(main)");

    vi.advanceTimersByTime(60000);
    expect(resolve.mock.calls.length).toBeGreaterThan(1);
    expect(requestRender).not.toHaveBeenCalled();
    expect(footer.render(200)[0]).toContain("(main)");

    branch = "other";
    vi.advanceTimersByTime(10000);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(footer.render(200)[0]).toContain("(other)");

    footer.dispose?.();
  });

  it("asks git to resolve a sync-detached HEAD off the render path", async () => {
    execFileMock.mockClear();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "resolved-branch\n", ""));
    const requestRender = vi.fn();
    const footer = createCustomFooter({ requestRender } as any, theme, footerData, () => "detached");

    expect(execFileMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10000);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());

    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
    expect(footer.render(200)[0]).toContain("(resolved-branch)");

    footer.dispose?.();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
  });

  it("dispose() clears the interval", () => {
    const requestRender = vi.fn();
    let branch = "main";
    const resolve = vi.fn(() => branch);
    const footer = createCustomFooter({ requestRender } as any, theme, footerData, resolve);

    vi.advanceTimersByTime(10000);
    const callsBeforeDispose = resolve.mock.calls.length;

    footer.dispose?.();
    branch = "other";
    vi.advanceTimersByTime(60000);

    expect(resolve.mock.calls.length).toBe(callsBeforeDispose);
    expect(requestRender).not.toHaveBeenCalled();
    expect(footer.render(200)[0]).toContain("(main)");
  });
});

describe("resolvePackageVersion", () => {
  it("reads the real package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(resolvePackageVersion()).toBe(pkg.version);
  });

  it("degrades to '?' when the manifest cannot be read", () => {
    expect(resolvePackageVersion(new URL("file:///nonexistent/package.json"))).toBe("?");
  });
});
