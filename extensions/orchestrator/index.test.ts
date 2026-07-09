import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  Orchestrator: vi.fn(),
  registerCommandHandlers: vi.fn(),
  registerEventHandlers: vi.fn(),
  registerCbmTools: vi.fn(),
  registerExaTools: vi.fn(),
  registerAstSearchTool: vi.fn(),
  initFlantSync: vi.fn(),
  suppressPierreThemeSpam: vi.fn(),
}));

vi.mock("./orchestrator.js", () => ({ Orchestrator: mocks.Orchestrator }));
vi.mock("./command-handlers.js", () => ({ registerCommandHandlers: mocks.registerCommandHandlers }));
vi.mock("./event-handlers.js", () => ({ registerEventHandlers: mocks.registerEventHandlers }));
vi.mock("./cbm.js", () => ({ registerCbmTools: mocks.registerCbmTools }));
vi.mock("./exa.js", () => ({ registerExaTools: mocks.registerExaTools }));
vi.mock("./ast-search.js", () => ({ registerAstSearchTool: mocks.registerAstSearchTool }));
vi.mock("./validate-artifacts.js", () => ({ validatePlan: vi.fn(), validateArtifact: vi.fn() }));
vi.mock("./flant-infra.js", () => ({ initFlantSync: mocks.initFlantSync }));
vi.mock("./suppress-pierre-theme-spam.js", () => ({ suppressPierreThemeSpam: mocks.suppressPierreThemeSpam }));

import init, { SUBAGENT_SESSION_KEY } from "./index.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");
const ORCHESTRATOR_CWD_KEY = Symbol.for("pi-pi:orchestrator-cwd");

function makePi() {
  return { on: vi.fn(), registerTool: vi.fn() } as any;
}

afterEach(() => {
  (globalThis as any)[ORCHESTRATOR_KEY] = undefined;
  (globalThis as any)[ORCHESTRATOR_CWD_KEY] = undefined;
  (globalThis as any)[SUBAGENT_SESSION_KEY] = undefined;
  vi.clearAllMocks();
});

describe("orchestrator extension entrypoint", () => {
  it("exports a default function and the shared subagent-session symbol", () => {
    expect(typeof init).toBe("function");
    expect(SUBAGENT_SESSION_KEY).toBe(Symbol.for("pi-pi:subagent-session"));
  });

  it("performs first-time init: flant sync, orchestrator, event/command handlers", () => {
    const pi = makePi();
    init(pi);
    expect(mocks.suppressPierreThemeSpam).toHaveBeenCalledTimes(1);
    expect(mocks.initFlantSync).toHaveBeenCalledWith(pi);
    expect(mocks.Orchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.registerEventHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.registerCommandHandlers).toHaveBeenCalledTimes(1);
    expect((globalThis as any)[ORCHESTRATOR_KEY]).toBe(true);
    expect((globalThis as any)[ORCHESTRATOR_CWD_KEY]).toBe(process.cwd());
  });

  it("takes the subagent branch when already initialized", () => {
    (globalThis as any)[ORCHESTRATOR_KEY] = true;
    const pi = makePi();
    init(pi);
    expect((globalThis as any)[SUBAGENT_SESSION_KEY]).toEqual({ depth: 1 });
    expect(mocks.registerCbmTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerExaTools).toHaveBeenCalledWith(pi);
    expect(mocks.registerAstSearchTool).toHaveBeenCalledTimes(1);
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(mocks.Orchestrator).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing subagent-session marker", () => {
    (globalThis as any)[ORCHESTRATOR_KEY] = true;
    (globalThis as any)[SUBAGENT_SESSION_KEY] = { depth: 3 };
    init(makePi());
    expect((globalThis as any)[SUBAGENT_SESSION_KEY]).toEqual({ depth: 3 });
  });
});
