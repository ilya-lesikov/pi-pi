import type { RepoInfo } from "../repo-utils.js";

export function buildRepoContext(repos: RepoInfo[]): string {
  if (repos.length === 0) return "";
  const lines = repos.map((r) => {
    const label = r.isRoot ? " (root)" : "";
    const branch = r.baseBranch ? `, base: ${r.baseBranch}` : "";
    return `  - ${r.path}${label}${branch}`;
  });
  return `\nRegistered repositories:\n${lines.join("\n")}\n`;
}
