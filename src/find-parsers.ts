const SIZE_MULTIPLIERS: Record<string, number> = {
  "": 1,
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 * 1024,
  MB: 1024 * 1024,
  G: 1024 ** 3,
  GB: 1024 ** 3,
};

export function parseSize(field: string, value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Invalid ${field} value: ${value} (expected a non-negative number of bytes)`,
      );
    }
    return value;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid ${field} value: ${JSON.stringify(value)} ` +
        `(expected a number with optional B/K/KB/M/MB/G/GB suffix; units are 1024-based)`,
    );
  }

  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  const mult = SIZE_MULTIPLIERS[suffix];
  if (mult === undefined) {
    throw new Error(
      `Invalid ${field} value: ${JSON.stringify(value)} ` +
        `(unknown unit '${match[2]}'; accepted: B, K, KB, M, MB, G, GB)`,
    );
  }

  return Math.round(num * mult);
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseRelativeOrIsoDate(
  field: string,
  value: string,
  now: Date = new Date(),
): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid ${field} value: ${JSON.stringify(value)} ` +
        `(expected ISO date/timestamp or relative shorthand like '1h', '24h', '7d', '30m')`,
    );
  }

  const rel = /^\s*(\d+)\s*([mhd])\s*$/.exec(value);
  if (rel) {
    const n = parseInt(rel[1], 10);
    return new Date(now.getTime() - n * RELATIVE_UNIT_MS[rel[2]]);
  }

  if (ISO_DATE_RE.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  if (ISO_TS_RE.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  throw new Error(
    `Invalid ${field} value: ${JSON.stringify(value)} ` +
      `(expected ISO date/timestamp or relative shorthand like '1h', '24h', '7d', '30m')`,
  );
}
