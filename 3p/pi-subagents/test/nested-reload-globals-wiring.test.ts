/**
 * nested-reload-globals-wiring.test.ts — a background agent spawned in the root
 * session must stay visible to `/pp > Subagents` after a nested in-process
 * subagent session re-runs the extension factory.
 *
 * Bug: the resource loader disables module caching, so every nested subagent
 * session's reload() re-executes this extension's default export. That factory
 * unconditionally did `new AgentManager()` and overwrote
 * globalThis[Symbol.for("pi-subagents:manager")] / [...:menu] with a fresh,
 * EMPTY manager. The `/pp > Subagents` menu reads those globals, so after any
 * nested spawn it bound to the empty manager and reported "No agents." while the
 * real agents lived in the original (root) manager.
 *
 * Fix: only the first/owning invocation publishes (and on shutdown deletes) the
 * shared globals; a nested re-run leaves them pointing at the root manager.
 *
 * This exercises the wiring end-to-end: real factory, real Agent tool, real
 * global registry — the exact path the reporter hit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const MENU_KEY = Symbol.for("pi-subagents:menu");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), select: vi.fn(async () => undefined) },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function spawnBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "ROOT-SESSION-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Explore the repo", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}

describe("nested in-process reload does not clobber the shared subagent globals", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-nested-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-nested-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[MENU_KEY];
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[MENU_KEY];
    vi.restoreAllMocks();
  });

  it("keeps a root-spawned background agent visible via the global manager after a nested factory re-run", async () => {
    const root = makePi();
    subagentsExtension(root.pi);
    const rootManager = (globalThis as any)[MANAGER_KEY];
    const rootMenu = (globalThis as any)[MENU_KEY];

    const id = await spawnBackgroundAgent(root.tools);
    expect(rootManager.getRecord(id), "root manager tracks the spawned agent").toBeTruthy();

    // A nested in-process subagent session re-runs the factory (no module cache).
    const nested = makePi();
    subagentsExtension(nested.pi);

    // The globals must still be the ROOT session's — not clobbered by the re-run.
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootManager);
    expect((globalThis as any)[MENU_KEY]).toBe(rootMenu);
    expect(
      (globalThis as any)[MANAGER_KEY].getRecord(id),
      "the global manager still sees the root-spawned agent after the nested reload",
    ).toBeTruthy();

    await root.lifecycle.get("session_shutdown")?.({}, ctx());
    await nested.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("a nested session shutdown does not retract the root session's globals", async () => {
    const root = makePi();
    subagentsExtension(root.pi);
    const rootManager = (globalThis as any)[MANAGER_KEY];
    const id = await spawnBackgroundAgent(root.tools);

    const nested = makePi();
    subagentsExtension(nested.pi);

    // Nested session ends first — the root is still live and its globals must stay.
    await nested.lifecycle.get("session_shutdown")?.({}, ctx());

    expect((globalThis as any)[MANAGER_KEY]).toBe(rootManager);
    expect(
      (globalThis as any)[MANAGER_KEY].getRecord(id),
      "root agent still reachable after nested shutdown",
    ).toBeTruthy();

    await root.lifecycle.get("session_shutdown")?.({}, ctx());
    // Now the owning session is gone — globals retracted.
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
    expect((globalThis as any)[MENU_KEY]).toBeUndefined();
  });
});
