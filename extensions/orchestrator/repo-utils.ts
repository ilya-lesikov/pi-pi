import { realpathSync, existsSync } from "fs";
import { resolve, sep } from "path";

export interface RepoInfo {
  path: string;
  baseBranch?: string;
  isRoot: boolean;
}

export function normalizeRepoPath(p: string): string {
  const abs = resolve(p);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

export function isPathInRepo(filePath: string, repoPath: string): boolean {
  const normFile = resolve(filePath);
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normRepo = normalizedRepoPath.endsWith(sep) ? normalizedRepoPath : normalizedRepoPath + sep;
  return normFile === normalizedRepoPath || normFile.startsWith(normRepo);
}

export function resolveRepoForFile(repos: RepoInfo[], filePath: string): RepoInfo | null {
  const normFile = resolve(filePath);
  let best: RepoInfo | null = null;
  let bestLen = 0;
  for (const repo of repos) {
    if (isPathInRepo(normFile, repo.path) && repo.path.length > bestLen) {
      best = repo;
      bestLen = repo.path.length;
    }
  }
  return best;
}

export function groupFilesByRepo(repos: RepoInfo[], files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const repo = resolveRepoForFile(repos, file);
    const key = repo?.path ?? "";
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  return groups;
}

export function getBaseBranchForRepo(repos: RepoInfo[], repoPath: string): string | undefined {
  const norm = normalizeRepoPath(repoPath);
  return repos.find((r) => r.path === norm)?.baseBranch;
}

export function getAllRepos(repos: RepoInfo[]): RepoInfo[] {
  return repos;
}

export function findRootRepo(repos: RepoInfo[]): RepoInfo | undefined {
  return repos.find((r) => r.isRoot);
}
