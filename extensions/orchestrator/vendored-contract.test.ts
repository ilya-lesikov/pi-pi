import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

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
  it("exposes every method the orchestrator calls on the global manager handle", () => {
    // The handle is reached via Symbol.for("pi-subagents:manager"), usually
    // called optionally (mgr?.foo?.()), so a removed method is a silent no-op.
    for (const method of ["getRecord", "refreshWidget", "setMaxConcurrent"]) {
      expect(orchestratorCode).toMatch(new RegExp(`${method}\\??\\.?\\(`));
      expect(vendoredCode, `the orchestrator calls ${method}() on the manager handle but the vendored code does not define it`).toMatch(
        new RegExp(`${method}[(:]`),
      );
    }
  });

  it("still publishes the global handles the orchestrator reaches for", () => {
    for (const key of ["pi-subagents:manager", "pi-subagents:menu"]) {
      expect(orchestratorCode).toContain(`Symbol.for("${key}")`);
      expect(vendoredCode, `${key} is read by the orchestrator but never published by the vendored code`).toContain(`Symbol.for("${key}")`);
    }
  });
});
