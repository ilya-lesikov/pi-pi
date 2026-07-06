import { readFileSync } from "fs";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const PI_PI_FOOTER = "\n\n_Generated with pi-pi_";

export interface ReviewAnchor {
  path: string;
  line: number;
  body: string;
}

export interface PrTarget {
  number: number;
  headSha: string;
  owner: string;
  repo: string;
}

export interface PostPrCommentsResult {
  ok: boolean;
  posted: number;
  skipped: ReviewAnchor[];
  reason?: string;
}

// Parse the `ANCHORS:` block(s) that reviewers emit into the synthesized review.
// Each anchor line is `relative/path:line — text`. The em dash (—) or a plain
// hyphen separator are both accepted; everything before the last `:line` is the
// path. Lines that don't match (headings, prose, `(none)`) are ignored.
export function parseReviewAnchors(reviewText: string): ReviewAnchor[] {
  const anchors: ReviewAnchor[] = [];
  const seen = new Set<string>();
  for (const rawLine of reviewText.split("\n")) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "");
    const match = line.match(/^(.+?):(\d+)\s*(?:—|--|-)\s*(.+)$/);
    if (!match) continue;
    const path = match[1].trim();
    const lineNo = Number(match[2]);
    const body = match[3].trim();
    if (!path || !Number.isFinite(lineNo) || lineNo <= 0 || !body) continue;
    // A path must look like a file path, not prose (reject entries with spaces
    // in the path portion — those are sentences, not `file:line` anchors).
    if (/\s/.test(path)) continue;
    const key = `${path}:${lineNo}:${body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ path, line: lineNo, body });
  }
  return anchors;
}

export function parseReviewAnchorsFromFile(filePath: string): ReviewAnchor[] {
  try {
    return parseReviewAnchors(readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

// Resolve the PR for the current branch in `repoPath`, returning the number and
// head commit SHA needed to anchor review comments. Returns null when there is
// no PR, gh is unavailable/unauthenticated, or the payload is unparseable.
export async function detectPrTarget(exec: ExecFn, repoPath: string): Promise<PrTarget | null> {
  try {
    const authStatus = await exec("gh", ["auth", "status"], { cwd: repoPath, timeout: 10000 });
    if (authStatus.code !== 0) return null;
  } catch {
    return null;
  }
  try {
    const res = await exec(
      "gh",
      ["pr", "view", "--json", "number,headRefOid,headRepositoryOwner,headRepository"],
      { cwd: repoPath, timeout: 10000 },
    );
    if (res.code !== 0) return null;
    const parsed = JSON.parse(res.stdout);
    const number = typeof parsed?.number === "number" ? parsed.number : Number(parsed?.number);
    const headSha = typeof parsed?.headRefOid === "string" ? parsed.headRefOid.trim() : "";
    const owner = typeof parsed?.headRepositoryOwner?.login === "string" ? parsed.headRepositoryOwner.login : "";
    const repo = typeof parsed?.headRepository?.name === "string" ? parsed.headRepository.name : "";
    if (!Number.isFinite(number) || number <= 0 || !headSha || !owner || !repo) return null;
    return { number, headSha, owner, repo };
  } catch {
    return null;
  }
}

// Post one line-anchored PR review comment per anchor via the GitHub pulls API.
// GitHub validates line/side against the PR diff and returns 422 for lines that
// aren't part of the diff — those anchors are collected in `skipped` rather than
// failing the whole batch.
export async function postPrLineComments(
  exec: ExecFn,
  repoPath: string,
  target: PrTarget,
  anchors: ReviewAnchor[],
): Promise<PostPrCommentsResult> {
  const endpoint = `repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`;
  const skipped: ReviewAnchor[] = [];
  let posted = 0;
  for (const anchor of anchors) {
    const body = anchor.body.endsWith(PI_PI_FOOTER) ? anchor.body : `${anchor.body}${PI_PI_FOOTER}`;
    try {
      const res = await exec(
        "gh",
        [
          "api",
          "--method",
          "POST",
          endpoint,
          "-f",
          `body=${body}`,
          "-f",
          `commit_id=${target.headSha}`,
          "-f",
          `path=${anchor.path}`,
          "-F",
          `line=${anchor.line}`,
          "-f",
          "side=RIGHT",
        ],
        { cwd: repoPath, timeout: 15000 },
      );
      if (res.code === 0) {
        posted += 1;
      } else {
        skipped.push(anchor);
      }
    } catch {
      skipped.push(anchor);
    }
  }
  return { ok: true, posted, skipped };
}
