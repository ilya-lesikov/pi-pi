import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, afterEach } from "vitest";
import { subagentSessionDepth } from "./index.js";

// Documents the shared contract for Symbol.for("pi-pi:subagent-session-scope")
// between 3p/pi-subagents/src/agent-runner.ts (writer) and its three readers:
// extensions/orchestrator/index.ts, 3p/pi-tasks/src/index.ts and
// 3p/pi-lsp/extensions/lsp/index.ts.
//
// The marker must be an ASYNC scope, not a plain global flag: the host also
// re-instantiates every extension when the root session is switched, and a flag
// left behind by an earlier subagent load would make that root session look like
// a subagent one.
const SCOPE_KEY = Symbol.for("pi-pi:subagent-session-scope");

function installScope(): AsyncLocalStorage<{ depth: number }> {
  const scope = new AsyncLocalStorage<{ depth: number }>();
  (globalThis as any)[SCOPE_KEY] = scope;
  return scope;
}

afterEach(() => {
  delete (globalThis as any)[SCOPE_KEY];
});

describe("subagent-session scope contract", () => {
  it("reports depth 0 when no scope has been installed", () => {
    expect(subagentSessionDepth()).toBe(0);
  });

  it("reports depth 0 outside the scope even after a subagent load ran", async () => {
    const scope = installScope();
    await scope.run({ depth: 1 }, async () => {
      expect(subagentSessionDepth()).toBe(1);
    });
    expect(subagentSessionDepth()).toBe(0);
  });

  it("propagates across the awaits of an extension load", async () => {
    const scope = installScope();
    const observed = await scope.run({ depth: 1 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return subagentSessionDepth();
    });
    expect(observed).toBe(1);
  });

  it("keeps concurrent subagent loads from clobbering each other's scope", async () => {
    const scope = installScope();
    const [first, second] = await Promise.all([
      scope.run({ depth: 1 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return subagentSessionDepth();
      }),
      scope.run({ depth: 1 }, async () => subagentSessionDepth()),
    ]);
    expect([first, second]).toEqual([1, 1]);
    expect(subagentSessionDepth()).toBe(0);
  });

  it("nests depth for a subagent that loads another subagent", async () => {
    const scope = installScope();
    const inner = await scope.run({ depth: 1 }, () =>
      scope.run({ depth: subagentSessionDepth() + 1 }, () => subagentSessionDepth()),
    );
    expect(inner).toBe(2);
  });
});
