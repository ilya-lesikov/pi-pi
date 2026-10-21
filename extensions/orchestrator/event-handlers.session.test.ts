import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The global config path is fixed when config.js loads; keep the developer's own out of it.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pp-eh-agent-"));
});

vi.mock("./provision/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provision/session.js")>()),
  provisionEagerTools: vi.fn(async () => []),
  ensureServerForFile: vi.fn(async () => null),
}));
vi.mock("./cbm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cbm.js")>()),
  registerCbmTools: vi.fn(() => false),
}));
// Startup provider registration goes to the network.
vi.mock("./flant-infra.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./flant-infra.js")>()),
  initFlantOnStartup: vi.fn(async () => {}),
  refreshSubProvider: vi.fn(async () => {}),
}));

import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { LspManager } from "./lsp/manager.js";
import { registerEventHandlers } from "./event-handlers.js";
import { createUsageTracker } from "./usage-tracker.js";

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function emit(pi: any, name: string, event: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
}

afterAll(() => {
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pp-eh-session-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function session() {
  const pi = makePi();
  const orchestrator = new Orchestrator(pi);
  orchestrator.cwd = dir;
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  registerEventHandlers(orchestrator);
  const ctx: any = {
    cwd: dir,
    hasUI: false,
    isIdle: () => true,
    ui: { notify: vi.fn(), setFooter: vi.fn() },
    sessionManager: { getSessionId: () => "", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
  };
  return { pi, orchestrator, ctx };
}

describe("session lifecycle", () => {
  it("keeps bash as the user left it across a reload, which loads pi-pi afresh", async () => {
    // Before the reload: one instance, bash turned off by the user.
    const before = session();
    before.pi.getActiveTools = () => ["read"];
    await emit(before.pi, "session_shutdown", { reason: "reload" }, before.ctx);
    // After it: a new instance, and pi has turned every extension tool on again.
    const after = session();
    let active = ["read", "bash"];
    after.pi.getActiveTools = () => active;
    after.pi.setActiveTools = (next: string[]) => { active = next; };
    await emit(after.pi, "session_start", { reason: "reload" }, after.ctx);
    expect(active).toEqual(["read"]);
    // A later start is not a reload: pi's own start-up rules apply, and they keep bash.
    active = ["read", "bash"];
    await emit(after.pi, "session_start", { reason: "new" }, after.ctx);
    expect(active).toEqual(["read", "bash"]);
    await emit(after.pi, "session_shutdown", { reason: "quit" }, after.ctx);
  });


  it("hides pi's own working row in the terminal, where the footer says what the agent does", async () => {
    const { pi, ctx } = session();
    ctx.ui.setWorkingVisible = vi.fn();
    await emit(pi, "session_start", {}, ctx);
    expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
    const rpc = session();
    rpc.ctx.mode = "rpc";
    rpc.ctx.ui.setWorkingVisible = vi.fn();
    await emit(rpc.pi, "session_start", {}, rpc.ctx);
    expect(rpc.ctx.ui.setWorkingVisible).not.toHaveBeenCalled();
    await emit(pi, "session_shutdown", {}, ctx);
    await emit(rpc.pi, "session_shutdown", {}, rpc.ctx);
  });

  it("replaces the previous session's language servers on start and drops them on shutdown", async () => {
    const { pi, orchestrator, ctx } = session();
    const previous = { shutdown: vi.fn(async () => {}) };
    orchestrator.lsp = previous as any;
    await emit(pi, "session_start", {}, ctx);
    expect(previous.shutdown).toHaveBeenCalledTimes(1);
    const current = orchestrator.lsp as LspManager | null;
    expect(current).toBeInstanceOf(LspManager);
    expect(current!.cwd).toBe(dir);
    expect(ctx.ui.setFooter).toHaveBeenCalled();
    expect(orchestrator.workers).not.toBeNull();
    const shutdown = vi.spyOn(current!, "shutdown");
    await emit(pi, "session_shutdown", {}, ctx);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(orchestrator.lsp).toBeNull();
    expect(orchestrator.workers).toBeNull();
    expect(orchestrator.tokenRefreshTimer).toBeNull();
  });

  it("falls back to defaults and stops starting the session on a broken config", async () => {
    const { pi, orchestrator, ctx } = session();
    mkdirSync(join(dir, ".pp"), { recursive: true });
    writeFileSync(join(dir, ".pp", "config.json"), JSON.stringify({ general: { logLevel: "loud" } }));
    const previous = { shutdown: vi.fn(async () => {}) };
    orchestrator.lsp = previous as any;
    await emit(pi, "session_start", {}, ctx);
    expect(orchestrator.configError).toContain("config.general.logLevel");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Config error"), "error");
    expect(orchestrator.config.general.logLevel).toBe("info");
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("refuses to operate beside a standalone copy of a bundled extension", async () => {
    const { pi, orchestrator, ctx } = session();
    pi.getAllTools.mockReturnValue([{ name: "lsp", sourceInfo: { path: "/elsewhere/pi-lsp/index.ts" } }]);
    await emit(pi, "session_start", {}, ctx);
    expect(orchestrator.duplicateExtensionError).toBe(true);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    await emit(pi, "session_shutdown", {}, ctx);
  });

  it("still tears the session down when persisting usage fails", async () => {
    const { pi, orchestrator, ctx } = session();
    (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] = { toSummary: () => { throw new Error("disk full"); } };
    orchestrator.lsp = { shutdown: vi.fn(async () => {}) } as any;
    orchestrator.mainTurnTimer = setInterval(() => {}, 60_000);
    await emit(pi, "session_shutdown", {}, { ...ctx, sessionManager: { getSessionId: () => "s1" } });
    expect(orchestrator.lsp).toBeNull();
    expect(orchestrator.mainTurnTimer).toBeNull();
    expect((globalThis as any)[Symbol.for("pi-pi:usage-tracker")]).toBeUndefined();
  });

  it("records a turn's usage on the session tracker", async () => {
    const { pi, ctx } = session();
    const usage = createUsageTracker();
    (globalThis as any)[Symbol.for("pi-pi:usage-tracker")] = usage;
    try {
      await emit(pi, "turn_end", { message: { stopReason: "aborted", content: [], model: "m", provider: "p", usage: { input: 7, output: 3, cost: { total: 0.5 } } } }, ctx);
      expect(usage.getMainInputTokens()).toBe(7);
      expect(usage.getMainOutputTokens()).toBe(3);
    } finally {
      delete (globalThis as any)[Symbol.for("pi-pi:usage-tracker")];
    }
  });

  it("pauses continuation after repeated empty turns", async () => {
    const { pi, orchestrator, ctx } = session();
    orchestrator.lastCtx = ctx;
    orchestrator.objectiveContinuationCount = 5;
    await emit(pi, "turn_end", { message: { stopReason: "stop", content: [] } }, ctx);
    expect(orchestrator.continuationHalted).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("paused after repeated empty or truncated turns"), "warning");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("halts the stall watchdog after repeated stalled turns instead of aborting again", async () => {
    vi.useFakeTimers();
    try {
      const { pi, orchestrator, ctx } = session();
      orchestrator.config.performance.internals.mainTurnStale = 1000;
      ctx.abort = vi.fn();
      await emit(pi, "turn_start", {}, ctx);
      orchestrator.objectiveContinuationCount = 5;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(orchestrator.continuationHalted).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("repeated stalled turns"), "warning");
      await emit(pi, "session_shutdown", {}, ctx);
    } finally {
      vi.useRealTimers();
    }
  });
});
