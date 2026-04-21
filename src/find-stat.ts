import * as fsPromises from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const DEFAULT_STAT_CONCURRENCY = 32;
export const _testable = {
  stat: fsPromises.stat,
};

export async function statAllWithConcurrency(
  relPaths: string[],
  baseDir: string,
  concurrency: number = DEFAULT_STAT_CONCURRENCY,
): Promise<(Stats | null)[]> {
  const requested = Number.isFinite(concurrency)
    ? concurrency
    : DEFAULT_STAT_CONCURRENCY;
  const limit = Math.max(1, Math.min(requested, DEFAULT_STAT_CONCURRENCY));
  const out: (Stats | null)[] = new Array(relPaths.length).fill(null);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= relPaths.length) return;
      try {
        out[i] = await _testable.stat(resolvePath(baseDir, relPaths[i]));
      } catch {
        out[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, relPaths.length) }, () => worker()));
  return out;
}
