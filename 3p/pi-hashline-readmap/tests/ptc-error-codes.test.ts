import { describe, it, expect } from "vitest";
import { PTC_ERROR_CODES, type PtcErrorCode } from "../src/ptc-error-codes.js";

const REQUIRED_CODES = [
  "file-not-found",
  "path-is-directory",
  "permission-denied",
  "offset-past-end",
  "invalid-params-combo",
  "invalid-offset",
  "invalid-limit",
  "file-not-read",
  "hash-mismatch",
  "no-op",
  "text-not-found",
  "binary-file",
  "invalid-edit-variant",
  "binary-file-target",
  "passthrough-unparsed",
  "sg-not-installed",
  "sg-execution-error",
  "path-not-found",
  "path-not-directory",
  "binary-content",
  "nu-non-zero-exit",
  "nu-timed-out",
  "nu-spawn-error",
  "nu-temp-file-error",
] as const;

describe("PTC_ERROR_CODES taxonomy", () => {
  it("includes every required code from the spec", () => {
    for (const code of REQUIRED_CODES) {
      expect(PTC_ERROR_CODES).toHaveProperty(code);
      expect(typeof PTC_ERROR_CODES[code as PtcErrorCode].description).toBe("string");
      expect(PTC_ERROR_CODES[code as PtcErrorCode].description.length).toBeGreaterThan(0);
      expect(typeof PTC_ERROR_CODES[code as PtcErrorCode].trigger).toBe("string");
      expect(PTC_ERROR_CODES[code as PtcErrorCode].trigger.length).toBeGreaterThan(0);
    }
  });

  it("uses kebab-case for every code", () => {
    for (const code of Object.keys(PTC_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });
});
