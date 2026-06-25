import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathInRepo, normalizeRepoPath, resolveRepoForFile, type RepoInfo } from "./repo-utils.js";

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
