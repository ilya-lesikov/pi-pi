/**
 * Local-delta coverage for the pi-pi fork of pi-subagents.
 *
 * The fork removed upstream's `/agents` command and its file-based management menu (commit
 * 9987c69, "remove /agents command and file-based subagent config"): agent management now lives
 * only under the orchestrator's `/pp → Subagents` menu, and the extension registers NO slash
 * commands of its own. This file guards that fork boundary — it fails loudly if an upstream
 * rebase reintroduces `registerCommand("/agents", ...)`.
 *
 * The rest of the fork delta (widget wiring, print-mode, schedule, cross-extension RPC, nested
 * reload globals, status-note, clear-completed) is already covered by the large vendored-adjacent
 * suite; this file only fills the one boundary not asserted elsewhere. Kept separate so upstream
 * rebases re-apply cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    on: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, commands };
}

describe("fork boundary: /agents command removal (local fork)", () => {
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    vi.restoreAllMocks();
  });

  it("registers no slash commands at all (the /agents menu was removed)", () => {
    const { pi, commands } = makePi();
    subagentsExtension(pi);

    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(commands.has("agents")).toBe(false);
    expect(commands.size).toBe(0);
  });

  it("still registers exactly the three subagent tools (Agent, get_subagent_result, steer_subagent)", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    expect(tools.has(SUBAGENT_TOOL_NAMES.AGENT)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.GET_RESULT)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.STEER)).toBe(true);
  });

  it("announces readiness for the orchestrator via subagents:ready", () => {
    const { pi } = makePi();
    subagentsExtension(pi);

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:ready", expect.anything());
  });
});
