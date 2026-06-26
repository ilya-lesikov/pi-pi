import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRootRepo,
  getBaseBranchForRepo,
  groupFilesByRepo,
  isPathInRepo,
  normalizeRepoPath,
  resolveRepoForFile,
  type RepoInfo,
} from "./repo-utils.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-repo-utils-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isPathInRepo", () => {
  it("rejects boundary prefix paths", () => {
    const base = makeTempDir();
    const repoPath = join(base, "repo");
    const siblingPath = join(base, "repo-sibling", "src", "file.ts");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(base, "repo-sibling", "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "index.ts"), "export {};\n", "utf-8");
    writeFileSync(siblingPath, "export {};\n", "utf-8");

    expect(isPathInRepo(siblingPath, repoPath)).toBe(false);
  });
});

describe("resolveRepoForFile", () => {
  it("resolves files under symlinked path to canonical repo", () => {
    const base = makeTempDir();
    const realRepo = join(base, "real-repo");
    const linkRepo = join(base, "linked-repo");
    mkdirSync(join(realRepo, "src"), { recursive: true });
    writeFileSync(join(realRepo, "src", "app.ts"), "export const app = true;\n", "utf-8");
    symlinkSync(realRepo, linkRepo, "dir");

    const repos: RepoInfo[] = [{ path: normalizeRepoPath(realRepo), isRoot: false }];
    const fileViaLink = join(linkRepo, "src", "app.ts");

    expect(resolveRepoForFile(repos, fileViaLink)?.path).toBe(normalizeRepoPath(realRepo));
  });

  it("picks longest matching repo path", () => {
    const base = makeTempDir();
    const parentRepo = join(base, "repo");
    const nestedRepo = join(parentRepo, "nested");
    const nestedFile = join(nestedRepo, "src", "main.ts");
    mkdirSync(join(parentRepo, "src"), { recursive: true });
    mkdirSync(join(nestedRepo, "src"), { recursive: true });
    writeFileSync(join(parentRepo, "src", "root.ts"), "export const root = true;\n", "utf-8");
    writeFileSync(nestedFile, "export const nested = true;\n", "utf-8");

    const repos: RepoInfo[] = [
      { path: normalizeRepoPath(parentRepo), isRoot: true },
      { path: normalizeRepoPath(nestedRepo), isRoot: false },
    ];

    expect(resolveRepoForFile(repos, nestedFile)?.path).toBe(normalizeRepoPath(nestedRepo));
  });
});

describe("groupFilesByRepo", () => {
  it("groups files by matching repository paths", () => {
    const base = makeTempDir();
    const rootRepo = join(base, "root");
    const extraRepo = join(base, "extra");
    mkdirSync(join(rootRepo, "src"), { recursive: true });
    mkdirSync(join(extraRepo, "lib"), { recursive: true });
    const rootFile = join(rootRepo, "src", "a.ts");
    const extraFile = join(extraRepo, "lib", "b.ts");
    writeFileSync(rootFile, "export const a = 1;\n", "utf-8");
    writeFileSync(extraFile, "export const b = 2;\n", "utf-8");

    const repos: RepoInfo[] = [
      { path: normalizeRepoPath(rootRepo), isRoot: true },
      { path: normalizeRepoPath(extraRepo), isRoot: false },
    ];

    const grouped = groupFilesByRepo(repos, [rootFile, extraFile]);

    expect(grouped.get(normalizeRepoPath(rootRepo))).toEqual([rootFile]);
    expect(grouped.get(normalizeRepoPath(extraRepo))).toEqual([extraFile]);
  });

  it("puts unmatched files under empty-key bucket", () => {
    const base = makeTempDir();
    const repo = join(base, "repo");
    const outside = join(base, "outside.ts");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(outside, "export const outside = 1;\n", "utf-8");

    const repos: RepoInfo[] = [{ path: normalizeRepoPath(repo), isRoot: true }];

    const grouped = groupFilesByRepo(repos, [outside]);

    expect(grouped.get("")).toEqual([outside]);
  });
});

describe("findRootRepo", () => {
  it("finds root repository entry", () => {
    const repos: RepoInfo[] = [
      { path: "/tmp/a", isRoot: false },
      { path: "/tmp/b", isRoot: true },
    ];

    expect(findRootRepo(repos)).toEqual({ path: "/tmp/b", isRoot: true });
  });

  it("returns undefined when no root repo exists", () => {
    const repos: RepoInfo[] = [{ path: "/tmp/a", isRoot: false }];

    expect(findRootRepo(repos)).toBeUndefined();
  });
});

describe("getBaseBranchForRepo", () => {
  it("returns base branch for matching repository path", () => {
    const base = makeTempDir();
    const repoPath = join(base, "repo");
    mkdirSync(repoPath, { recursive: true });
    const repos: RepoInfo[] = [{ path: normalizeRepoPath(repoPath), isRoot: true, baseBranch: "origin/main" }];

    expect(getBaseBranchForRepo(repos, repoPath)).toBe("origin/main");
  });

  it("returns undefined for unknown repository path", () => {
    const base = makeTempDir();
    const repoPath = join(base, "repo");
    mkdirSync(repoPath, { recursive: true });
    const repos: RepoInfo[] = [{ path: normalizeRepoPath(repoPath), isRoot: true, baseBranch: "origin/main" }];

    expect(getBaseBranchForRepo(repos, join(base, "missing"))).toBeUndefined();
  });
});
