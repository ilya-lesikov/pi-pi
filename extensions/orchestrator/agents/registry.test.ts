import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../model-registry.js", () => ({
  resolveModel: (m: string) => ({ resolved: m }),
}));

import {
  registerAgentDefinitions,
  unregisterAgentDefinitions,
  setExtensionOnlyMode,
  spawnViaRpc,
  isSubagentsReady,
} from "./registry.js";

type Handler = (data?: any) => void;

function makePi() {
  const eventHandlers = new Map<string, Handler[]>();
  const emitted: Array<{ name: string; data: any }> = [];
  return {
    emitted,
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      }),
      emit: vi.fn((name: string, data?: any) => {
        emitted.push({ name, data });
        for (const h of eventHandlers.get(name) ?? []) h(data);
      }),
    },
  };
}

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function fm(overrides: Partial<any> = {}) {
  return {
    description: "d",
    tools: "read, grep",
    model: "m",
    thinking: "low",
    max_turns: 5,
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as any)[MANAGER_KEY];
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("registerAgentDefinitions", () => {
  it("keys the map by type_variant when a variant is present, else just type", () => {
    const pi = makePi();
    registerAgentDefinitions(pi as any, [
      { type: "planner", variant: "x", frontmatter: fm(), prompt: "p1" },
      { type: "planner", variant: null, frontmatter: fm(), prompt: "p2" },
    ]);

    const payload = pi.emitted.find((e) => e.name === "subagents:register-agents")!.data;
    expect(payload.agents).toBeInstanceOf(Map);
    expect([...payload.agents.keys()]).toEqual(["planner_x", "planner"]);
  });

  it("maps tools 'none' to an empty builtinToolNames array", () => {
    const pi = makePi();
    registerAgentDefinitions(pi as any, [
      { type: "a", variant: null, frontmatter: fm({ tools: "none" }), prompt: "p" },
    ]);
    const payload = pi.emitted[0].data;
    expect(payload.agents.get("a").builtinToolNames).toEqual([]);
  });

  it("splits, trims and filters empty tool names", () => {
    const pi = makePi();
    registerAgentDefinitions(pi as any, [
      { type: "a", variant: null, frontmatter: fm({ tools: "read, grep, bash, " }), prompt: "p" },
    ]);
    expect(pi.emitted[0].data.agents.get("a").builtinToolNames).toEqual(["read", "grep", "bash"]);
  });

  it("emits a full entry with resolved model and defaulted promptMode", () => {
    const pi = makePi();
    registerAgentDefinitions(pi as any, [
      { type: "planner", variant: null, frontmatter: fm(), prompt: "SYS" },
    ]);
    const entry = pi.emitted[0].data.agents.get("planner");
    expect(entry).toMatchObject({
      name: "planner",
      description: "d",
      builtinToolNames: ["read", "grep"],
      model: { resolved: "m" },
      thinking: "low",
      maxTurns: 5,
      systemPrompt: "SYS",
      promptMode: "replace",
      enabled: true,
      source: "project",
      runInBackground: true,
    });
  });

  it("honors an explicit prompt_mode", () => {
    const pi = makePi();
    registerAgentDefinitions(pi as any, [
      { type: "a", variant: null, frontmatter: fm({ prompt_mode: "append" }), prompt: "p" },
    ]);
    expect(pi.emitted[0].data.agents.get("a").promptMode).toBe("append");
  });
});

describe("unregisterAgentDefinitions", () => {
  it("emits unregister-agents with all:true", () => {
    const pi = makePi();
    unregisterAgentDefinitions(pi as any);
    expect(pi.emitted).toEqual([{ name: "subagents:unregister-agents", data: { all: true } }]);
  });
});

describe("setExtensionOnlyMode", () => {
  it("emits set-extension-only with enabled:true", () => {
    const pi = makePi();
    setExtensionOnlyMode(pi as any);
    expect(pi.emitted).toEqual([{ name: "subagents:set-extension-only", data: { enabled: true } }]);
  });
});

describe("spawnViaRpc", () => {
  function fireReply(pi: ReturnType<typeof makePi>, reply: any) {
    const spawn = pi.emitted.find((e) => e.name === "subagents:rpc:spawn")!.data;
    pi.events.emit(`subagents:rpc:spawn:reply:${spawn.requestId}`, reply);
    return spawn;
  }

  it("resolves with the id from reply data", async () => {
    const pi = makePi();
    const p = spawnViaRpc(pi as any, "planner", "prompt", { description: "d" });
    fireReply(pi, { success: true, data: { id: "agent-9" } });
    await expect(p).resolves.toEqual({ id: "agent-9" });
  });

  it("resolves with the requestId when reply has no data", async () => {
    const pi = makePi();
    const p = spawnViaRpc(pi as any, "planner", "prompt", { description: "d" });
    const spawn = fireReply(pi, { success: true });
    await expect(p).resolves.toEqual({ id: spawn.requestId });
  });

  it("rejects with the reply error", async () => {
    const pi = makePi();
    const p = spawnViaRpc(pi as any, "planner", "prompt", { description: "d" });
    fireReply(pi, { success: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
  });

  it("rejects with a spawn timeout when no reply arrives", async () => {
    vi.useFakeTimers();
    const pi = makePi();
    const p = spawnViaRpc(pi as any, "planner", "prompt", { description: "d", spawnTimeout: 100 });
    const assertion = expect(p).rejects.toThrow("spawn timeout for planner");
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it("refreshes the global manager widget on success", async () => {
    const refreshWidget = vi.fn();
    (globalThis as any)[MANAGER_KEY] = { refreshWidget };
    const pi = makePi();
    const p = spawnViaRpc(pi as any, "planner", "prompt", { description: "d" });
    fireReply(pi, { success: true, data: { id: "x" } });
    await p;
    expect(refreshWidget).toHaveBeenCalledTimes(1);
  });

  it("forwards options with run_in_background:true", async () => {
    const pi = makePi();
    const validateCompletion = () => undefined;
    const p = spawnViaRpc(pi as any, "planner", "prompt", {
      description: "desc",
      maxTurns: 7,
      validateCompletion,
      maxValidationRetries: 2,
    });
    const spawn = fireReply(pi, { success: true, data: { id: "x" } });
    await p;
    expect(spawn.type).toBe("planner");
    expect(spawn.prompt).toBe("prompt");
    expect(spawn.options).toMatchObject({
      description: "desc",
      run_in_background: true,
      maxTurns: 7,
      validateCompletion,
      maxValidationRetries: 2,
    });
  });
});

describe("isSubagentsReady", () => {
  function fireReply(pi: ReturnType<typeof makePi>, reply: any) {
    const ping = pi.emitted.find((e) => e.name === "subagents:rpc:ping")!.data;
    pi.events.emit(`subagents:rpc:ping:reply:${ping.requestId}`, reply);
  }

  it("resolves true on a successful reply", async () => {
    const pi = makePi();
    const p = isSubagentsReady(pi as any);
    fireReply(pi, { success: true });
    await expect(p).resolves.toBe(true);
  });

  it("resolves false on an unsuccessful reply", async () => {
    const pi = makePi();
    const p = isSubagentsReady(pi as any);
    fireReply(pi, { success: false });
    await expect(p).resolves.toBe(false);
  });

  it("resolves false on timeout", async () => {
    vi.useFakeTimers();
    const pi = makePi();
    const p = isSubagentsReady(pi as any, 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe(false);
  });
});
