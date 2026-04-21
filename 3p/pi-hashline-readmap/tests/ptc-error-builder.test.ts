import { describe, it, expect } from "vitest";
import { buildPtcError, type PtcError } from "../src/ptc-value.js";

describe("buildPtcError", () => {
  it("returns { code, message } when hint and details are omitted", () => {
    const err: PtcError = buildPtcError("file-not-found", "File not found: foo.ts");
    expect(err).toEqual({ code: "file-not-found", message: "File not found: foo.ts" });
    expect(Object.prototype.hasOwnProperty.call(err, "hint")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(err, "details")).toBe(false);
  });

  it("includes hint when provided", () => {
    const err = buildPtcError("file-not-read", "Read first.", "Call read(\"foo\") first.");
    expect(err.hint).toBe("Call read(\"foo\") first.");
    expect(Object.prototype.hasOwnProperty.call(err, "details")).toBe(false);
  });

  it("includes details when provided", () => {
    const err = buildPtcError("hash-mismatch", "x", undefined, { updatedAnchors: [] });
    expect(err.details).toEqual({ updatedAnchors: [] });
    expect(Object.prototype.hasOwnProperty.call(err, "hint")).toBe(false);
  });

  it("omits hint property when explicitly undefined", () => {
    const err = buildPtcError("x", "y", undefined, undefined);
    expect(Object.prototype.hasOwnProperty.call(err, "hint")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(err, "details")).toBe(false);
  });
});
