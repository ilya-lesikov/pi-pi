import { describe, expect, it } from "vitest";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import { delimiter, join } from "path";
import { isUnrecognizedTransportError } from "./provider-retry.js";

// The orchestrator drives subagents through a vendored copy of pi-subagents
// (3p/pi-subagents), which carries local patches on top of upstream. `git
// subtree` updates overwrite that tree wholesale, and the coupling is entirely
// dynamic — events on a bus, options forwarded through an `options?: any` RPC
// boundary — so a reverted patch produces NO type error and NO runtime error.
// It just silently stops working.
//
// That is not hypothetical: the v0.13.0 update (5e1f882) reverted the
// validateCompletion hook and the first_tool/first_turn emission, and both went
// unnoticed for months while every caller kept passing/subscribing. These tests
// assert the couplings themselves, so the next subtree update fails loudly here
// instead of degrading silently in production.

const repoRoot = join(import.meta.dirname, "..", "..");
const vendoredSrc = join(repoRoot, "3p", "pi-subagents", "src");
const orchestratorDir = join(repoRoot, "extensions", "orchestrator");

function sourceFiles(dir: string, skipTests: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full, skipTests));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (skipTests && entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

function concat(files: string[]): string {
  return files.map((f) => readFileSync(f, "utf-8")).join("\n");
}

const orchestratorCode = concat(sourceFiles(orchestratorDir, true));
const vendoredCode = concat(sourceFiles(vendoredSrc, true));

function matchAll(code: string, re: RegExp): string[] {
  return [...new Set([...code.matchAll(re)].map((m) => m[1]))].sort();
}

describe("vendored pi-subagents contract — events", () => {
  it("emits every subagents:* event the orchestrator subscribes to", () => {
    const subscribed = matchAll(orchestratorCode, /events\.on\("(subagents:[a-z_:-]+)"/g);
    // Guard against the regex silently matching nothing and vacuously passing.
    expect(subscribed.length).toBeGreaterThan(0);

    const unemitted = subscribed.filter(
      (name) => !new RegExp(`events\\.emit\\(\\s*"${name}"`).test(vendoredCode),
    );
    expect(unemitted, `orchestrator subscribes to these but the vendored code never emits them (a subtree update likely reverted a local patch): ${unemitted.join(", ")}`).toEqual([]);
  });

  it("handles every subagents:rpc:* request the orchestrator sends", () => {
    const sent = matchAll(orchestratorCode, /events\.emit\("(subagents:rpc:[a-z_:-]+)"/g);
    expect(sent.length).toBeGreaterThan(0);

    const unhandled = sent.filter((name) => !new RegExp(`"${name}"`).test(vendoredCode));
    expect(unhandled, `orchestrator sends these RPCs but the vendored code has no handler: ${unhandled.join(", ")}`).toEqual([]);
  });

  it("handles the register/unregister/extension-only events the orchestrator emits", () => {
    // These drive agent-definition registration; a dropped handler means the
    // orchestrator's planner/reviewer agent types never exist.
    for (const name of ["subagents:register-agents", "subagents:unregister-agents", "subagents:set-extension-only"]) {
      expect(orchestratorCode).toContain(`events.emit("${name}"`);
      expect(vendoredCode, `${name} is emitted by the orchestrator but absent from the vendored code`).toContain(`"${name}"`);
    }
  });
});

describe("vendored pi-subagents contract — spawn options", () => {
  // spawnViaRpc forwards these across an `options?: any` RPC boundary, so a
  // field the vendored code stops reading is accepted and ignored. This is the
  // exact shape of the validateCompletion regression.
  const forwarded = ["description", "run_in_background", "maxTurns", "validateCompletion", "maxValidationRetries"];

  it("forwards exactly the options this test knows about", () => {
    // If someone adds a forwarded option, this fails and forces them to extend
    // the coverage below rather than adding a silently-droppable field.
    const registry = readFileSync(join(orchestratorDir, "agents", "registry.ts"), "utf-8");
    const block = registry.slice(registry.indexOf('events.emit("subagents:rpc:spawn"'));
    const sent = matchAll(block.slice(0, block.indexOf("});")), /^\s+([a-zA-Z_]+):/gm);
    expect(sent.filter((k) => k !== "requestId" && k !== "type" && k !== "prompt" && k !== "options").sort())
      .toEqual([...forwarded].sort());
  });

  it("reads every forwarded option in the vendored code", () => {
    // run_in_background is normalized to isBackground by the RPC layer rather
    // than read under its wire name, so accept either spelling.
    const aliases: Record<string, string[]> = { run_in_background: ["run_in_background", "isBackground"] };
    const unread = forwarded.filter(
      (opt) => !(aliases[opt] ?? [opt]).some((name) => vendoredCode.includes(name)),
    );
    expect(unread, `these spawn options are forwarded but never read by the vendored code, so they are silently ignored: ${unread.join(", ")}`).toEqual([]);
  });

  it("actually invokes validateCompletion in the runner, not merely accepts it", () => {
    // Accepting the field is not enough — the regression was a runner that
    // threaded the option through without ever calling it.
    const runner = readFileSync(join(vendoredSrc, "agent-runner.ts"), "utf-8");
    expect(runner).toMatch(/options\.validateCompletion\(\)/);
  });
});

describe("vendored pi-subagents contract — manager handle", () => {
  it("exposes the bounded-worker operations used by the session control panel", () => {
    for (const method of ["listAgents", "abortAll"]) {
      expect(orchestratorCode).toMatch(new RegExp(`${method}\\??\\.?\\(`));
      expect(vendoredCode).toMatch(new RegExp(`${method}[(:]`));
    }
  });

  it("publishes the manager handle consumed by pi-pi", () => {
    const key = "pi-subagents:manager";
    expect(orchestratorCode).toContain(`Symbol.for("${key}")`);
    expect(vendoredCode).toContain(`Symbol.for("${key}")`);
  });
});

describe("vendored pi-subagents contract — local patches", () => {
  // pi-pi pins every agent type's model and effort, and an agent config's model
  // outranks the tool call's own argument, so the Agent tool must stop
  // advertising both in extension-only mode. A subtree update that drops this
  // leaves the tool inviting an override that is silently discarded.
  it("strips the model/thinking guidance in extension-only mode", () => {
    const index = readFileSync(join(vendoredSrc, "index.ts"), "utf-8");
    expect(index).toContain("MODEL_CHOICE_GUIDELINES");
    expect(index).toMatch(/applyExtensionOnlyToolSurface\(data\.enabled\)/);
  });

  // pi-pi resumes a worker that died on a rate-limited provider instead of
  // respawning it, so the transcript it had already built survives. Both halves
  // are droppable in silence: without the handle method the retry finds nothing
  // to call, and without the lifecycle emit the resumed run finishes invisibly.
  it("exposes resume on the manager handle and reports a lifecycle-emitting resume", () => {
    const manager = readFileSync(join(vendoredSrc, "agent-manager.ts"), "utf-8");
    const index = readFileSync(join(vendoredSrc, "index.ts"), "utf-8");
    expect(orchestratorCode).toMatch(/manager\.resume\(/);
    expect(index).toMatch(/resume:\s*\(id: string/);
    expect(manager).toMatch(/options\?:\s*\{\s*emitLifecycle\?: boolean\s*\}/);
    expect(manager).toMatch(/if \(options\?\.emitLifecycle\) \{\s*\n\s*try \{ this\.onComplete/);
    // A resumed run must own its promise and abort controller, or a waiter gets
    // the previous run's result and a stop never reaches the session.
    expect(manager).toMatch(/record\.promise = run\.then/);
    expect(manager).toMatch(/record\.abortController = controller/);
  });

  it("exposes the fleet operations the orchestrator calls on the handle", () => {
    const index = readFileSync(join(vendoredSrc, "index.ts"), "utf-8");
    const handle = index.slice(index.indexOf("[MANAGER_KEY] = {"));
    for (const method of ["listAgents", "abortAll", "getRecord", "resume"]) {
      expect(handle.slice(0, handle.indexOf("\n    };")), `${method} is missing from the published manager handle`).toContain(`${method}:`);
    }
  });
});

// pi decides whether a failed turn is retried in a private method holding a
// literal list of statuses. No setting reaches it, so pi-pi widens it on the
// prototype pi calls it through — a coupling that breaks in silence: a renamed
// method leaves the patch wrapping nothing, and a 499 kills the turn again.
//
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
