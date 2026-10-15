import { describe, expect, it } from "vitest";
import { existsSync, openSync, closeSync, readSync, realpathSync, statSync } from "fs";
import { delimiter, join } from "path";
import { isUnrecognizedTransportError } from "./provider-retry.js";

// Stock pi is a compiled binary with no `dist/` on disk, and it serves an
// extension's `@earendil-works/pi-coding-agent` import from its own bundle
// rather than from node_modules. So the copy this repo builds against says
// nothing about what users run: the assertions below read the binary on PATH,
// which is the only artifact the patch will ever meet.
describe("stock pi contract — the retry predicate", () => {
  const pi = piOnPath();

  it.runIf(pi)("still calls a retry predicate the patch can wrap", () => {
    expect(scan(pi!, "_isRetryableError(message)")).toBe(true);
    expect(scan(pi!, "this._isRetryableError(")).toBe(true);
  });

  it.runIf(pi)("still does not recognize the status pi-pi adds, so the patch is still needed", () => {
    const patterns = block(pi!, "var RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([");
    expect(patterns).toContain('"429"');
    expect(patterns).not.toContain('"499"');
  });

  // The patch adds to pi's answer, so it must not resurrect what pi refuses
  // outright. It mirrors this list; a marker added here and not there is a
  // spent quota retried until the attempts run out.
  it.runIf(pi)("still refuses a spent quota with the markers the patch mirrors", () => {
    const patterns = block(pi!, "var NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([");
    for (const marker of ["GoUsageLimitError", "FreeUsageLimitError", "available balance", "insufficient_quota", "out of budget", "quota exceeded", "billing"]) {
      expect(patterns, `pi refuses ${marker}; provider-retry.ts must too`).toContain(marker);
      expect(isUnrecognizedTransportError(`499 status code: ${marker}`)).toBe(false);
    }
    expect(isUnrecognizedTransportError("499 status code (no body)")).toBe(true);
  });
});

// Workers run as in-process child sessions built from the host's SDK, and the
// no-hang guarantees lean on a few of its internals: the tool list stays a
// replaceable property (the interrupt wrapper reinstalls on every refresh),
// tools are awaited with nothing racing them (so the wrapper must), and a
// custom message steers a streaming session instead of waiting for it.
describe("stock pi contract — what workers rely on", () => {
  const pi = piOnPath();

  it.runIf(pi)("loads inline extension factories with discovery switched off", () => {
    expect(scan(pi!, "extensionFactories")).toBe(true);
    expect(scan(pi!, "noExtensions")).toBe(true);
  });

  it.runIf(pi)("keeps the active tool list a settable state property", () => {
    expect(scan(pi!, "set tools(nextTools)")).toBe(true);
  });

  it.runIf(pi)("awaits a tool's execute without its own timeout", () => {
    expect(scan(pi!, "prepared.tool.execute(prepared.toolCall.id, prepared.args, signal")).toBe(true);
  });

  it.runIf(pi)("steers a streaming session with a custom message unless told to follow up", () => {
    expect(scan(pi!, "this.isStreaming && options?.triggerTurn !== false")).toBe(true);
    expect(scan(pi!, "this.agent.steer(appMessage)")).toBe(true);
  });
});

/**
 * The pi a user runs: the first one on PATH, with symlinks resolved.
 *
 * A dev checkout carries its own `node_modules/.bin/pi`, and the test runner
 * puts that directory first — so it is skipped. The library copy this repo
 * builds against is precisely what these assertions must not read.
 */
function piOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["pi", "pi.exe", "pi.cmd"]) {
      const candidate = join(dir, name);
      try {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        const real = realpathSync(candidate);
        if (!real.includes("node_modules")) return real;
      } catch {}
    }
  }
  return undefined;
}

/** Whether a needle appears anywhere in a file too large to hold in memory. */
function scan(file: string, needle: string): boolean {
  return read(file, (text) => (text.includes(needle) ? true : undefined)) ?? false;
}

/** A marker's line and what follows it, up to `length` characters. */
function block(file: string, marker: string, length = 2000): string {
  return read(file, (text, last) => {
    const at = text.indexOf(marker);
    if (at === -1 || (!last && text.length - at < length)) return undefined;
    return text.slice(at, at + length);
  }) ?? "";
}

/** Searches a file in windows, so a 100MB binary never lands in one string. */
function read<T>(file: string, find: (text: string, last: boolean) => T | undefined): T | undefined {
  const size = statSync(file).size;
  const window = 8 * 1024 * 1024;
  const overlap = 8192;
  const fd = openSync(file, "r");
  try {
    let tail = "";
    for (let offset = 0; offset < size; offset += window) {
      const buffer = Buffer.alloc(Math.min(window, size - offset));
      readSync(fd, buffer, 0, buffer.length, offset);
      const text = tail + buffer.toString("latin1");
      const found = find(text, offset + buffer.length >= size);
      if (found !== undefined) return found;
      tail = text.slice(-overlap);
    }
  } finally {
    closeSync(fd);
  }
  return undefined;
}
