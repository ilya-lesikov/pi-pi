import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The global config path is fixed when config.js loads; keep it in a scratch agent dir.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pp-menu-settings-agent-"));
});

import { GLOBAL_CONFIG_PATH, getDefaultConfig, loadConfig, normalizeConfigDurations } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { clearPauses, pause, setCatalog } from "./routing.js";
import { createUsageTracker } from "./usage-tracker.js";

const askUser = vi.fn();
vi.mock("./ask/index.js", () => ({
  askUser: (...args: any[]) => askUser(...args),
  isCancel: (result: any) => !!result?.__cancel,
}));

const updateFlantInfra = vi.fn(async () => ({ ok: true, models: [] as string[] }));
vi.mock("./flant-infra.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./flant-infra.js")>()),
  updateFlantInfra: (...args: any[]) => (updateFlantInfra as any)(...args),
}));

const USAGE_KEY = Symbol.for("pi-pi:usage-tracker");

afterAll(() => {
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Step = string | RegExp | { cancel: true } | { freeform: string };

/** Queue menu answers; each picks the option equal to / matching the step. */
function script(...steps: Step[]) {
  for (const step of steps) {
    askUser.mockImplementationOnce(async (_ctx: any, { question, options }: any) => {
      if (typeof step === "object" && "cancel" in step) return { __cancel: true, reason: "user" };
      if (typeof step === "object" && "freeform" in step) return { kind: "freeform", text: step.freeform };
      const titles: string[] = options.map((o: any) => (typeof o === "string" ? o : o.title));
      const match = titles.find((t) => (typeof step === "string" ? t === step : step.test(t)));
      if (!match) throw new Error(`"${question}": no option ${String(step)} in ${titles.join(" | ")}`);
      return { kind: "selection", selections: [match] };
    });
  }
}

function questions(): string[] {
  return askUser.mock.calls.map((call) => call[1].question);
}

function titlesAt(index: number): string[] {
  return askUser.mock.calls[index]![1].options.map((o: any) => (typeof o === "string" ? o : o.title));
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

let cwd: string;
let notify: ReturnType<typeof vi.fn>;
let input: ReturnType<typeof vi.fn>;
let ctx: any;

function project(): any {
  return JSON.parse(readFileSync(join(cwd, ".pp", "config.json"), "utf-8"));
}

function global(): any {
  return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
}

function writeProject(value: unknown): void {
  mkdirSync(join(cwd, ".pp"), { recursive: true });
  writeFileSync(join(cwd, ".pp", "config.json"), JSON.stringify(value), "utf-8");
}

async function run(orchestrator = makeOrchestrator(cwd)): Promise<Orchestrator> {
  orchestrator.lastCtx = ctx;
  const { showPpMenu } = await import("./pp-menu.js");
  await showPpMenu(orchestrator, ctx);
  // Every queued answer was consumed: navigation ended where the script did.
  expect(askUser({}, { question: "probe", options: [] })).toBeUndefined();
  return orchestrator;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pp-menu-settings-"));
  askUser.mockReset();
  updateFlantInfra.mockClear();
  notify = vi.fn();
  input = vi.fn();
  ctx = { model: null, sessionManager: {}, ui: { notify, input } };
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(GLOBAL_CONFIG_PATH, { force: true });
  delete (globalThis as any)[USAGE_KEY];
  clearPauses();
});

describe("/pp top level", () => {
  it("closes on cancel without asking anything else", async () => {
    script({ cancel: true });
    await run();
    // The panel plus the harness's own leftover-answer probe.
    expect(questions()).toEqual(["/pp · session control panel", "probe"]);
  });

  it("reports status with model, context, and config warnings", async () => {
    script("Status", "Close");
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.configError = "bad json";
    orchestrator.continuationHalted = true;
    ctx.getContextUsage = () => ({ tokens: 50_000, contextWindow: 200_000 });
    await run(orchestrator);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain("Model: none");
    expect(text).toContain("Context: 50k / 200k tokens (25%)");
    expect(text).toContain("⚠ Config error: bad json");
    expect(text).toContain("Automatic continuation paused");
  });

  it("says there is no usage data without a tracker, and breaks usage down with one", async () => {
    const tracker = createUsageTracker();
    tracker.recordTurn("claude-opus-5", "anthropic", 1000, 200, 3000, 0, 0.5, true);
    tracker.recordSubagentCompletion({ input: 500, output: 100 }, 0.1, { description: "find x", agentType: "explore", modelId: "gpt-6-luna", durationMs: 65_000, toolUses: 3 });
    // The tracker appears once the first report has been shown.
    notify.mockImplementationOnce(() => { (globalThis as any)[USAGE_KEY] = tracker; });
    script("Usage", "Usage", "Close");
    await run();
    expect(notify.mock.calls[0]![0]).toBe("No usage data available.");
    const text = notify.mock.calls[1]![0] as string;
    expect(text).toContain("Session usage (total):");
    expect(text).toContain("claude-opus-5:");
    expect(text).toContain("explore: ↑500  ↓100  $0.10  1m 5s  3 tools");
    expect(text).toMatch(/Main \(claude-opus-5\): .*\$0\.50/);
  });

  it("writes a report bundle from a typed note, and refuses an empty one", async () => {
    script("Report", { freeform: "  " }, "Report", { freeform: "menu broke" }, "Write report", "Close");
    await run();
    expect(notify.mock.calls[0]).toEqual(["Report cancelled — a note is required.", "info"]);
    expect(notify.mock.calls[1]![0]).toMatch(/^Report written to .*\(1 files\)/);
    const reports = readdirSync(join(cwd, ".pp", "reports"));
    expect(reports).toHaveLength(1);
    expect(readFileSync(join(cwd, ".pp", "reports", reports[0]!, "note.md"), "utf-8")).toContain("menu broke");
  });

  it("runs the doctor and returns to the panel", async () => {
    script("Doctor", "Close");
    const orchestrator = makeOrchestrator(cwd);
    const runDoctor = vi.fn(async () => {});
    vi.doMock("./doctor.js", () => ({ runDoctor }));
    try {
      await run(orchestrator);
    } finally {
      vi.doUnmock("./doctor.js");
    }
    expect(runDoctor).toHaveBeenCalledWith(orchestrator, ctx);
  });
});

describe("/pp › Workers", () => {
  function record(id: string, status: string, extra: Record<string, any> = {}): any {
    const now = Date.now();
    return { id, status, spec: { type: "task", description: `do ${id}` }, createdAt: now - 5000, toolUses: 2, ...extra };
  }

  it("shows an empty list when there are no workers", async () => {
    script("Workers", "Back", "Close");
    await run();
    expect(questions()[1]).toBe("Workers — none yet");
    expect(titlesAt(1)).toEqual(["Back"]);
  });

  it("lists waiting workers first, stops all active ones, and opens one in the viewer", async () => {
    const records = [
      record("w1", "completed", { result: { summary: "all good" } }),
      record("w2", "running", { step: { label: "editing", since: Date.now() } }),
      record("w3", "running", { question: { id: "q", text: "which file?", askedAt: Date.now() } }),
    ];
    const killAll = vi.fn();
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.workers = { list: () => records, get: (id: string) => records.find((r) => r.id === id), killAll } as any;
    const custom = vi.fn(async () => undefined);
    ctx.ui.custom = custom;
    script("Workers", "Stop all active workers", /· w1$/, "Back", "Close");
    await run(orchestrator);
    expect(questions()[1]).toBe("Workers (2 active) — pick one to open its live view");
    const rows = askUser.mock.calls[1]![1].options;
    expect(rows.map((o: any) => o.title)).toEqual([
      "task: do w3 [? waiting on you] · w3",
      "task: do w2 [running] · w2",
      "task: do w1 [completed] · w1",
      "Stop all active workers",
      "Back",
    ]);
    expect(rows[0].description).toContain("asks: which file?");
    expect(rows[1].description).toContain("editing");
    expect(rows[2].description).toContain("2 tools · all good");
    expect(killAll).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
  });
});

describe("/pp › Settings › LSP", () => {
  it("warns when no language servers exist in the session", async () => {
    script("Settings", "LSP", "Restart all servers", "Back", "Back", "Close");
    await run();
    expect(notify).toHaveBeenCalledWith("Language servers are not available in this session.", "warning");
  });

  it("restarts the servers, and surfaces a restart failure", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const restart = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("boom"));
    orchestrator.lsp = { restart } as any;
    script("Settings", "LSP", "Restart all servers", "Restart all servers", "Back", "Back", "Close");
    await run(orchestrator);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith("Language servers stopped; they start again on next use.", "info");
    expect(notify).toHaveBeenCalledWith("Failed to restart LSP servers: boom", "error");
  });

  it("toggles diagnosticsAfterEdit into the project, then resets it", async () => {
    script(
      "Settings", "LSP", "Diagnostics after edits: ON",
      /^No/, "Set for project",
      "Reset project setting", "Yes, reset",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(questions()).toContain("Confirm reset?");
    expect(project().lsp?.diagnosticsAfterEdit).toBeUndefined();
    expect(orchestrator.config.lsp.diagnosticsAfterEdit).toBe(true);
    // The write landed before the reset offered to undo it.
    const toggle = askUser.mock.calls.findIndex((c, i) => i > 4 && c[1].question === "Diagnostics after edits");
    expect(titlesAt(toggle)).toContain("Reset project setting");
    expect(titlesAt(toggle).find((t) => t.startsWith("No"))).toBe("No (active, project)");
  });

  it("writes diagnosticsAfterEdit globally", async () => {
    script("Settings", "LSP", "Diagnostics after edits: ON", /^No/, "Set globally", "Back", "Back", "Back", "Close");
    const orchestrator = await run();
    expect(global().lsp.diagnosticsAfterEdit).toBe(false);
    expect(orchestrator.config.lsp.diagnosticsAfterEdit).toBe(false);
  });
});

describe("/pp › Settings › Agents", () => {
  it("validates max concurrent subagents, writes it globally, and resets it", async () => {
    input.mockResolvedValueOnce("abc").mockResolvedValueOnce("0").mockResolvedValueOnce(null).mockResolvedValueOnce("5");
    script(
      "Settings", "Agents", /^Max concurrent subagents:/,
      "Edit", "Edit", "Edit", "Edit", "Set globally",
      "Reset global setting", "Yes, reset",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = await run();
    const warnings = notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]![0]).toContain("between 1 and 1024");
    expect(questions()).toContain("Max concurrent subagents: 5");
    expect(global().agents?.maxConcurrentSubagents).toBeUndefined();
    expect(orchestrator.config.agents.maxConcurrentSubagents).toBe(7);
  });

  it("sets the main agent's thinking for the project", async () => {
    script("Settings", "Agents", "Main", /^Thinking:/, /^Low/, "Set for project", "Back", "Back", "Back", "Close");
    const orchestrator = await run();
    expect(project().agents.main.thinking).toBe("low");
    expect(orchestrator.registerAgents).toHaveBeenCalledWith(true);
  });

  it("pins the explore agent to a concrete model", async () => {
    ctx.modelRegistry = { getAvailable: () => [{ provider: "zai", id: "glm-5" }], find: () => ({ contextWindow: 128_000, input: ["text"], reasoning: true }) };
    script(
      "Settings", "Agents", "Explore", /^Model:/,
      "Pin a specific provider/model…", "zai", "glm-5", "Set for project",
      "Back", "Back", "Back", "Close",
    );
    await run();
    expect(project().agents.subagents.simple.explore.model).toBe("zai/glm-5");
    const models = askUser.mock.calls.find((c) => c[1].question === "Pin model › zai")![1].options;
    expect(models[0].description).toBe("128k context · no images · thinking");
  });

  it("adds a pool entry and deletes it again", async () => {
    script(
      "Settings", "Agents", "Reviewers", "New entry", "Claude Haiku", /^Medium/, "Set for project",
      "Claude Haiku", "Delete", "Yes, delete", "Set for project",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = await run();
    const reviewers = project().agents.subagents.pools.reviewers;
    expect(reviewers.map((e: any) => e.model)).toEqual(["gpt/astra:pro", "claude/fable"]);
    expect(orchestrator.config.agents.subagents.pools.reviewers).toHaveLength(2);
  });
});

describe("/pp › Settings › other screens", () => {
  it("rejects a duration it cannot parse, writes a valid one, and resets it", async () => {
    input.mockResolvedValueOnce("soon").mockResolvedValueOnce("45s");
    script(
      "Settings", "Performance", /^Main turn stale:/,
      "Edit", "Edit", "Set for project",
      "Reset project setting", "Yes, reset",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(notify).toHaveBeenCalledWith("Invalid duration format.", "warning");
    expect(questions()).toContain("Main turn stale: 45s");
    expect(project().performance?.internals?.mainTurnStale).toBeUndefined();
    expect(orchestrator.config.performance.internals.mainTurnStale).toBe(600_000);
  });

  it("sets the log level and tracing", async () => {
    script(
      "Settings", "General", /^Log level:/, /^Debug/, "Set for project", "Back",
      /^Tracing:/, /^Yes/, "Set for project", "Back",
      "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(project().general).toEqual({ logLevel: "debug", tracing: true });
    expect(orchestrator.config.general.logLevel).toBe("debug");
  });

  it("turns a context source off for the project", async () => {
    script("Settings", "Context", /^Ancestor CLAUDE\.md:/, /^No/, "Set for project", "Back", "Back", "Back", "Close");
    const orchestrator = await run();
    expect(project().contextInjection.ancestorClaude).toBe(false);
    expect(orchestrator.config.contextInjection.ancestorClaude).toBe(false);
  });

  it("lists the skills the agent can load", async () => {
    script("Settings", "Skills", "List skills", "Back", "Back", "Close");
    await run();
    expect(notify.mock.calls[0]![0]).toContain("code-rules (bundled):");
  });

  it("writes prompt-size pickers and clears the context window back to the host's", async () => {
    script(
      "Settings", "Prompt size",
      /^Prompt ceiling:/, "250K", "Set for project",
      /^History kept:/, "50%", "Set for project",
      /^Context window:/, "1M", "Set for project",
      /^Context window:/, "Ask the host", "Set for project",
      "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(project().promptcap).toEqual({ maxPromptTokens: 250_000, keepFraction: 0.5 });
    expect(orchestrator.config.promptcap.contextWindow).toBeUndefined();
    expect(questions().filter((q) => q === "Prompt size")).toHaveLength(5);
    expect(titlesAt(questions().lastIndexOf("Prompt size"))).toContain("Prompt ceiling: 250K tokens");
  });

  it("surfaces a config validation error instead of writing", async () => {
    writeProject({ general: { logLevel: "loud" } });
    script("Settings", "General", /^Tracing:/, /^Yes/, "Set for project", "Back", "Back", "Back", "Close");
    await run();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Config update rejected: config\.general\.logLevel/), "error");
    expect(project().general.tracing).toBeUndefined();
  });

  it("adds, edits, disables and deletes an after-edit command", async () => {
    input
      .mockResolvedValueOnce("prettier --write ${file}").mockResolvedValueOnce(" , ")
      .mockResolvedValueOnce("prettier --write ${file}").mockResolvedValueOnce("*.ts, *.tsx")
      .mockResolvedValueOnce("*.js");
    script(
      "Settings", "Commands",
      "New command",
      "New command", "Set for project",
      /^Command "prettier-write-file"$/, "Edit triggers", "Set for project",
      /^Enabled:/, /^No/, "Set for project", "Back",
      "Delete command", "Yes, delete",
      "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(notify).toHaveBeenCalledWith("At least one file pattern is required.", "warning");
    expect(questions()).toContain('Command "prettier-write-file"');
    expect(project().commands?.afterEdit?.["prettier-write-file"]).toBeUndefined();
    expect(orchestrator.config.commands.afterEdit).toEqual({});
    const listing = askUser.mock.calls.findIndex((c, i) => i > 6 && String(c[1].question).startsWith("Command \"prettier"));
    expect(askUser.mock.calls[listing]![1].options[1].description).toBe("1 glob patterns: *.js");
  });
});

describe("/pp › Settings › Providers", () => {
  it("explains routing, sets the retry interval, and clears pauses", async () => {
    pause("codex", 60_000, "rate limited");
    script(
      "Settings", "Providers",
      "Explain routing",
      /^Retry paused providers after:/, "30 min", "Set for project",
      "Clear pauses (1)",
      "Back", "Back", "Close",
    );
    await run();
    expect(notify.mock.calls[0]![0]).toMatch(/^Priority: Claude subscription › ChatGPT subscription/);
    expect(notify.mock.calls[0]![0]).toContain("Paused:");
    expect(project().providers.fallback.retryAfterMinutes).toBe(30);
    expect(notify).toHaveBeenCalledWith("Cleared 1 pause(s).", "info");
  });

  it("disables a provider and warns when a project setting masks a global write", async () => {
    writeProject({ providers: { copilot: { enabled: true } } });
    script("Settings", "Providers", /^3 {2}GitHub Copilot/, /^Enabled: ON/, "Set globally", "Back", "Back", "Back", "Close");
    const orchestrator = await run();
    expect(global().providers.copilot.enabled).toBe(false);
    expect(orchestrator.config.providers.copilot.enabled).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("A project setting still governs this"), "warning");
  });

  it("updates the LLM API model list on demand and sets its cache period", async () => {
    updateFlantInfra.mockResolvedValueOnce({ ok: true, models: ["a", "b"] });
    script(
      "Settings", "Providers", /^4 {2}LLM API/,
      "Update now",
      /^Cache period:/, "7 days", "Set for project",
      "Back", "Back", "Back", "Close",
    );
    await run();
    expect(updateFlantInfra).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force: true }));
    expect(notify).toHaveBeenCalledWith("LLM API: 2 models.", "info");
    expect(project().providers["llm-api"].cacheTTLDays).toBe(7);
  });

  it("changes the Claude subscription route", async () => {
    script("Settings", "Providers", /^1 {2}Claude subscription/, /^Route:/, /^Direct only/, "Set for project", "Back", "Back", "Back", "Back", "Close");
    await run();
    expect(project().providers["claude-sub"].route).toEqual(["direct"]);
    expect(existsSync(GLOBAL_CONFIG_PATH)).toBe(false);
  });
});

describe("/pp › Settings › Models", () => {
  afterEach(() => setCatalog([]));

  it("pins a slot to a version, then back to latest", async () => {
    setCatalog(["openai-codex/gpt-6-luna", "openai-codex/gpt-5-luna"]);
    script(
      "Settings", "Models", "GPT", "GPT Luna", "gpt-5-luna", "Set for project",
      "GPT Luna [pinned gpt-5-luna]", "Latest", "Set for project",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = await run();
    expect(titlesAt(questions().indexOf("GPT Luna › Version"))).toEqual(["Latest", "gpt-6-luna", "gpt-5-luna", "Back"]);
    expect(project().models?.gpt?.pins?.luna).toBeUndefined();
    expect(orchestrator.config.models.gpt.pins.luna).toBeUndefined();
  });

  it("edits an override's slot model and removes the override", async () => {
    setCatalog(["zai/glm-5.3", "zai/glm-5-air"]);
    writeProject({ models: { claude: { override: { provider: "zai", model: "glm-5.3" } } } });
    script(
      "Settings", "Models", "Claude",
      /^Claude Haiku:/, "glm-5-air", "Set for project",
      "Remove override", "Set for project",
      "Back", "Back", "Back", "Close",
    );
    const orchestrator = makeOrchestrator(cwd);
    orchestrator.config = loadConfig(cwd);
    await run(orchestrator);
    expect(questions()).toContain("Claude › Override [project]");
    expect(project().models?.claude?.override).toBeUndefined();
    expect(orchestrator.config.models.claude.override).toBeNull();
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("rejected"), "error");
  });
});
