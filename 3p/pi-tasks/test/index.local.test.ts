/**
 * Local-delta coverage for the pi-pi fork of pi-tasks.
 *
 * Tests ONLY what the fork adds on top of vendored upstream:
 *   - the `clearAll` method exposed on the global store API (Symbol.for("pi-tasks:store")),
 *     added so orchestrator's /pp:done can clear the widget (commit 4ba9183);
 *   - the subagent-session hook skip: when globalThis[Symbol.for("pi-pi:subagent-session")] is set,
 *     lifecycle hooks (turn_start, turn_end, tool_result, before_agent_start, session_switch,
 *     tool_execution_start) become no-ops so child subagent sessions don't mutate parent task
 *     state (commit 50530c0).
 *
 * Upstream task CRUD, persistence, cadence, and widget behavior are covered by the vendored
 * suites and are intentionally NOT retested here. Kept in a separate file so upstream rebases
 * re-apply the vendored tests cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

const STORE_KEY = Symbol.for("pi-tasks:store");
const SUBAGENT_SESSION_KEY = Symbol.for("pi-pi:subagent-session");

beforeEach(() => {
  process.env.PI_TASKS = "off";
});

afterEach(() => {
  delete process.env.PI_TASKS;
  delete (globalThis as any)[SUBAGENT_SESSION_KEY];
  delete (globalThis as any)[STORE_KEY];
});

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {};
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) await h(...args);
    },
  };
}

function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

function storeApi() {
  return (globalThis as any)[STORE_KEY];
}

describe("global store API (local fork)", () => {
  it("exposes clearAll on the global store API", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    expect(typeof storeApi().clearAll).toBe("function");
  });

  it("clearAll removes every task from the store", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const api = storeApi();

    api.create("first", "do the first thing");
    api.create("second", "do the second thing");
    expect(api.list().length).toBe(2);

    api.clearAll();
    expect(api.list()).toEqual([]);
  });

  it("clearAll is idempotent on an already-empty store", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const api = storeApi();
    expect(() => {
      api.clearAll();
      api.clearAll();
    }).not.toThrow();
    expect(api.list()).toEqual([]);
  });
});

describe("subagent-session hook skip (local fork)", () => {
  it("before_agent_start is a no-op when the subagent-session flag is set", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    (globalThis as any)[SUBAGENT_SESSION_KEY] = true;
    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    // In a real (non-subagent) session before_agent_start grabs the UI context and updates the
    // widget; under the subagent flag it must return early before touching the UI.
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("turn_start is a no-op when the subagent-session flag is set", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    (globalThis as any)[SUBAGENT_SESSION_KEY] = true;
    const ctx = mockCtx();
    await mock.fireLifecycle("turn_start", {}, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("session_switch does not clear parent tasks when the subagent-session flag is set", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const api = storeApi();

    api.create("parent task", "belongs to the parent session");
    expect(api.list().length).toBe(1);

    (globalThis as any)[SUBAGENT_SESSION_KEY] = true;
    await mock.fireLifecycle("session_switch", { reason: "new" }, mockCtx());

    // Without the guard, a /new session_switch in memory mode would clearAll(); the subagent
    // guard must short-circuit first and preserve the parent's tasks.
    expect(api.list().length).toBe(1);
  });

  it("without the flag, before_agent_start still runs (guard is opt-in)", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    // Give the widget something to render so the non-subagent path produces an observable
    // ui.setWidget call (an empty widget renders nothing).
    storeApi().create("visible task", "so the widget has content");

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    // The non-subagent path grabs the UI context via widget.setUICtx → widget.update → setWidget.
    expect(ctx.ui.setWidget).toHaveBeenCalled();
  });
});
