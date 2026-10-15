/**
 * Local-delta coverage for the pi-pi fork of pi-tasks.
 *
 * Tests ONLY what the fork adds on top of vendored upstream:
 *   - the `clearAll` method exposed on the global store API (Symbol.for("pi-tasks:store")),
 *     added so orchestrator's /pp:done can clear the widget (commit 4ba9183).
 *
 * Upstream task CRUD, persistence, cadence, and widget behavior are covered by the vendored
 * suites and are intentionally NOT retested here. Kept in a separate file so upstream rebases
 * re-apply the vendored tests cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

const STORE_KEY = Symbol.for("pi-tasks:store");

beforeEach(() => {
  process.env.PI_TASKS = "off";
});

afterEach(() => {
  delete process.env.PI_TASKS;
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

