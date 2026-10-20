import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The global config path is fixed when config.js loads; point it at a scratch
// agent dir so no test reads or writes the developer's own global config.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pp-menu-agent-"));
});

import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { setCatalog } from "./routing.js";

const askUser = vi.fn();
vi.mock("./ask/index.js", () => ({
  askUser: (...args: any[]) => askUser(...args),
  isCancel: (result: any) => !!result?.__cancel,
}));

// A routing change re-registers providers; keep that off the network.
const updateFlantInfra = vi.fn(async () => ({ ok: true, models: [] }));
vi.mock("./flant-infra.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./flant-infra.js")>()),
  updateFlantInfra: (...args: any[]) => (updateFlantInfra as any)(...args),
}));

afterAll(() => {
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

function select(title: string) {
  askUser.mockResolvedValueOnce({ kind: "selection", selections: [title] });
}

/** Select the option whose title matches, for titles carrying live status. */
function selectMatching(pattern: RegExp) {
  askUser.mockImplementationOnce(async (_ctx: any, { options }: any) => {
    const match = options.find((option: any) => pattern.test(option.title));
    if (!match) throw new Error(`no option matches ${pattern}: ${options.map((o: any) => o.title).join(" | ")}`);
    return { kind: "selection", selections: [match.title] };
  });
}

function readProjectConfig(cwd: string): any {
  return JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
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

  it("offers the control panel with no task or phase launcher, settings grouped beneath it", async () => {
    select("Settings");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const options = askUser.mock.calls[0][1].options.map((option: any) => option.title);
    expect(options).toEqual(["Status", "Workers", "Usage", "Settings", "Create support bundle…", "Diagnostics", "Close"]);
    expect(options).not.toContain("Task");
    expect(options).not.toContain("Next");
    const settings = askUser.mock.calls[1][1].options.map((option: any) => option.title);
    expect(settings).toEqual([
      "Providers", "Models", "Agents", "Skills", "Context", "Prompt size", "Commands", "General", "Performance", "LSP", "Back",
    ]);
    // The per-provider menus of the old layout live under Settings › Providers now.
    for (const gone of ["Flant", "ChatGPT subscription", "Copilot"]) {
      expect(options).not.toContain(gone);
      expect(settings).not.toContain(gone);
    }
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
    const rows = askUser.mock.calls[2][1].options;
    const options = rows.map((option: any) => option.title);
    expect(options).toContain("Main");
    expect(options).toContain("Explore");
    expect(options).toContain("Librarian");
    expect(options).toContain("Task");
    expect(options).toContain("Advisors");
    expect(options).toContain("Reviewers");
    expect(options).toContain("Deep debuggers");
    expect(options.some((title: string) => title.startsWith("Max concurrent subagents:"))).toBe(true);
    // Rows name the slot a role runs on, not a provider-bound spec.
    expect(rows.find((row: any) => row.title === "Main").description).toContain("Claude Opus");
    expect(rows.find((row: any) => row.title === "Explore").description).toContain("GPT Luna");
    expect(rows.find((row: any) => row.title === "Advisors").description).toContain("GPT Astra Pro, Claude Fable");
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

  it("clears a project override when the chosen value matches the inherited one", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ skills: { loadBundled: false } }), "utf-8");
    select("Settings");
    select("Skills");
    select("Load bundled skills: OFF");
    select("Yes (default)");
    select("Set for project");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.config.skills.loadBundled = false;
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const written = JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
    expect(written.skills?.loadBundled).toBeUndefined();
    expect(orchestrator.config.skills.loadBundled).toBe(true);
  });

  it("warns and refuses a global pool edit masked by a project override", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const pool = getDefaultConfig().agents.subagents.pools.advisors;
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ agents: { subagents: { pools: { advisors: pool } } } }), "utf-8");
    select("Settings");
    select("Agents");
    select("Advisors");
    select("GPT Astra Pro");
    select("Enabled: Yes");
    select("Set globally");
    select("Back");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const notify = vi.fn();
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("project override"), "warning");
  });

  it("can reset a project pool override that masks global edits", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const pool = getDefaultConfig().agents.subagents.pools.advisors;
    mkdirSync(join(cwd, ".pp"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify({ agents: { subagents: { pools: { advisors: pool } } } }), "utf-8");
    select("Settings");
    select("Agents");
    select("Advisors");
    select("Reset project setting");
    select("Yes, reset");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const written = JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
    expect(written.agents?.subagents?.pools?.advisors).toBeUndefined();
  });

  it("re-registers agent definitions after a pool edit", async () => {
    select("Settings");
    select("Agents");
    select("Advisors");
    // Pool rows show the slot label of the entry's model reference.
    expect(getDefaultConfig().agents.subagents.pools.advisors[0]!.model).toBe("gpt/astra:pro");
    select("GPT Astra Pro");
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

  it("moves a provider up by rewriting providers.order in the chosen scope", async () => {
    select("Settings");
    select("Providers");
    selectMatching(/^2 {2}ChatGPT subscription {2}\[/);
    select("Move up");
    select("Set for project");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    const order = ["codex", "claude-sub", "copilot", "llm-api"];
    expect(readProjectConfig(cwd).providers.order).toEqual(order);
    expect(orchestrator.config.providers.order).toEqual(order);
    // The new priority is listed when the provider list is shown again.
    const relisted = askUser.mock.calls[6][1].options.map((option: any) => option.title);
    expect(relisted[0]).toMatch(/^1 {2}ChatGPT subscription/);
    expect(relisted[1]).toMatch(/^2 {2}Claude subscription/);
  });

  it("writes a family override picked from a credentialed provider's models", async () => {
    setCatalog(["zai/glm-5.3", "zai/glm-5-air", "openai-codex/gpt-6-astra"]);
    select("Settings");
    select("Models");
    select("Claude");
    select("Override: none");
    select("zai");
    select("glm-5.3");
    select("Set for project");
    select("Back");
    select("Back");
    select("Back");
    select("Close");
    const orchestrator = makeOrchestrator(cwd);
    const { showPpMenu } = await import("./pp-menu.js");
    try {
      await showPpMenu(orchestrator, { model: null, sessionManager: {}, ui: {} });
    } finally {
      setCatalog([]);
    }
    expect(readProjectConfig(cwd).models.claude.override).toEqual({ provider: "zai", model: "glm-5.3" });
    expect(orchestrator.config.models.claude.override).toEqual({ provider: "zai", model: "glm-5.3" });
    // Only providers with models in the catalog are offered.
    const providers = askUser.mock.calls[4][1].options.map((option: any) => option.title);
    expect(providers).toContain("zai");
    expect(providers).toContain("ChatGPT subscription (openai-codex)");
  });

  it("prints the status instead of a menu without a UI", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const { attachHost } = await import("./notices.js");
    const ctx = { mode: "print", hasUI: false, model: null, sessionManager: {}, ui: {} };
    attachHost(ctx);
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => (written.push(String(chunk)), true));
    try {
      const { showPpMenu } = await import("./pp-menu.js");
      await showPpMenu(orchestrator, ctx);
    } finally {
      write.mockRestore();
      attachHost({ mode: "tui" });
    }
    expect(askUser).not.toHaveBeenCalled();
    expect(written[0]).toMatch(/^pi-pi · status\nModel: none/);
  });

  it("warns before opening on a host that may stay busy, and not on one that settles", async () => {
    const { attachHost } = await import("./notices.js");
    const { showPpMenu } = await import("./pp-menu.js");
    for (const [env, warned] of [[{ BB_THREAD_ID: "t" }, true], [{}, true], [{ PASEO_AGENT_ID: "a" }, false]] as const) {
      Object.assign(process.env, env);
      const notify = vi.fn();
      const ctx = { mode: "rpc", hasUI: true, isIdle: () => true, model: null, sessionManager: {}, ui: { notify } };
      attachHost(ctx);
      select("Close");
      await showPpMenu(makeOrchestrator(cwd), ctx);
      expect(notify.mock.calls.some((call) => /may stay busy/.test(call[0]))).toBe(warned);
      for (const key of Object.keys(env)) delete process.env[key];
    }
    attachHost({ mode: "tui" });
  });

  it("shows a worker as text with its controls outside the terminal", async () => {
    const { attachHost } = await import("./notices.js");
    const orchestrator = makeOrchestrator(cwd);
    const record: any = { id: "explore-1", spec: { type: "explore", description: "map repo" }, status: "running", createdAt: Date.now(), toolUses: 2 };
    const stop = vi.fn();
    const send = vi.fn(() => "steered");
    orchestrator.workers = { list: () => [record], get: () => record, sessionOf: () => ({ transcript: () => [{ role: "assistant", content: [{ type: "text", text: "reading files" }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }] }] }), stop, send } as any;
    const notify = vi.fn();
    const ctx = { mode: "rpc", hasUI: true, isIdle: () => true, model: null, sessionManager: {}, ui: { notify, input: vi.fn(async () => "focus on tests") } };
    attachHost(ctx);
    select("Workers");
    selectMatching(/explore-1/);
    select("Send a message");
    select("Stop");
    select("Back");
    select("Back");
    select("Close");
    const { showPpMenu } = await import("./pp-menu.js");
    await showPpMenu(orchestrator, ctx);
    attachHost({ mode: "tui" });
    const shown = notify.mock.calls.map((call) => call[0]).find((text: string) => text.startsWith("pi-pi · worker explore-1"));
    expect(shown).toContain("reading files");
    expect(shown).toContain("▸ read a.ts");
    expect(send).toHaveBeenCalledWith("explore-1", "focus on tests");
    expect(stop).toHaveBeenCalledWith("explore-1");
  });
});
