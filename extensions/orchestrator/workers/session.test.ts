import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";

const sdk = vi.hoisted(() => ({
  loaders: [] as any[],
  sessions: [] as any[],
  loadErrors: [] as any[],
  createOptions: [] as any[],
  guards: [] as any[],
  settings: [] as any[],
}));

vi.mock("../bash-guard.js", () => ({
  registerBashGuard: (pi: any, timeoutSec: () => number) => sdk.guards.push({ pi, timeoutSec: timeoutSec() }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(readonly options: any) { sdk.loaders.push(this); }
    async reload() {}
    getExtensions() { return { extensions: [], errors: sdk.loadErrors, runtime: {} }; }
  }
  return {
    DefaultResourceLoader,
    getAgentDir: () => "/agent",
    SessionManager: { inMemory: (cwd: string) => ({ inMemory: cwd }) },
    SettingsManager: {
      create: (cwd: string, agentDir: string, options: any) => {
        const manager = { cwd, agentDir, projectTrusted: options?.projectTrusted };
        sdk.settings.push(manager);
        return manager;
      },
    },
    createAgentSession: async (options: any) => {
      sdk.createOptions.push(options);
      const session = fakeSession(options.tools);
      sdk.sessions.push(session);
      return { session };
    },
  };

  function fakeSession(toolNames: string[]) {
    const listeners = new Set<(event: any) => void>();
    let finish: (() => void) | null = null;
    const session: any = {
      messages: [] as any[],
      agent: { state: { tools: toolNames.map((name) => ({ name, execute: async () => ({ content: [], details: undefined }) })) } },
      name: "",
      aborts: 0,
      steers: [] as string[],
      disposed: false,
      model: undefined as any,
      contextUsage: undefined as any,
      setSessionName(name: string) { session.name = name; },
      async bindExtensions() {},
      subscribe(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit(event: any) { for (const listener of listeners) listener(event); },
      listenerCount: () => listeners.size,
      prompt: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      finishPrompt() { finish?.(); },
      // Mirrors the host: abort ends the in-flight prompt and resolves once idle.
      async abort() { session.aborts++; finish?.(); },
      async steer(text: string) { session.steers.push(text); },
      async setModel(model: any) { session.model = model; },
      getContextUsage: () => session.contextUsage,
      dispose() { session.disposed = true; },
    };
    return session;
  }
});

import { createChildSessionFactory } from "./session.js";

const MODEL = { provider: "p", id: "m" };

function spec(overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec {
  return { type: "explore", description: "look around", prompt: "find it", model: "p/m", thinking: "high", notify: "wake", ...overrides };
}

function hooks() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const h = {
    onPhase: vi.fn(record("phase")),
    onStep: vi.fn(record("step")),
    onOutput: vi.fn(record("output")),
    onEvent: vi.fn(record("event")),
    onToolStart: vi.fn(record("toolStart")),
    onToolEnd: vi.fn(record("toolEnd")),
    onTurnEnd: vi.fn(record("turnEnd")),
    onUsage: vi.fn(record("usage")),
    onText: vi.fn(record("text")),
    submitResult: vi.fn(record("submit")),
    reportProgress: vi.fn(record("progress")),
    askParent: vi.fn(async (_text: string, _signal?: AbortSignal): Promise<string | undefined> => "use the cache"),
  } satisfies WorkerSessionHooks;
  return { h, calls };
}

function factoryEnv(overrides: { registry?: any; bashTimeoutSec?: number; projectTrusted?: boolean } = {}, childExtension = vi.fn()) {
  return {
    cwd: "/repo",
    modelRegistry: () => overrides.registry ?? { runtime: { rt: true }, find: (provider: string, id: string) => provider === "p" && id === "m" ? MODEL : undefined },
    systemPrompt: (s: WorkerSpawnSpec) => `prompt for ${s.type}`,
    toolNames: () => ["read", "bash"],
    childExtension,
    bashTimeoutSec: () => overrides.bashTimeoutSec ?? 0,
    projectTrusted: () => overrides.projectTrusted ?? true,
  };
}

function factory(overrides: { registry?: any; bashTimeoutSec?: number; projectTrusted?: boolean } = {}) {
  const childExtension = vi.fn();
  const create = createChildSessionFactory(factoryEnv(overrides, childExtension));
  return { create, childExtension };
}

/** Runs the worker-channel extension factory against a fake pi and returns what it registered. */
function channel(loader: any) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any) => Promise<void>>();
  const entry = loader.options.extensionFactories.find((f: any) => f.name === "pi-pi-worker-channel");
  entry.factory({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: any) => handlers.set(name, handler) });
  return { tools, handlers };
}

const update = (assistantMessageEvent: any) => ({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent });

beforeEach(() => {
  sdk.loaders.length = 0;
  sdk.sessions.length = 0;
  sdk.createOptions.length = 0;
  sdk.guards.length = 0;
  sdk.settings.length = 0;
  sdk.loadErrors = [];
});

describe("createChildSessionFactory", () => {
  it("builds an isolated session on the resolved model with pi-pi's tools and reports each start phase", async () => {
    const { create, childExtension } = factory();
    const { h, calls } = hooks();
    await create(spec(), h);
    const loader = sdk.loaders[0];
    expect(loader.options).toMatchObject({ cwd: "/repo", agentDir: "/agent", noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    expect(loader.options.systemPromptOverride()).toBe("prompt for explore");
    expect(loader.options.appendSystemPromptOverride()).toEqual([]);
    const worker = loader.options.extensionFactories.find((f: any) => f.name === "pi-pi-worker");
    worker.factory("pi");
    expect(childExtension).toHaveBeenCalledWith("pi");
    const options = sdk.createOptions[0];
    expect(options.model).toBe(MODEL);
    expect(options.modelRuntime).toEqual({ rt: true });
    expect(options.thinkingLevel).toBe("high");
    expect(options.tools).toEqual(["read", "bash", "submit_result", "report_progress", "ask_parent"]);
    expect(sdk.sessions[0].name).toBe("explore: look around");
    expect(calls.filter(([name]) => name === "phase").map(([, phase]) => phase)).toEqual(["loading worker tools", "creating the agent session", "binding extensions"]);
  });

  it("hands one settings manager, trusting the project only as the root session does, to the loader and the session", async () => {
    for (const trusted of [false, true]) {
      sdk.loaders.length = 0;
      sdk.createOptions.length = 0;
      sdk.guards.length = 0;
      sdk.settings.length = 0;
      const { create } = factory({ projectTrusted: trusted });
      await create(spec(), hooks().h);
      expect(sdk.settings).toEqual([{ cwd: "/repo", agentDir: "/agent", projectTrusted: trusted }]);
      const [manager] = sdk.settings;
      expect(sdk.loaders[0].options.settingsManager).toBe(manager);
      expect(sdk.createOptions[0].settingsManager).toBe(manager);
    }
  });

  it("falls back to the registry's available list when it has no direct lookup", async () => {
    const { create } = factory({ registry: { getAvailable: () => [{ provider: "q", id: "x" }, MODEL] } });
    await create(spec(), hooks().h);
    expect(sdk.createOptions[0].model).toBe(MODEL);
  });

  it("refuses a model the registry does not serve, or a spec without a provider", async () => {
    const { create } = factory();
    await expect(create(spec({ model: "p/other" }), hooks().h)).rejects.toThrow("model p/other is not available");
    await expect(create(spec({ model: "m" }), hooks().h)).rejects.toThrow("model m is not available");
    expect(sdk.loaders).toHaveLength(0);
  });

  it("fails the start when the worker tools fail to load", async () => {
    sdk.loadErrors = [{ path: "a", error: "boom" }, { path: "b", error: "bang" }];
    const { create } = factory();
    await expect(create(spec(), hooks().h)).rejects.toThrow("worker tools failed to load: boom; bang");
    expect(sdk.sessions).toHaveLength(0);
  });
});

describe("child session events", () => {
  async function started() {
    const { create } = factory();
    const { h, calls } = hooks();
    const worker = await create(spec(), h);
    const session = sdk.sessions[0];
    calls.length = 0;
    return { worker, session, h, calls };
  }

  it("bumps onEvent for every streamed model event, so the hung-request watchdog sees a live stream", async () => {
    const { session, h } = await started();
    const partial = { role: "assistant", content: [{ type: "toolCall", name: "grep" }] };
    const stream = [
      { type: "start", partial },
      { type: "thinking_start", contentIndex: 0, partial },
      { type: "thinking_delta", contentIndex: 0, delta: "hm", partial },
      { type: "thinking_end", contentIndex: 0, content: "hm", partial },
      { type: "text_start", contentIndex: 0, partial },
      { type: "text_delta", contentIndex: 0, delta: "x", partial },
      { type: "text_end", contentIndex: 0, content: "x", partial },
      { type: "toolcall_start", contentIndex: 0, partial },
      { type: "toolcall_delta", contentIndex: 0, delta: "{", partial },
      { type: "toolcall_end", contentIndex: 0, toolCall: {}, partial },
    ];
    for (const event of stream) session.emit(update(event));
    expect(h.onEvent).toHaveBeenCalledTimes(stream.length);
    session.emit({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: {} });
    session.emit({ type: "agent_start" });
    expect(h.onEvent).toHaveBeenCalledTimes(stream.length + 2);
  });

  it("reports thinking and reply as readable output, a tool call being written as output without text", async () => {
    const { session, calls } = await started();
    const partial = { role: "assistant", content: [{ type: "text" }, { type: "toolCall", name: "grep" }] };
    session.emit({ type: "turn_start" });
    session.emit({ type: "message_start", message: partial });
    session.emit(update({ type: "thinking_start", contentIndex: 0, partial }));
    session.emit(update({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial }));
    session.emit(update({ type: "text_start", contentIndex: 0, partial }));
    session.emit(update({ type: "text_delta", contentIndex: 0, delta: "Hello ", partial }));
    session.emit(update({ type: "text_delta", contentIndex: 0, delta: "world", partial }));
    session.emit(update({ type: "toolcall_start", contentIndex: 1, partial }));
    session.emit(update({ type: "toolcall_delta", contentIndex: 1, delta: "{\"p", partial }));
    expect(calls.filter(([name]) => name !== "event")).toEqual([
      ["step", "waiting for the model"],
      ["step", "thinking"],
      ["output", "plan"],
      ["step", "writing its reply"],
      ["output", "Hello "],
      ["text", "Hello "],
      ["output", "Hello world"],
      ["text", "Hello world"],
      ["step", "writing a grep call"],
      ["output"],
    ]);
  });

  it("restarts the reply text with each assistant message and caps the output tail", async () => {
    const { session, h } = await started();
    const partial = { role: "assistant", content: [] };
    session.emit({ type: "message_start", message: partial });
    session.emit(update({ type: "text_delta", contentIndex: 0, delta: "first", partial }));
    session.emit({ type: "message_start", message: partial });
    session.emit(update({ type: "text_delta", contentIndex: 0, delta: "y".repeat(400), partial }));
    expect(h.onText).toHaveBeenLastCalledWith("y".repeat(400));
    expect((h.onOutput.mock.calls.at(-1)![0] as string).length).toBe(300);
    session.emit(update({ type: "toolcall_start", contentIndex: 5, partial }));
    expect(h.onStep).toHaveBeenLastCalledWith("writing a tool call");
  });

  it("pairs every tool start with an end, including tools running in parallel", async () => {
    const { session, calls } = await started();
    session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm   test\n --run" } });
    session.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "src/x.ts" } });
    session.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: {}, isError: false });
    session.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: {}, isError: true });
    expect(calls.filter(([name]) => name.startsWith("tool"))).toEqual([
      ["toolStart", "bash", "npm test --run"],
      ["toolStart", "read", "src/x.ts"],
      ["toolEnd"],
      ["toolEnd"],
    ]);
  });

  it("summarizes tool arguments to one short line", async () => {
    const { session, h } = await started();
    const start = (toolName: string, args: unknown) => session.emit({ type: "tool_execution_start", toolCallId: "t", toolName, args });
    start("web_fetch", { urls: ["https://a", "https://b"] });
    start("lsp", { operation: "hover", line: 3 });
    start("x", { other: 1 });
    start("y", undefined);
    start("z", { query: { nested: true } });
    start("bash", { command: "a".repeat(100) });
    const summaries = h.onToolStart.mock.calls.map(([, summary]) => summary as string);
    expect(summaries.slice(0, 5)).toEqual(["https://a", "hover", "", "", "{\"nested\":true}"]);
    expect(summaries[5]).toHaveLength(78);
    expect(summaries[5]!.endsWith("…")).toBe(true);
  });

  it("reports usage of assistant messages only, retries, compaction and turn ends", async () => {
    const { session, calls } = await started();
    session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } } } });
    session.emit({ type: "message_end", message: { role: "assistant", usage: {} } });
    session.emit({ type: "message_end", message: { role: "user", content: "x" } });
    session.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded\n  try later" });
    session.emit({ type: "compaction_start", reason: "threshold" });
    session.emit({ type: "turn_end", message: {}, toolResults: [] });
    expect(calls.filter(([name]) => name !== "event")).toEqual([
      ["usage", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5 }],
      ["usage", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }],
      ["step", "retrying after a provider error (attempt 2/3): overloaded try later"],
      ["step", "compacting its context"],
      ["turnEnd"],
    ]);
  });
});

describe("child session control", () => {
  async function started(registry?: any) {
    const { create } = factory({ registry });
    const { h } = hooks();
    const worker = await create(spec(), h);
    return { worker, session: sdk.sessions[0], h };
  }

  it("runs the prompt without template expansion, and abort() ends a pending run", async () => {
    const { worker, session } = await started();
    let done = false;
    const run = worker.run("do it").then(() => { done = true; });
    expect(session.prompt).toHaveBeenCalledWith("do it", { expandPromptTemplates: false });
    await Promise.resolve();
    expect(done).toBe(false);
    worker.abort();
    await run;
    expect(done).toBe(true);
    expect(session.aborts).toBe(1);
  });

  it("swallows a rejected abort or steer", async () => {
    const { worker, session } = await started();
    session.abort = () => Promise.reject(new Error("gone"));
    session.steer = () => Promise.reject(new Error("gone"));
    worker.abort();
    worker.steer("hi");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("reads the terminal assistant message of the current run only", async () => {
    const { worker, session } = await started();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "old failure", content: [{ type: "text", text: "old" }] });
    const run = worker.run("again");
    expect(worker.lastError()).toBeUndefined();
    expect(worker.lastAssistantText()).toBe("");
    session.messages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "a" }, { type: "toolCall", name: "x" }, { type: "text", text: "b" }] });
    session.messages.push({ role: "toolResult", content: [] });
    expect(worker.lastAssistantText()).toBe("a\nb");
    expect(worker.lastError()).toBeUndefined();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "429 rate limited", content: [] });
    expect(worker.lastError()).toBe("429 rate limited");
    session.messages.push({ role: "assistant", stopReason: "error", content: [] });
    expect(worker.lastError()).toBe("The model provider returned an unspecified error.");
    session.finishPrompt();
    await run;
    expect(worker.transcript()).toBe(session.messages);
  });

  it("switches model only to one the registry serves", async () => {
    const { worker, session } = await started();
    expect(await worker.setModel("p/nope")).toBe(false);
    expect(session.model).toBeUndefined();
    expect(await worker.setModel("p/m")).toBe(true);
    expect(session.model).toBe(MODEL);
  });

  it("reports context usage only when the host knows a percentage", async () => {
    const { worker, session } = await started();
    expect(worker.contextPercent()).toBeUndefined();
    session.contextUsage = { percent: null };
    expect(worker.contextPercent()).toBeUndefined();
    session.contextUsage = { percent: 42 };
    expect(worker.contextPercent()).toBe(42);
  });

  it("stops forwarding events once disposed", async () => {
    const { worker, session, h } = await started();
    worker.dispose();
    expect(session.disposed).toBe(true);
    session.emit({ type: "turn_start" });
    expect(h.onEvent).not.toHaveBeenCalled();
  });
});

describe("tool interrupt", () => {
  it("interrupts a tool that ignores its signal without ending the worker, and rewraps a replaced tool list", async () => {
    const { create } = factory();
    const worker = await create(spec(), hooks().h);
    const state = sdk.sessions[0].agent.state;
    expect(worker.interruptTool()).toBe(false);
    let seen: AbortSignal | undefined;
    state.tools = [{ name: "hang", execute: (_id: string, _p: unknown, signal: AbortSignal) => { seen = signal; return new Promise(() => {}); } }];
    const tool = state.tools[0];
    expect(tool.__piPiInterruptible).toBe(true);
    state.tools = [tool];
    expect(state.tools[0]).toBe(tool);
    const pending = tool.execute("t", {}, undefined, undefined);
    expect(worker.interruptTool()).toBe(true);
    await expect(pending).rejects.toThrow("Interrupted by the parent agent");
    expect(seen!.aborted).toBe(true);
    expect(worker.interruptTool()).toBe(false);
  });

  it("forwards the session's abort to the running tool and passes its result through", async () => {
    const { create } = factory();
    await create(spec(), hooks().h);
    const state = sdk.sessions[0].agent.state;
    let seen: AbortSignal | undefined;
    state.tools = [{ name: "ok", execute: async (_id: string, params: any, signal: AbortSignal) => { seen = signal; return { value: params.n * 2 }; } }];
    const outer = new AbortController();
    await expect(state.tools[0].execute("t", { n: 2 }, outer.signal, undefined)).resolves.toEqual({ value: 4 });
    expect(seen!.aborted).toBe(false);
    let inner: AbortSignal | undefined;
    state.tools = [{ name: "slow", execute: (_id: string, _p: unknown, signal: AbortSignal) => new Promise((resolve) => { inner = signal; signal.addEventListener("abort", () => resolve("stopped")); }) }];
    const run = state.tools[0].execute("t", {}, outer.signal, undefined);
    outer.abort();
    await expect(run).resolves.toBe("stopped");
    expect(inner!.aborted).toBe(true);
  });
});

describe("worker channel tools", () => {
  async function tools(overrides: Partial<WorkerSpawnSpec> = {}) {
    const { create } = factory();
    const { h } = hooks();
    await create(spec(overrides), h);
    return { ...channel(sdk.loaders[0]), h };
  }

  it("submits a structured result and ends the worker's turn", async () => {
    const { tools: registered, h } = await tools();
    const submit = registered.get("submit_result");
    expect(submit.parameters.properties.findings).toBeUndefined();
    const result = await submit.execute("t", { status: "done", summary: "found it", body: "at a.ts:1", open_questions: [] });
    expect(result.terminate).toBe(true);
    expect(h.submitResult).toHaveBeenCalledWith({ status: "done", summary: "found it", body: "at a.ts:1" });
  });

  it("requires findings from a reviewer and passes them and open questions through", async () => {
    const { tools: registered, h } = await tools({ resultSchema: "findings" });
    const submit = registered.get("submit_result");
    expect(submit.parameters.properties.findings).toBeDefined();
    const findings = [{ severity: "major", location: "a.ts:3", issue: "leak" }];
    await submit.execute("t", { status: "partial", summary: "s", body: "b", findings, open_questions: ["why?"] });
    expect(h.submitResult).toHaveBeenCalledWith({ status: "partial", summary: "s", body: "b", findings, openQuestions: ["why?"] });
  });

  it("caps a progress note and relays a question's answer or its absence", async () => {
    const { tools: registered, h } = await tools();
    await registered.get("report_progress").execute("t", { text: "z".repeat(500) });
    expect(h.reportProgress).toHaveBeenCalledWith("z".repeat(300));
    const signal = new AbortController().signal;
    const answered = await registered.get("ask_parent").execute("t", { question: "which db?" }, signal);
    expect(h.askParent).toHaveBeenCalledWith("which db?", signal);
    expect(answered.content[0].text).toBe("Answer from your parent: use the cache");
    h.askParent.mockResolvedValueOnce(undefined);
    const unanswered = await registered.get("ask_parent").execute("t", { question: "q" });
    expect(unanswered.content[0].text).toMatch(/^No answer came/);
  });

  it("gives a worker with bash the default timeout, and none to a worker without bash", async () => {
    const { create } = factory({ bashTimeoutSec: 120 });
    const { h } = hooks();
    await create(spec(), h);
    const entry = sdk.loaders[0].options.extensionFactories.find((f: any) => f.name === "pi-pi-worker-bash");
    expect(entry).toBeDefined();
    entry.factory("child-pi");
    expect(sdk.guards).toEqual([{ pi: "child-pi", timeoutSec: 120 }]);
    const readOnly = createChildSessionFactory({ ...factoryEnv(), toolNames: () => ["read"] });
    await readOnly(spec(), h);
    expect(sdk.loaders[1].options.extensionFactories.map((f: any) => f.name)).not.toContain("pi-pi-worker-bash");
  });
});
