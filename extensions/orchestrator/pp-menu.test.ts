import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

const askUser = vi.fn();
vi.mock("../../3p/pi-ask-user/index.js", () => ({
  askUser: (...args: any[]) => askUser(...args),
  isCancel: (result: any) => !!result?.__cancel,
}));

function select(title: string) {
  askUser.mockResolvedValueOnce({ kind: "selection", selections: [title] });
}

function makeOrchestrator(cwd: string): Orchestrator {
  const orchestrator = new Orchestrator({
    appendEntry: vi.fn(),
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    events: { emit: vi.fn() },
  } as any);
  orchestrator.cwd = cwd;
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.registerAgents = vi.fn() as any;
  orchestrator.applySubagentConcurrency = vi.fn() as any;
  return orchestrator;
}

describe("/pp session control panel", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pp-menu-"));
    askUser.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("offers status, workers, usage, and settings but no task or phase launcher", async () => {
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const options = askUser.mock.calls[0][1].options.map((option: any) => option.title);
    expect(options).toEqual(["Status", "Workers", "Usage", "Settings", "Close"]);
    expect(options).not.toContain("Task");
    expect(options).not.toContain("Next");
  });

  it("exposes the full settings surface for the no-phase architecture", async () => {
    select("Settings");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const options = askUser.mock.calls[1][1].options.map((option: any) => option.title);
    expect(options).toEqual([
      "General", "Agents", "Context", "Skills", "Compaction", "Commands", "Flant", "Copilot", "Performance", "LSP", "Report", "Doctor", "Back",
    ]);
  });

  it("lists main, simple roles, pools, and concurrency under Agents", async () => {
    select("Settings");
    select("Agents");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const options = askUser.mock.calls[2][1].options.map((option: any) => option.title);
    expect(options).toContain("Main");
    expect(options).toContain("Explore");
    expect(options).toContain("Librarian");
    expect(options).toContain("Task");
    expect(options).toContain("Advisors");
    expect(options).toContain("Reviewers");
    expect(options).toContain("Deep debuggers");
    expect(options.some((title: string) => title.startsWith("Max concurrent subagents:"))).toBe(true);
  });

  it("persists a project-scoped skills toggle through the settings flow", async () => {
    select("Settings");
    select("Skills");
    select("Load bundled skills: ON");
    select("No");
    select("Set for project");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const written = JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
    expect(written.skills.loadBundled).toBe(false);
    expect(orchestrator.config.skills.loadBundled).toBe(false);
  });

  it("re-registers agent definitions after a pool edit", async () => {
    select("Settings");
    select("Agents");
    select("Advisors");
    const advisorTitle = getDefaultConfig().agents.subagents.pools.advisors[0]!.model;
    select(advisorTitle);
    select("Enabled: Yes");
    select("Set for project");
    select("Back");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const written = JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
    expect(written.agents.subagents.pools.advisors[0].enabled).toBe(false);
    expect(orchestrator.registerAgents).toHaveBeenCalled();
  });
});
