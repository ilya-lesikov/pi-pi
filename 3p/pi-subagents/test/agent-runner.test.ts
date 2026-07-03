import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
  },
  SessionManager: { inMemory: vi.fn(() => ({ kind: "memory-session-manager" })) },
  SettingsManager: { create: vi.fn(() => ({ kind: "settings-manager" })) },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryTools: vi.fn(() => []),
  getReadOnlyMemoryTools: vi.fn(() => []),
  getToolsForType: vi.fn(() => [{ name: "read" }]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });

  it("marks the process as subagent session during startup and restores it after completion", async () => {
    const key = Symbol.for("pi-pi:subagent-session");
    delete (globalThis as any)[key];

    let observedDuringPrompt: unknown;
    const { session } = createSession("LOCKED");
    session.prompt = vi.fn(async () => {
      observedDuringPrompt = (globalThis as any)[key];
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "LOCKED" }],
      });
    });
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(observedDuringPrompt).toMatchObject({ depth: 1 });
    expect((globalThis as any)[key]).toBeUndefined();
  });
});

describe("agent-runner lineage (concurrency-safe parent/depth)", () => {
  const tracerKey = Symbol.for("pi-pi:tracer");

  function installTracer() {
    const opened: Array<{ subagentId?: string; parentSubagentId?: string; depth: number }> = [];
    (globalThis as any)[tracerKey] = {
      openSubagent: (meta: any) => opened.push(meta),
      traceSubagent: () => {},
    };
    return opened;
  }

  beforeEach(() => {
    delete (globalThis as any)[Symbol.for("pi-pi:subagent-session")];
    delete (globalThis as any)[tracerKey];
  });

  it("concurrent siblings from the top level are all depth=1 with no parent (not a chain)", async () => {
    const opened = installTracer();
    // Each sibling's session.prompt yields to the event loop, interleaving the
    // three runs — the exact condition that corrupted the old global-marker code.
    createAgentSession.mockImplementation(async () => {
      const { session } = createSession("OK");
      session.prompt = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 0));
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
      });
      return { session };
    });

    await Promise.all([
      runAgent(ctx, "Explore", "a", { pi, subagentId: "opus" }),
      runAgent(ctx, "Explore", "b", { pi, subagentId: "gpt" }),
      runAgent(ctx, "Explore", "c", { pi, subagentId: "gemini" }),
    ]);

    expect(opened).toHaveLength(3);
    for (const meta of opened) {
      expect(meta.depth).toBe(1);
      expect(meta.parentSubagentId).toBeUndefined();
    }
  });

  it("a nested child correctly records its parent and depth=2", async () => {
    const opened = installTracer();
    createAgentSession.mockImplementation(async () => {
      const { session } = createSession("OK");
      return { session };
    });

    // Parent run whose prompt spawns a nested child mid-flight.
    createAgentSession.mockImplementationOnce(async () => {
      const { session } = createSession("PARENT");
      session.prompt = vi.fn(async () => {
        await runAgent(ctx, "Explore", "child", { pi, subagentId: "child" });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "PARENT" }] });
      });
      return { session };
    });

    await runAgent(ctx, "Explore", "parent", { pi, subagentId: "parent" });

    const parent = opened.find((o) => o.subagentId === "parent")!;
    const child = opened.find((o) => o.subagentId === "child")!;
    expect(parent.depth).toBe(1);
    expect(parent.parentSubagentId).toBeUndefined();
    expect(child.depth).toBe(2);
    expect(child.parentSubagentId).toBe("parent");
  });
});
