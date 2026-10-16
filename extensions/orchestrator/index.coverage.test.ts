import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pp-index-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

const mocks = vi.hoisted(() => ({
  migrateConfigFile: vi.fn(),
  stripLegacyCachePolicy: vi.fn(),
  initFlantSync: vi.fn(),
  registerEventHandlers: vi.fn(),
  showPpMenu: vi.fn(async () => {}),
  error: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  migrateConfigFile: (...args: any[]) => (mocks.migrateConfigFile as any)(...args),
}));
vi.mock("./flant-infra.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./flant-infra.js")>()),
  stripLegacyCachePolicy: () => mocks.stripLegacyCachePolicy(),
  initFlantSync: (...args: any[]) => (mocks.initFlantSync as any)(...args),
}));
vi.mock("./event-handlers.js", () => ({ registerEventHandlers: (...args: any[]) => (mocks.registerEventHandlers as any)(...args) }));
vi.mock("./pp-menu.js", () => ({ showPpMenu: (...args: any[]) => (mocks.showPpMenu as any)(...args) }));
vi.mock("./log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./log.js")>()),
  getLogger: () => ({ error: mocks.error, debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GLOBAL_CONFIG_PATH } from "./config.js";
import initExtension from "./index.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");

function makePi(): any {
  return { registerCommand: vi.fn(), on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() } };
}

let cwd: string;
const originalCwd = process.cwd();

beforeEach(() => {
  delete (globalThis as any)[ORCHESTRATOR_KEY];
  for (const mock of Object.values(mocks)) mock.mockReset();
  cwd = mkdtempSync(join(tmpdir(), "pp-index-cwd-"));
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
  delete (globalThis as any)[ORCHESTRATOR_KEY];
});

describe("extension factory", () => {
  it("migrates the global config on the first activation only", () => {
    initExtension(makePi());
    initExtension(makePi());
    expect(mocks.migrateConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.migrateConfigFile.mock.calls[0][0]).toBe(GLOBAL_CONFIG_PATH);
    expect(mocks.stripLegacyCachePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.initFlantSync).toHaveBeenCalledTimes(2);
  });

  it("still registers /pp and its handlers when config migration and provider init throw", () => {
    mocks.migrateConfigFile.mockImplementation(() => { throw new Error("unreadable config"); });
    mocks.initFlantSync.mockImplementation(() => { throw new Error("bad providers"); });
    const pi = makePi();
    initExtension(pi);
    expect(mocks.registerEventHandlers).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand).toHaveBeenCalledWith("pp", expect.objectContaining({ handler: expect.any(Function) }));
    expect(mocks.error).toHaveBeenCalledWith({ s: "config", err: "unreadable config" }, expect.any(String));
    expect(mocks.error).toHaveBeenCalledWith({ s: "flant", err: "bad providers" }, expect.any(String));
  });

  it("hands provider init the roles' pinned models from both config layers", () => {
    mkdirSync(join(agentDir, "extensions", "pp"), { recursive: true });
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify({ agents: { main: { model: "global/model-a" } } }));
    mkdirSync(join(cwd, ".pp"));
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ agents: { subagents: { simple: { explore: { model: "project/model-b" } } } } }));
    initExtension(makePi());
    const pinned: string[] = mocks.initFlantSync.mock.calls[0][2];
    expect(pinned).toEqual(expect.arrayContaining(["global/model-a", "project/model-b"]));
  });

  it("reads pins without a project config and survives an unparseable one", () => {
    initExtension(makePi());
    expect(Array.isArray(mocks.initFlantSync.mock.calls[0][2])).toBe(true);
    mkdirSync(join(cwd, ".pp"));
    writeFileSync(join(cwd, ".pp", "config.json"), "{ not json");
    initExtension(makePi());
    expect(mocks.initFlantSync.mock.calls[1][2]).toEqual([]);
  });

  it("opens the control panel from /pp, remembering the command's context", async () => {
    const pi = makePi();
    initExtension(pi);
    const [, command] = pi.registerCommand.mock.calls.find((call: any[]) => call[0] === "pp");
    const orchestrator = mocks.registerEventHandlers.mock.calls[0][0];
    const ctx = { cwd };
    await command.handler("", ctx);
    expect(orchestrator.lastCtx).toBe(ctx);
    expect(mocks.showPpMenu).toHaveBeenCalledWith(orchestrator, ctx);
  });
});
