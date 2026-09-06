import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAcpState } from "./acp.js";
import { renderGenericPrompt } from "./event-handlers.js";

function makePi(): any {
  return {
    events: { emit: vi.fn(), on: vi.fn() },
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

describe("session-first core", () => {
  it("renders one generic prompt without workflow state or coding-only policy", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.cwd = "/tmp/project";
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.config.contextInjection = {
      globalAgents: false,
      globalClaude: false,
      ancestorAgents: false,
      ancestorClaude: false,
      projectAgents: false,
      projectClaude: false,
    };
    const prompt = renderGenericPrompt(orchestrator, {
      model: { provider: "test", id: "model" },
      ui: { notify: vi.fn() },
    }, ["read", "vcc_recall", "load_skill"]);
    expect(prompt).toContain("initial, restorable session");
    expect(prompt).toContain("There are no task modes, phases");
    expect(prompt).toContain("searchable with vcc_recall");
    expect(prompt).toContain("load_skill");
    expect(prompt).not.toContain("ACTIVE PHASE");
    expect(prompt).not.toContain("USER_REQUEST.md");
    expect(prompt).not.toContain("pp_phase_complete");
    expect(prompt).not.toContain("Implement only the approved plan");
  });

  it("publishes session activity rather than a phase plan", () => {
    const orchestrator = new Orchestrator(makePi());
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    expect(buildAcpState(orchestrator)).toEqual({ status: "idle", subagents: [] });
    orchestrator.mainTurnInFlight = true;
    expect(buildAcpState(orchestrator)).toEqual({ status: "running", subagents: [] });
    orchestrator.interactivePromptOpen = true;
    expect(buildAcpState(orchestrator)).toEqual({ status: "waiting", subagents: [] });
  });

  it("registers workers without context inheritance or worktree isolation", () => {
    const pi = makePi();
    const orchestrator = new Orchestrator(pi);
    orchestrator.config = normalizeConfigDurations(getDefaultConfig());
    orchestrator.registerAgents();
    const registration = pi.events.emit.mock.calls.find((call: any[]) => call[0] === "subagents:register-agents");
    const agents = registration[1].agents as Map<string, any>;
    expect(agents.size).toBeGreaterThanOrEqual(6);
    for (const agent of agents.values()) {
      expect(agent.inheritContext).toBe(false);
      expect(agent.isolated).toBe(false);
      expect(agent.builtinToolNames).toContain("vcc_recall");
    }
  });
});
