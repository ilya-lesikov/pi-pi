import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureProviderRetrySettings, readProviderRetry } from "./provider-retry.js";

describe("provider retry settings", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pp-retry-"));
    path = join(dir, "settings.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("raises the ceiling when pi has no retry settings of its own", () => {
    expect(ensureProviderRetrySettings(path)).toBe("written");

    const written = readProviderRetry(path);
    expect(written.maxRetries).toBeGreaterThan(3);
    expect(written.maxRetryDelayMs).toBeGreaterThan(60_000);
  });

  it("leaves a count the user chose alone, however low", () => {
    writeFileSync(path, JSON.stringify({ retry: { provider: { maxRetries: 1 } } }), "utf-8");

    expect(ensureProviderRetrySettings(path)).toBe("present");
    expect(readProviderRetry(path).maxRetries).toBe(1);
  });

  it("keeps the rest of pi's settings intact", () => {
    writeFileSync(path, JSON.stringify({ packages: ["./pi-pi"], hideThinkingBlock: true }), "utf-8");

    ensureProviderRetrySettings(path);

    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.packages).toEqual(["./pi-pi"]);
    expect(raw.hideThinkingBlock).toBe(true);
    expect(raw.retry.provider.maxRetries).toBeGreaterThan(3);
  });

  it("reports nothing to read as no settings rather than failing", () => {
    expect(readProviderRetry(join(dir, "absent.json"))).toEqual({});
  });
});
