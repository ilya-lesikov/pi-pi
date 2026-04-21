import { describe, it, expect } from "vitest";
import { parseSize, parseRelativeOrIsoDate } from "../src/find-parsers.js";

describe("parseSize", () => {
  it("accepts a plain number as bytes", () => {
    expect(parseSize("minSize", 0)).toBe(0);
    expect(parseSize("minSize", 1024)).toBe(1024);
    expect(parseSize("minSize", 1048576)).toBe(1048576);
  });

  it("accepts a numeric string as bytes", () => {
    expect(parseSize("minSize", "1024")).toBe(1024);
    expect(parseSize("minSize", "0")).toBe(0);
  });

  it("accepts B suffix as bytes", () => {
    expect(parseSize("minSize", "100B")).toBe(100);
    expect(parseSize("minSize", "0B")).toBe(0);
  });

  it("accepts K and KB suffix as 1024 bytes", () => {
    expect(parseSize("minSize", "1K")).toBe(1024);
    expect(parseSize("minSize", "1KB")).toBe(1024);
    expect(parseSize("minSize", "10KB")).toBe(10 * 1024);
  });

  it("accepts M and MB suffix as 1024^2 bytes", () => {
    expect(parseSize("minSize", "1M")).toBe(1024 * 1024);
    expect(parseSize("minSize", "1MB")).toBe(1024 * 1024);
    expect(parseSize("minSize", "2MB")).toBe(2 * 1024 * 1024);
  });

  it("accepts G and GB suffix as 1024^3 bytes", () => {
    expect(parseSize("minSize", "1G")).toBe(1024 ** 3);
    expect(parseSize("minSize", "1GB")).toBe(1024 ** 3);
  });

  it("accepts fractional values and rounds to the nearest byte", () => {
    expect(parseSize("minSize", "1.5MB")).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseSize("minSize", "0.5K")).toBe(512);
  });

  it("is case-insensitive on unit suffix", () => {
    expect(parseSize("minSize", "10kb")).toBe(10 * 1024);
    expect(parseSize("minSize", "10Mb")).toBe(10 * 1024 * 1024);
    expect(parseSize("minSize", "1gB")).toBe(1024 ** 3);
  });

  it("throws an error naming the field and value on malformed input", () => {
    expect(() => parseSize("minSize", "10XB")).toThrow(/minSize/);
    expect(() => parseSize("minSize", "10XB")).toThrow(/10XB/);
    expect(() => parseSize("maxSize", "abc")).toThrow(/maxSize/);
    expect(() => parseSize("maxSize", "")).toThrow(/maxSize/);
    expect(() => parseSize("minSize", -1)).toThrow(/minSize/);
  });
});

describe("parseRelativeOrIsoDate", () => {
  it("accepts a minutes shorthand (Nm)", () => {
    const before = new Date("2024-06-01T12:00:00Z").getTime();
    const d = parseRelativeOrIsoDate("modifiedSince", "30m", new Date(before));
    expect(d.getTime()).toBe(before - 30 * 60 * 1000);
  });

  it("accepts hours shorthand including 24h", () => {
    const before = new Date("2024-06-01T12:00:00Z").getTime();
    const d1 = parseRelativeOrIsoDate("modifiedSince", "1h", new Date(before));
    const d24 = parseRelativeOrIsoDate("modifiedSince", "24h", new Date(before));
    expect(d1.getTime()).toBe(before - 60 * 60 * 1000);
    expect(d24.getTime()).toBe(before - 24 * 60 * 60 * 1000);
  });

  it("accepts a days shorthand (Nd)", () => {
    const before = new Date("2024-06-01T12:00:00Z").getTime();
    const d = parseRelativeOrIsoDate("modifiedSince", "7d", new Date(before));
    expect(d.getTime()).toBe(before - 7 * 24 * 60 * 60 * 1000);
  });

  it("accepts an ISO date (YYYY-MM-DD)", () => {
    const d = parseRelativeOrIsoDate("modifiedSince", "2024-01-01");
    expect(d.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("accepts a full ISO timestamp", () => {
    const d = parseRelativeOrIsoDate("modifiedSince", "2024-01-01T12:34:56Z");
    expect(d.toISOString()).toBe("2024-01-01T12:34:56.000Z");
  });

  it("throws an error naming the field and value on malformed input", () => {
    expect(() => parseRelativeOrIsoDate("modifiedSince", "1y")).toThrow(/modifiedSince/);
    expect(() => parseRelativeOrIsoDate("modifiedSince", "1y")).toThrow(/1y/);
    expect(() => parseRelativeOrIsoDate("modifiedSince", "not-a-date")).toThrow(/modifiedSince/);
    expect(() => parseRelativeOrIsoDate("modifiedSince", "")).toThrow(/modifiedSince/);
    expect(() => parseRelativeOrIsoDate("modifiedSince", "7")).toThrow(/modifiedSince/);
  });

  it("rejects ISO dates that look valid but denote a non-existent calendar date", () => {
    expect(() => parseRelativeOrIsoDate("modifiedSince", "2024-13-45")).toThrow(/modifiedSince/);
    expect(() => parseRelativeOrIsoDate("modifiedSince", "2024-13-45")).toThrow(/2024-13-45/);
  });
});
