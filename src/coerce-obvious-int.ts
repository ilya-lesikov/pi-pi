const BASE10_INT_RE = /^-?\d+$/;

type CoercedIntResult =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

export function coerceObviousBase10Int(value: unknown): unknown;
export function coerceObviousBase10Int(value: unknown, name: string): CoercedIntResult;
export function coerceObviousBase10Int(value: unknown, name?: string): unknown | CoercedIntResult {
  if (name === undefined) {
    if (typeof value === "string" && BASE10_INT_RE.test(value)) {
      return Number.parseInt(value, 10);
    }
    return value;
  }

  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { ok: true, value };
    }
    return {
      ok: false,
      message: `Invalid ${name}: expected a base-10 integer, received ${value}.`,
    };
  }

  if (typeof value === "string" && BASE10_INT_RE.test(value)) {
    return { ok: true, value: Number.parseInt(value, 10) };
  }

  return {
    ok: false,
    message: `Invalid ${name}: expected a base-10 integer, received ${JSON.stringify(value)}.`,
  };
}
