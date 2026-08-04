import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function isReviewFileForRound(filename: string, pass: number): boolean {
  return new RegExp(`_round-${pass}\\.md$`).test(filename);
}

// Round files are named `<epoch>_<reviewer>_round-<N>.md`. Extract the reviewer
// name (the segment between the leading epoch and the `_round-N` suffix).
export function reviewerNameFromRoundFile(filename: string, pass: number): string | null {
  const m = filename.match(new RegExp(`^\\d+_(.+)_round-${pass}\\.md$`));
  return m ? m[1] : null;
}

// A review is COMPLETE only when the model finished and marked it so. The
// reviewer prompts write a `VERDICT: UNKNOWN` / `REVIEW_STATUS: INCOMPLETE`
// stub FIRST and overwrite it ending in `REVIEW_STATUS: COMPLETE`; a file that
// still says INCOMPLETE (or was never overwritten) is NOT a completed review.
export function isReviewComplete(content: string): boolean {
  if (/REVIEW_STATUS\s*:\s*INCOMPLETE/i.test(content)) return false;
  if (/REVIEW_STATUS\s*:\s*COMPLETE/i.test(content)) return true;
  // Legacy files (written before the stub-first convention) carry no status
  // marker; treat a file with a parseable VERDICT token as complete so we don't
  // retroactively invalidate historical rounds. The colon is optional to mirror
  // parseVerdict (which matches `VERDICT: X`, `## VERDICT\n\nX`, `VERDICT X`).
  return /VERDICT\**\s*:?\**\s*\n*\s*[A-Z_]+/i.test(content);
}

// Reconcile the round's reviewer coverage against the roster that was actually
// launched. For every expected reviewer that produced NO file, or only an
// INCOMPLETE stub, write an explicit placeholder round file (VERDICT: UNKNOWN /
// REVIEW_STATUS: INCOMPLETE) so downstream consumers (the unanimous-approve
// gate and the cross-pass summary) see the gap instead of silently dropping a
// reviewer. Returns the reviewer names that were missing/incomplete.
export function reconcileMissingReviewers(
  reviewsDir: string,
  pass: number,
  expectedReviewers: string[],
): string[] {
  if (expectedReviewers.length === 0) return [];
  if (!existsSync(reviewsDir)) mkdirSync(reviewsDir, { recursive: true });

  const roundFiles = readdirSync(reviewsDir).filter((f) => isReviewFileForRound(f, pass));
  const completeByReviewer = new Set<string>();
  for (const f of roundFiles) {
    const name = reviewerNameFromRoundFile(f, pass);
    if (!name) continue;
    let content = "";
    try {
      content = readFileSync(join(reviewsDir, f), "utf-8");
    } catch {
      continue;
    }
    if (isReviewComplete(content)) completeByReviewer.add(name);
  }

  const missing: string[] = [];
  const epoch = Math.floor(Date.now() / 1000);
  for (const reviewer of expectedReviewers) {
    if (completeByReviewer.has(reviewer)) continue;
    missing.push(reviewer);
    // Only create a placeholder when the reviewer left NO file at all; an
    // existing INCOMPLETE stub already records the gap and keeping it preserves
    // whatever partial content the reviewer managed to write.
    const hasAnyFile = roundFiles.some((f) => reviewerNameFromRoundFile(f, pass) === reviewer);
    if (hasAnyFile) continue;
    const placeholderPath = join(reviewsDir, `${epoch}_${reviewer}_round-${pass}.md`);
    writeFileSync(
      placeholderPath,
      [
        "VERDICT: UNKNOWN",
        "REVIEW_STATUS: INCOMPLETE",
        "",
        `Reviewer "${reviewer}" produced no completed output for round ${pass}.`,
      ].join("\n"),
      "utf-8",
    );
  }
  return missing;
}
