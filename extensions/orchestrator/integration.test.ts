import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAskUserHarness,
  expectActiveTaskNext,
  expectBrainstormToPlan,
  expectImplementToDone,
  expectPlanToImplement,
  expectPpStartImplementAutonomous,
  expectQuickMenu,
  expectReviewAuto,
  expectReviewOnMyOwn,
  m,
} from "./test-helpers.js";

let menu: ReturnType<typeof createAskUserHarness>;

vi.mock("../../3p/pi-ask-user/index.js", () => {
  return {
    askUser: async (_ctx: any, opts: any) => menu.handle(opts),
    isCancel: (value: any) =>
      typeof value === "object" && value !== null && value.__cancel === true,
  };
});

import { Orchestrator } from "./orchestrator.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { enterReviewCycle, finalizeReviewCycle, registerEventHandlers } from "./event-handlers.js";
import { createTask, getActiveTask, loadTask, saveTask } from "./state.js";
import { registerAgentDefinitions } from "./agents/registry.js";
import { taskLogsDir } from "./log.js";
import { resumeTask } from "./pp-menu.js";
import * as commandsModule from "./commands.js";
import * as doctorModule from "./doctor.js";
import * as usageTrackerModule from "./usage-tracker.js";

vi.mock("./cbm.js", () => ({ registerCbmTools: vi.fn() }));
vi.mock("./exa.js", () => ({ registerExaTools: vi.fn() }));
vi.mock("./ast-search.js", () => ({ registerAstSearchTool: vi.fn() }));
vi.mock("./doctor.js", () => ({ runDoctor: vi.fn(async () => undefined) }));
vi.mock("./agents/registry.js", () => ({
  registerAgentDefinitions: vi.fn(),
  unregisterAgentDefinitions: vi.fn(),
  setExtensionOnlyMode: vi.fn(),
  spawnViaRpc: vi.fn(async (_pi: any, _type: string) => ({ id: `mock-${Math.random().toString(36).slice(2)}` })),
  waitForCompletion: vi.fn(async () => undefined),
}));

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.js")>();
  return { ...original, loadConfig: () => ({
    general: {
      autoCommit: false,
      loadExtraRepoConfigs: true,
      logLevel: "info",
    },
    agents: {
      orchestrators: {
        implement: { model: "test/model", thinking: "high" },
        plan: { model: "test/model", thinking: "high" },
        debug: { model: "test/model", thinking: "high" },
        brainstorm: { model: "test/model", thinking: "high" },
        review: { model: "test/model", thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: "test/explore", thinking: "low" },
          librarian: { model: "test/librarian", thinking: "medium" },
          task: { model: "test/task", thinking: "medium" },
        },
        presetGroups: {
          planners: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/planner", thinking: "low" } } } },
          },
          planReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
          brainstormReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
          codeReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
        },
      },
    },
    commands: { afterEdit: {}, afterImplement: {} },
    performance: {
      commands: { afterEdit: 1000, afterImplement: 1000 },
      internals: { subagentStale: 1000, taskLockStale: 600000, taskLockRefresh: 30000 },
    },
  }) };
});

type Handler = (...args: any[]) => any;

const tempDirs: string[] = [];

const VALID_USER_REQUEST = `# User Request
Fix the auth bug.

## Problem
Auth tokens expire incorrectly.

## Constraints
Must be backward compatible.
`;

const VALID_RESEARCH = `## Affected Code
src/auth.ts:validateToken — validates JWT tokens

## Architecture Context
- Auth middleware calls validateToken on every request

## Constraints & Edge Cases
- MUST: Existing tokens must remain valid
- RISK: Token refresh flow may break
`;

function makeValidPlan(checklist: string[]): string {
  return `# Plan

## Scope
Fix token validation in auth middleware. Does not change token format.

## Checklist
${checklist.join("\n")}
`;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pi-integration-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  menu = createAskUserHarness();
});

afterEach(() => {
  menu.assertDone();
  vi.restoreAllMocks();
  delete (globalThis as any)[Symbol.for("pi-pi:usage-tracker")];
  delete (globalThis as any)[Symbol.for("pi-lsp:api")];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePi() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler; description?: string }>();
  const tools = new Map<string, any>();

  const pi = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      }),
      emit: vi.fn((name: string, data?: any) => {
        const list = eventHandlers.get(name) ?? [];
        for (const h of list) h(data);
      }),
    },
    registerCommand: vi.fn((name: string, cmd: any) => {
      commands.set(name, cmd);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
    getAllTools: vi.fn().mockReturnValue([]),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    exec: vi.fn(async (_command?: string, _args?: string[], _options?: { cwd?: string; timeout?: number }) => ({ code: 1, stdout: "", stderr: "" })),
    _handlers: handlers,
    _eventHandlers: eventHandlers,
    _commands: commands,
    _tools: tools,
  };

  return pi;
}

function makeConfig() {
  return {
    general: {
      autoCommit: false,
      loadExtraRepoConfigs: true,
      logLevel: "info",
    },
    agents: {
      orchestrators: {
        implement: { model: "test/model", thinking: "high" },
        plan: { model: "test/model", thinking: "high" },
        debug: { model: "test/model", thinking: "high" },
        brainstorm: { model: "test/model", thinking: "high" },
        review: { model: "test/model", thinking: "high" },
      },
      subagents: {
        simple: {
          explore: { model: "test/explore", thinking: "low" },
          librarian: { model: "test/librarian", thinking: "medium" },
          task: { model: "test/task", thinking: "medium" },
        },
        presetGroups: {
          planners: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/planner", thinking: "low" } } } },
          },
          planReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
          brainstormReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
          codeReviewers: {
            default: "regular",
            presets: { regular: { enabled: true, agents: { test: { enabled: true, model: "test/reviewer", thinking: "low" } } } },
          },
        },
      },
    },
    commands: { afterEdit: {}, afterImplement: {} },
    performance: {
      commands: { afterEdit: 1000, afterImplement: 1000 },
      internals: { subagentStale: 1000, taskLockStale: 600000, taskLockRefresh: 30000 },
    },
  };
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/project",
    hasUI: true,
    ui: {
      confirm: vi.fn(),
      select: vi.fn(),
      custom: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setFooter: vi.fn(),
      input: vi.fn(),
    },
    abort: vi.fn(),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    isIdle: vi.fn().mockReturnValue(true),
    compact: vi.fn((opts?: any) => {
      if (opts?.onComplete) setTimeout(opts.onComplete, 0);
    }),
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue([
        { provider: "test", id: "model" },
      ]),
    },
    ...overrides,
  };
}

async function setupOrchestrator(cwd: string) {
  const pi = makePi();
  const orchestrator = new Orchestrator(pi as any);
  registerEventHandlers(orchestrator);
  registerCommandHandlers(orchestrator);

  const sessionStartHandler = pi._handlers.get("session_start");
  if (sessionStartHandler) {
    await sessionStartHandler({}, makeCtx({ cwd }));
  }

  return { pi, orchestrator };
}

function getCommand(pi: ReturnType<typeof makePi>, name: string): Handler {
  const cmd = pi._commands.get(name);
  if (!cmd) throw new Error(`Command ${name} not registered`);
  return cmd.handler;
}

function getTool(pi: ReturnType<typeof makePi>, name: string): any {
  const tool = pi._tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function emitSubagentCreated(pi: ReturnType<typeof makePi>, id: string, description: string) {
  pi.events.emit("subagents:created", { id, description });
}

function emitSubagentStarted(pi: ReturnType<typeof makePi>, id: string, description: string) {
  pi.events.emit("subagents:started", { id, description });
}

function emitSubagentFirstTool(pi: ReturnType<typeof makePi>, id: string, description: string, toolName = "read") {
  pi.events.emit("subagents:first_tool", { id, description, toolName });
}

function emitSubagentFirstTurn(pi: ReturnType<typeof makePi>, id: string, description: string, turnCount = 1) {
  pi.events.emit("subagents:first_turn", { id, description, turnCount });
}

function emitSubagentCompleted(pi: ReturnType<typeof makePi>, id: string, description: string) {
  pi.events.emit("subagents:completed", { id, description, result: "done" });
}

function emitSubagentFailed(pi: ReturnType<typeof makePi>, id: string, error: string) {
  pi.events.emit("subagents:failed", { id, error });
}

async function moveTaskToImplementPhase(
  pi: ReturnType<typeof makePi>,
  orchestrator: Orchestrator,
  ctx: ReturnType<typeof makeCtx>,
  firstCallId: string,
  secondCallId: string,
) {
  const taskDir = orchestrator.active!.dir;
  writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
  writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

  expectBrainstormToPlan(menu);
  const ppPhaseComplete = getTool(pi, "pp_phase_complete");
  await ppPhaseComplete.execute(firstCallId, { summary: "phase complete" }, undefined, undefined, ctx);
  await new Promise((r) => setTimeout(r, 10));

  const plansDir = join(taskDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  emitSubagentCreated(pi, `${firstCallId}-planner`, "Planner (test)");
  writeFileSync(
    join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
    makeValidPlan(["- [ ] P1. Planner output item — Done when: planner output exists"]),
    "utf-8",
  );
  emitSubagentCompleted(pi, `${firstCallId}-planner`, "Planner (test)");

  writeFileSync(
    join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
    makeValidPlan(["- [x] P1. Ready to implement — Done when: item is checked"]),
    "utf-8",
  );

  expectPlanToImplement(menu);
  await ppPhaseComplete.execute(secondCallId, { summary: "plan complete" }, undefined, undefined, ctx);
  await new Promise((r) => setTimeout(r, 10));
}

describe("implement pipeline: brainstorm → plan → implement → done", () => {
  it("walks through the full implement pipeline with phase transitions", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Add feature X");

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.state.step).toBe("llm_work");
    expect(orchestrator.active!.type).toBe("implement");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result1 = await ppPhaseComplete.execute("call-1", { summary: "Research complete" }, undefined, undefined, ctx);
    expect(result1.content[0].text).toBeDefined();

    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("plan");

    const plansDir = join(taskDir, "plans");
    expect(existsSync(plansDir)).toBe(true);

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan([
        "- [ ] P1. Draft implementation step — Done when: first proposed step is documented",
        "- [ ] P2. Draft verification step — Done when: second proposed step is documented",
      ]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    expect(orchestrator.active!.state.step).toBe("synthesize");

    const synthPath = join(plansDir, `${Math.floor(Date.now() / 1000)}_synthesized.md`);
    writeFileSync(
      synthPath,
      makeValidPlan([
        "- [ ] P1. Implement X — Done when: implementation for X is complete",
        "- [ ] P2. Implement Y — Done when: implementation for Y is complete",
      ]),
      "utf-8",
    );

    expectPlanToImplement(menu);

    const result2 = await ppPhaseComplete.execute("call-2", { summary: "Plan synthesized" }, undefined, undefined, ctx);
    expect(result2.content[0]).toBeDefined();

    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");
    expect(orchestrator.active!.state.step).toBe("llm_work");

    const synthContent = readFileSync(synthPath, "utf-8");
    writeFileSync(synthPath, synthContent.replace(/- \[ \]/g, "- [x]"), "utf-8");

    expectImplementToDone(menu);

    const result3 = await ppPhaseComplete.execute("call-3", { summary: "All items implemented" }, undefined, undefined, ctx);
    expect(result3.content[0]).toBeDefined();

    expect(orchestrator.active).toBeNull();

    const finalState = loadTask(taskDir);
    expect(finalState.phase).toBe("done");
  });

  it("blocks brainstorm→plan transition without artifacts", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test task");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Transition blocked");
    expect(result.content[0].text).toContain("USER_REQUEST.md");
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
  });

  it("blocks implement→done transition with unchecked items", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test task");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [ ] P1. Unchecked item — Done when: this item remains unchecked"]),
      "utf-8",
    );

    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    const transition = await orchestrator.transitionToNextPhase(ctx as any);

    expect(transition.ok).toBe(false);
    expect(transition.error).toContain("plan items still unchecked");
    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.phase).toBe("implement");
  });
});

describe("review cycle lifecycle", () => {
  it("auto review cycle: spawn → complete → apply_feedback → user gate", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test review");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    expectReviewAuto(menu);
    const result = await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Waiting for reviewers");

    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(["await_reviewers", "apply_feedback"]).toContain(orchestrator.active!.state.reviewCycle!.step);
    expect(orchestrator.active!.state.reviewCycle!.pass).toBe(1);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "LGTM", "utf-8");

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");
    expect(orchestrator.active!.state.step).toBe("apply_feedback");

    expectImplementToDone(menu);
    const result4 = await ppPhaseComplete.execute("call-4", { summary: "feedback applied" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(result4.content[0].text).toBe("");

    const finalState = loadTask(taskDir);
    expect(finalState.phase).toBe("done");
    expect(finalState.reviewPass).toBe(0);
    expect(finalState.reviewCycle).toBeNull();
  });

  it("review cycle completes even when all reviewers fail", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test failure");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );
    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expectReviewAuto(menu);
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentFailed(pi, "reviewer-1", "model error");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");
  });

  it("zero enabled reviewers returns error without stalling", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test no reviewers");
    orchestrator.config = {
      ...orchestrator.config,
      agents: {
        ...orchestrator.config.agents,
        subagents: {
          ...orchestrator.config.agents.subagents,
          presetGroups: {
            ...orchestrator.config.agents.subagents.presetGroups,
            codeReviewers: {
              ...orchestrator.config.agents.subagents.presetGroups.codeReviewers,
              presets: {
                ...orchestrator.config.agents.subagents.presetGroups.codeReviewers.presets,
                regular: { enabled: true, agents: {} },
              },
            },
          },
        },
      },
    } as any;
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );
    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expectReviewAuto(menu);
    expectReviewOnMyOwn(menu);
    const result = await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.reviewCycle).toBeNull();
  });
});

describe("subagent instrumentation", () => {
  it("tracks created started and first progress milestones for spawned agents", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Trace agents");

    emitSubagentCreated(pi, "explore-1", "Explore agent");
    expect(orchestrator.agentLifecycle.get("explore-1")?.createdAt).toBeTypeOf("number");
    expect(orchestrator.agentLifecycle.get("explore-1")?.phase).toBe("brainstorm");
    const debugLogPath = join(taskLogsDir(orchestrator.active!.dir), "debug.jsonl");
    expect(existsSync(debugLogPath)).toBe(true);

    emitSubagentStarted(pi, "explore-1", "Explore agent");
    expect(orchestrator.agentLifecycle.get("explore-1")?.startedAt).toBeTypeOf("number");

    emitSubagentFirstTool(pi, "explore-1", "Explore agent", "grep");
    expect(orchestrator.agentLifecycle.get("explore-1")?.firstToolAt).toBeTypeOf("number");

    emitSubagentFirstTurn(pi, "explore-1", "Explore agent", 1);
    expect(orchestrator.agentLifecycle.get("explore-1")?.firstTurnAt).toBeTypeOf("number");

    emitSubagentCompleted(pi, "explore-1", "Explore agent");
    expect(orchestrator.agentLifecycle.has("explore-1")).toBe(false);
  });
});

describe("subagent tracking", () => {
  it("blocks pp_phase_complete while subagents are running", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test blocking");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    emitSubagentCreated(pi, "explore-1", "Explore agent");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("subagent(s) still running");
  });

  it("pendingSubagentSpawns blocks pp_phase_complete", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test pending");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    orchestrator.pendingSubagentSpawns = 2;

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("subagent(s) still running");
  });

  it("abortAllSubagents resets pendingSubagentSpawns", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);

    orchestrator.spawnedAgentIds.add("agent-1");
    orchestrator.pendingSubagentSpawns = 3;

    orchestrator.abortAllSubagents();

    expect(orchestrator.spawnedAgentIds.size).toBe(0);
    expect(orchestrator.pendingSubagentSpawns).toBe(0);
  });
});

describe("standalone brainstorm", () => {
  it("can finish without artifacts (escape hatch)", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");

    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.type).toBe("brainstorm");

    expectImplementToDone(menu);

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "Explored ideas" }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("");

    expect(orchestrator.active).toBeNull();
  });

  it("offers 'Start implementation' when artifacts exist", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    menu
      .expect({ question: m.anyTaskMenu, options: { include: ["Next"] }, choose: "Next" })
      .expect({ question: "Next", options: { include: ["Continue to plan & implement"] }, choose: "Continue to plan & implement" })
      .expect({ question: "Mode", options: { include: ["Guided", "Autonomous", "Back"] }, choose: "Guided" })
      .expect({ question: "Planner preset", options: { include: [m.preset("regular"), "Back"] }, choose: m.preset("regular") });

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "Conclusions ready" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.type).toBe("brainstorm");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
  });
});

describe("debug flow", () => {
  it("finishes debug and can start implementation", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Fix timeout bug");

    expect(orchestrator.active!.state.phase).toBe("debug");
    expect(orchestrator.active!.type).toBe("debug");

    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "Diagnosis complete" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.type).toBe("debug");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
  });
});

describe("planner completion tracking", () => {
  it("transitions await_planners → synthesize when all planners complete", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test planners");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    expect(orchestrator.pendingSubagentSpawns).toBe(0);

    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Plan content item — Done when: planner plan is written"]),
      "utf-8",
    );

    emitSubagentCompleted(pi, "planner-1", "Planner (test)");
    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("transitions await_planners → synthesize when planner fails", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test planner fail");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    emitSubagentFailed(pi, "planner-1", "model error");

    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("plan transition sets await_planners before compaction callback runs", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const compactCallbacks: Array<() => void> = [];
    const ctx = makeCtx({
      compact: vi.fn((opts?: any) => {
        if (opts?.onComplete) compactCallbacks.push(opts.onComplete);
      }),
    });

    await orchestrator.startTask(ctx as any, "implement", "Test task");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(compactCallbacks).toHaveLength(1);

    compactCallbacks[0]!();
    await new Promise((r) => setTimeout(r, 10));

    const planBeginMessages = pi.sendUserMessage.mock.calls.filter(
      (c: any[]) => c[0] === "[PI-PI] Entered plan phase. Begin working.",
    );
    expect(planBeginMessages).toHaveLength(0);
  });

  it("shows planner failure dialog and can proceed with available outputs", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test planner dialog");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );

    orchestrator.pendingSubagentSpawns = 0;
    orchestrator.failedPlannerVariants = ["test"];
    orchestrator.lastCtx = ctx;
    menu.expect({
      question: /Some planners failed:/,
      options: {
        exact: ["Retry failed planners", "Work with available planner outputs", "Stop task"],
      },
      choose: "Work with available planner outputs",
    });

    emitSubagentCompleted(pi, "planner-1", "Planner (test)");
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.step).toBe("synthesize");
    expect(orchestrator.failedPlannerVariants).toEqual([]);
  });
});

describe("reviewer failure handling", () => {
  it("shows reviewer failure dialog and can skip review", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test reviewer dialog");
    const taskDir = orchestrator.active!.dir;

    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "await_reviewers";
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "await_reviewers", pass: 1 };
    saveTask(taskDir, orchestrator.active!.state);

    orchestrator.pendingSubagentSpawns = 0;
    orchestrator.failedReviewerVariants = ["test"];
    orchestrator.lastCtx = ctx;
    menu.expect({
      question: /Some reviewers failed:/,
      options: {
        exact: ["Retry failed reviewers", "Work with available reviewer outputs", "Continue without review", "Stop task"],
      },
      choose: "Continue without review",
    });

    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.reviewCycle).toBeNull();
    expect(orchestrator.active!.state.step).toBe("user_gate");
    expect(orchestrator.failedReviewerVariants).toEqual([]);
  });
});

describe("pp:done cancellation", () => {
  it("marks task done and cleans up", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test done");
    const taskDir = orchestrator.active!.dir;

    expectImplementToDone(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    const state = loadTask(taskDir);
    expect(state.phase).toBe("done");
  });
});

describe("edge cases and regressions", () => {
  it("pp_register_repo returns error for non-git path", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "register non git");

    const ppRegisterRepo = getTool(pi, "pp_register_repo");
    const result = await ppRegisterRepo.execute("call-non-git", { path: join(cwd, "not-a-repo") });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not a git repository");
  });

  it("pp_register_repo resolves nested path to git root", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();
    const repoDir = join(cwd, "extra-repo");
    const nestedPath = join(repoDir, "src", "index.ts");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(nestedPath, "export const nested = true;\n", "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "register nested");

    pi.exec.mockImplementation(async (command?: string, args?: string[]) => {
      if (command === "git" && args?.[0] === "rev-parse" && args?.[1] === "--show-toplevel") {
        return { code: 0, stdout: `${repoDir}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unsupported" };
    });

    const ppRegisterRepo = getTool(pi, "pp_register_repo");
    const result = await ppRegisterRepo.execute("call-nested", { path: nestedPath });

    expect(result.content[0].text).toContain(`Registered repository: ${repoDir}`);
    expect(orchestrator.active!.state.repos?.some((repo) => repo.path === repoDir)).toBe(true);
  });

  it("pp_register_repo updates root baseBranch", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "register root");

    pi.exec.mockImplementation(async (command?: string, args?: string[]) => {
      if (command === "git" && args?.[0] === "rev-parse" && args?.[1] === "--show-toplevel") {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unsupported" };
    });

    const ppRegisterRepo = getTool(pi, "pp_register_repo");
    const result = await ppRegisterRepo.execute("call-root", { path: cwd, baseBranch: "origin/main" });

    expect(result.content[0].text).toContain("Updated repository");
    expect(orchestrator.active!.state.repos?.find((repo) => repo.isRoot)?.baseBranch).toBe("origin/main");
  });

  it("pp_register_repo adds extra repo and does not duplicate on repeat", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();
    const repoDir = join(cwd, "extra-repo");
    mkdirSync(repoDir, { recursive: true });

    await orchestrator.startTask(ctx as any, "implement", "register dedupe");

    pi.exec.mockImplementation(async (command?: string, args?: string[]) => {
      if (command === "git" && args?.[0] === "rev-parse" && args?.[1] === "--show-toplevel") {
        return { code: 0, stdout: `${repoDir}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unsupported" };
    });

    const ppRegisterRepo = getTool(pi, "pp_register_repo");
    await ppRegisterRepo.execute("call-extra-1", { path: repoDir, baseBranch: "origin/main" });
    const second = await ppRegisterRepo.execute("call-extra-2", { path: repoDir, baseBranch: "origin/main" });

    const repos = orchestrator.active!.state.repos ?? [];
    expect(repos.filter((repo) => repo.path === repoDir)).toHaveLength(1);
    expect(second.content[0].text).toContain("Already registered repository");
  });

  it("pp_register_repo deduplicates entries and updates baseBranch", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Repo registration test");

    const repoDir = join(cwd, "extra-repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");

    pi.exec.mockImplementation(async (command?: string, args?: string[], options?: { cwd?: string }) => {
      if (!command || !args) {
        return { code: 1, stdout: "", stderr: "unsupported" };
      }
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: `${repoDir}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unsupported" };
    });

    const { registerCbmTools } = await import("./cbm.js");
    const cbmCallsBefore = (registerCbmTools as any).mock.calls.length;

    const ppRegisterRepo = getTool(pi, "pp_register_repo");
    await ppRegisterRepo.execute("call-1", { path: repoDir, baseBranch: "origin/main" });
    await ppRegisterRepo.execute("call-2", { path: join(repoDir, "src", "index.ts"), baseBranch: "origin/develop" });

    const repos = orchestrator.active!.state.repos ?? [];
    const extraRepos = repos.filter((repo) => repo.path === repoDir);

    expect(extraRepos).toHaveLength(1);
    expect(extraRepos[0]?.baseBranch).toBe("origin/develop");
    expect((registerCbmTools as any).mock.calls.length).toBe(cbmCallsBefore);
  });

  it("starting new task while another is active finishes the old one", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "First task");
    const firstDir = orchestrator.active!.dir;

    await orchestrator.startTask(ctx as any, "implement", "Second task");
    const secondDir = orchestrator.active!.dir;

    expect(firstDir).not.toBe(secondDir);
    expect(orchestrator.active!.description).toBe("Second task");

    const firstState = loadTask(firstDir);
    expect(firstState.phase).toBe("brainstorm");
  });

  it("pp:done during review cycle cleans up properly", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Test review done");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );
    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expectReviewAuto(menu);
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "LGTM", "utf-8");
    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(["await_reviewers", "apply_feedback"]).toContain(orchestrator.active!.state.reviewCycle!.step);

    expectImplementToDone(menu);
    await ppPhaseComplete.execute("call-4", { summary: "done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(orchestrator.spawnedAgentIds.size).toBe(0);
    expect(orchestrator.pendingSubagentSpawns).toBe(0);
  });

  it("multiple review passes increment reviewPass correctly", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Multi-review test");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );
    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(orchestrator.active!.state.phase).toBe("implement");

    expectReviewAuto(menu);
    await ppPhaseComplete.execute("call-3", { summary: "implemented" }, undefined, undefined, ctx);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "Needs fixes", "utf-8");

    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewCycle!.step).toBe("apply_feedback");

    expectReviewAuto(menu);
    await ppPhaseComplete.execute("call-4", { summary: "fixes applied" }, undefined, undefined, ctx);

    expect(orchestrator.active!.state.reviewPass).toBe(1);
    expect(orchestrator.active!.state.reviewPassByKind?.implement?.auto).toBe(1);
    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(orchestrator.active!.state.reviewCycle!.pass).toBe(2);

    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-2.md`), "LGTM", "utf-8");

    emitSubagentCreated(pi, "reviewer-2", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-2", "Code reviewer (test)");

    expectImplementToDone(menu);
    const result = await ppPhaseComplete.execute("call-5", { summary: "all good" }, undefined, undefined, ctx);

    expect(result.content[0].text).toBe("");
    expect(orchestrator.active).toBeNull();

    const finalState = loadTask(taskDir);
    expect(finalState.reviewPass).toBe(1);
    expect(finalState.reviewCycle).toBeNull();
  });

  it("continue brainstorming sets step back to llm_work", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Continue test");

    expectReviewOnMyOwn(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "not done yet" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("brainstorm");
    expect(orchestrator.active!.state.step).toBe("llm_work");
  });

  it("continue implementation sets step back to llm_work", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Continue impl test");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [ ] P1. Todo item — Done when: item intentionally remains unchecked"]),
      "utf-8",
    );
    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("call-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expectReviewOnMyOwn(menu);
    const result = await ppPhaseComplete.execute("call-3", { summary: "partial work" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("implement");
    expect(orchestrator.active!.state.step).toBe("llm_work");
  });

  it("review on my own sets step back to synthesize for plan phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Review own plan");
    const taskDir = orchestrator.active!.dir;

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    emitSubagentCreated(pi, "planner-1", "Planner (test)");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner draft item — Done when: planner output exists"]),
      "utf-8",
    );
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    writeFileSync(
      join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`),
      makeValidPlan(["- [ ] P1. Todo item — Done when: item intentionally remains unchecked"]),
      "utf-8",
    );

    expectReviewOnMyOwn(menu);
    const result = await ppPhaseComplete.execute("call-2", { summary: "plan ready" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("continue");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("generic description task does not auto-trigger agent", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement");

    expect(ctx.ui.notify).toHaveBeenCalledWith("Task created. Describe what you'd like to do.", "info");
    const sendUserCalls = pi.sendUserMessage.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("Begin working"),
    );
    expect(sendUserCalls.length).toBe(0);
  });

  it("implement --from debug skips brainstorm", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "Fix it", debugDir, true);

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(existsSync(join(orchestrator.active!.dir, "USER_REQUEST.md"))).toBe(true);
    expect(existsSync(join(orchestrator.active!.dir, "RESEARCH.md"))).toBe(true);
  });

  it("implement --from debug with generic description skips blank-task prompt", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "implement", debugDir, true);

    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Task created. Describe what you'd like to do.", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
    expect(orchestrator.active!.state.step).toBe("await_planners");
  });

  it("implement --from brainstorm also skips brainstorm and enters plan deterministically", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");
    const brainstormDir = orchestrator.active!.dir;
    writeFileSync(join(brainstormDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(brainstormDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "implement", brainstormDir, true);

    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Task created. Describe what you'd like to do.", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
    expect(existsSync(join(orchestrator.active!.dir, "USER_REQUEST.md"))).toBe(true);
    expect(existsSync(join(orchestrator.active!.dir, "RESEARCH.md"))).toBe(true);
  });

  it("implement from debug task stores source path and skips brainstorm", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "implement", debugDir, true);

    expect(orchestrator.active!.type).toBe("implement");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(orchestrator.active!.state.from).toBe(`debug/${debugDir.split("/").pop()}`);
    expect(orchestrator.active!.state.description).toBe("implement");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
  });

  it("implement from brainstorm task stores source path and skips brainstorm", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "Explore ideas");
    const brainstormDir = orchestrator.active!.dir;
    writeFileSync(join(brainstormDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(brainstormDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask(ctx as any, "implement", "implement", brainstormDir, true);

    expect(orchestrator.active!.type).toBe("implement");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(orchestrator.active!.state.from).toBe(`brainstorm/${brainstormDir.split("/").pop()}`);
    expect(orchestrator.active!.state.description).toBe("implement");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Entered plan phase. Waiting for planners to complete before synthesis.", "info");
  });

  it("normalizes legacy planning phase state to plan on load", async () => {
    const cwd = makeTempDir();
    const taskDir = createTask(cwd, "implement", "Legacy task");
    const legacyState = loadTask(taskDir);
    legacyState.phase = "planning" as any;
    saveTask(taskDir, legacyState);

    const normalized = loadTask(taskDir);

    expect(normalized.phase).toBe("plan");
  });
});

describe("task modes and quick task", () => {
  it("quick task lifecycle completes via pp_phase_complete menu", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "quick", "quick");
    const taskDir = orchestrator.active!.dir;

    expectQuickMenu(menu, "Complete");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);

    expect(result.content[0].text).toBeDefined();
    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("quick task /pp menu shows quick options", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "quick", "quick");
    menu.expect({ question: m.taskMenu("quick", "quick"), options: { include: ["Complete", "Pause"], exclude: ["Next", "Review"] }, choose: "Back" });
    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("mode picker stores autonomous mode in task state", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    expectPpStartImplementAutonomous(menu);
    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.mode).toBe("autonomous");
    expect(orchestrator.active!.state.autonomousConfig).toBeDefined();
  });

  it("autonomous pp_phase_complete auto-advances without opening menu", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        brainstorm: { reviewPreset: "regular", maxReviewPasses: 0 },
        plan: { plannerPreset: "regular", reviewPreset: "regular", maxReviewPasses: 0 },
        implement: { reviewPreset: "regular", maxReviewPasses: 0 },
      },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(result.content[0].text).toBe("");
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(menu.transcript.filter((entry) => entry.question.startsWith("/pp"))).toHaveLength(0);
  });

  it("autonomous review loop re-runs until cap then advances", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.reviewPass = 0;
    orchestrator.active!.state.reviewPassByKind = {};
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        implement: { reviewPreset: "regular", maxReviewPasses: 2 },
      },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "1_synthesized.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });

    // Pass 1: non-clean review (no APPROVE) below cap — must force apply+re-review, NOT advance.
    const first = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(first.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);
    writeFileSync(join(reviewsDir, `1_test_round-1.md`), "- CRITICAL: fix this\n- VERDICT: NEEDS_CHANGES", "utf-8");
    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    const second = await ppPhaseComplete.execute("call-2", { summary: "applied" }, undefined, undefined, ctx);
    expect(second.content[0].text).toMatch(/Apply the reviewers' required changes/);
    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.phase).toBe("implement");

    // Pass 2 (= cap): non-clean again, but at maxReviewPasses — cap honored, advances to done.
    const third = await ppPhaseComplete.execute("call-3", { summary: "redo" }, undefined, undefined, ctx);
    expect(third.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);
    writeFileSync(join(reviewsDir, `2_test_round-2.md`), "- CRITICAL: still\n- VERDICT: NEEDS_CHANGES", "utf-8");
    emitSubagentCreated(pi, "reviewer-2", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-2", "Code reviewer (test)");

    const fourth = await ppPhaseComplete.execute("call-4", { summary: "applied 2" }, undefined, undefined, ctx);
    expect(fourth.content[0].text).toBe("");
    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("autonomous review early-exits on unanimous approval before reaching the cap", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.reviewPass = 0;
    orchestrator.active!.state.reviewPassByKind = {};
    orchestrator.active!.state.autonomousConfig = {
      phases: { implement: { reviewPreset: "regular", maxReviewPasses: 3 } },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "1_synthesized.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const first = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(first.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const round = orchestrator.active!.state.reviewCycle!.pass;
    for (const v of ["opus", "gpt", "gemini"]) {
      writeFileSync(join(reviewsDir, `1_${v}_round-${round}.md`), "VERDICT: APPROVE\n- CRITICAL: none", "utf-8");
    }
    emitSubagentCreated(pi, "reviewer-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    const second = await ppPhaseComplete.execute("call-2", { summary: "applied" }, undefined, undefined, ctx);
    expect(second.content[0].text).toBe("");
    expect(orchestrator.active).toBeNull();
    const finalState = loadTask(taskDir);
    expect(finalState.phase).toBe("done");
    // Issue 4: review bookkeeping is cleared on the transition to done.
    expect(finalState.reviewCycle).toBeNull();
    // Early exit: only one auto pass ran (cap was 3), proving the clean APPROVE short-circuited.
    expect(finalState.reviewPassByKind?.implement?.auto).toBe(1);
  });

  it("clean-approved review is not re-run on a later checklist-repair re-entry", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.reviewPass = 1;
    orchestrator.active!.state.reviewPassByKind = { implement: { auto: 1 } };
    orchestrator.active!.state.reviewApprovedClean = true;
    orchestrator.active!.state.autonomousConfig = {
      phases: { implement: { reviewPreset: "regular", maxReviewPasses: 3 } },
    };
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "1_synthesized.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-1", { summary: "checklist repaired" }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("");
    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("autonomous review runs another pass when a reviewer reports a CRITICAL finding", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.reviewPass = 1;
    orchestrator.active!.state.reviewPassByKind = { implement: { auto: 1 } };
    orchestrator.active!.state.autonomousConfig = {
      phases: { implement: { reviewPreset: "regular", maxReviewPasses: 3 } },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "1_synthesized.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "1_a_round-1.md"), "- CRITICAL: bug at x.ts:1\n- VERDICT: NEEDS_CHANGES", "utf-8");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const next = await ppPhaseComplete.execute("call-1", { summary: "fixes applied, re-review" }, undefined, undefined, ctx);
    expect(orchestrator.active!.state.reviewApprovedClean).toBeFalsy();
    expect(next.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);
    expect(orchestrator.active!.state.reviewCycle!.pass).toBe(2);
  });

  it("autonomous implement blocks review until exit criteria pass", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.reviewPass = 0;
    orchestrator.active!.state.reviewPassByKind = {};
    orchestrator.active!.state.autonomousConfig = {
      phases: { implement: { reviewPreset: "regular", maxReviewPasses: 3 } },
    };
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "1_synthesized.md"),
      makeValidPlan(["- [ ] P1. Unchecked item — Done when: this is checked"]),
      "utf-8",
    );

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const first = await ppPhaseComplete.execute("call-1", { summary: "done" }, undefined, undefined, ctx);
    expect(first.content[0].text).toMatch(/Cannot start review yet/);
    expect(orchestrator.active!.state.step).not.toBe("await_reviewers");
    expect(orchestrator.active!.state.phase).toBe("implement");
  });

  it("autonomous planner retries failed variants once even with partial outputs", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "await_planners";
    orchestrator.active!.state.plannerFailureAutoRetried = false;
    saveTask(taskDir, orchestrator.active!.state);
    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), "draft", "utf-8");

    orchestrator.failedPlannerVariants = ["test"];
    orchestrator.pendingSubagentSpawns = 0;
    emitSubagentCompleted(pi, "planner-1", "Planner (test)");

    expect(orchestrator.active!.state.plannerFailureAutoRetried).toBe(true);
  });

  it("autonomous reviewer retries failed variants once even with partial outputs", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "await_reviewers";
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "await_reviewers", pass: 1 };
    orchestrator.active!.state.reviewerFailureAutoRetried = false;
    saveTask(taskDir, orchestrator.active!.state);
    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "partial", "utf-8");

    orchestrator.failedReviewerVariants = ["test"];
    orchestrator.pendingSubagentSpawns = 0;
    emitSubagentCompleted(pi, "reviewer-1", "Code reviewer (test)");

    expect(orchestrator.active!.state.reviewerFailureAutoRetried).toBe(true);
  });

  it("mode picker Back returns to previous menu and does not start guided task", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Implement"] }, choose: "Implement" })
      .expect({ question: "Implement", options: { include: ["New"] }, choose: "New" })
      .expect({ question: "Mode", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "Implement", options: { include: ["Resume", "Back"] }, choose: "Resume" })
      .expect({ question: "Implement", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "Task", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });
    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(orchestrator.active).toBeNull();
  });

  it("brainstorm continue uses implement autonomous phase defaults", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "brainstorm", "brainstorm");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    menu
      .expect({ question: m.anyTaskMenu, options: { include: ["Next"] }, choose: "Next" })
      .expect({ question: "Next", options: { include: ["Continue to plan & implement"] }, choose: "Continue to plan & implement" })
      .expect({ question: "Mode", options: { include: ["Autonomous"] }, choose: "Autonomous" })
      .expect({ question: "Autonomous", options: { include: ["Start"] }, choose: "Start" });
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-1", { summary: "Conclusions ready" }, undefined, undefined, ctx);

    expect(orchestrator.active!.state.autonomousConfig?.phases.plan).toBeDefined();
    expect(orchestrator.active!.state.autonomousConfig?.phases.implement).toBeDefined();
    expect(orchestrator.active!.state.autonomousConfig?.phases.brainstorm).toBeUndefined();
  });

  it("from-task implement sets initialPhase plan and ask_user is blocked in autonomous plan", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", debugDir, true, "autonomous");
    expect(orchestrator.active!.state.initialPhase).toBe("plan");
    expect(orchestrator.active!.state.phase).toBe("plan");

    const toolCall = pi._handlers.get("tool_call")!;
    const result = await toolCall({ toolName: "ask_user", input: {} }, {});
    expect(result).toEqual({ block: true, reason: "Autonomous mode — make your best judgment based on available context." });
  });

  it("autonomous prompt is full-replace with constraints first and mode-aware completion", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask({ ...ctx, cwd } as any, "debug", "Find bug");
    const debugDir = orchestrator.active!.dir;
    writeFileSync(join(debugDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(debugDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    await orchestrator.startTask({ ...ctx, cwd } as any, "implement", "implement", debugDir, true, "autonomous");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";

    const beforeStart = pi._handlers.get("before_agent_start")!;
    const result = await beforeStart({ systemPrompt: "HARNESS_BASE_PROMPT" }, ctx);
    const prompt = result?.systemPrompt ?? "";
    expect(prompt.startsWith("<constraints>")).toBe(true);
    expect(prompt).not.toContain("HARNESS_BASE_PROMPT");
    expect(prompt).toContain("The moment its work is complete, call pp_phase_complete");
    // No interactive '/pp menu' advance guidance in autonomous mode.
    expect(prompt).not.toContain("/pp menu");
    expect(prompt).not.toContain("advance it via");
  });

  it("guided read-only phase prompt is XML macro-blocks with month/year + cwd and interactive completion", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask({ ...ctx, cwd } as any, "implement", "implement", undefined, undefined, "guided");
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "synthesize";

    const beforeStart = pi._handlers.get("before_agent_start")!;
    const prompt = (await beforeStart({ systemPrompt: "HARNESS_BASE_PROMPT" }, ctx))?.systemPrompt ?? "";
    expect(prompt.startsWith("<constraints>")).toBe(true);
    expect(prompt).toContain("ACTIVE PHASE: plan (READ-ONLY)");
    expect(prompt).toContain("<principles>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("let the user review and advance it via the /pp menu");
    expect(prompt).not.toContain("HARNESS_BASE_PROMPT");
    expect(prompt).toContain(`Working directory: ${cwd}.`);
    expect(prompt).toMatch(/Current month: \d{4}-\d{2}\./);
  });

  it("first phase of an autonomous task stays interactive (ask_user allowed, interactive prompt)", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask({ ...ctx, cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    // Task starts at its first phase (brainstorm) with task mode = autonomous.
    expect(orchestrator.active!.state.phase).toBe("brainstorm");

    const toolCall = pi._handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "ask_user", input: {} }, {})).toBeUndefined();

    const beforeStart = pi._handlers.get("before_agent_start")!;
    const prompt = (await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt ?? "";
    expect(prompt).not.toContain("There is no user driving this phase");

    // Later autonomous phase (implement) is forcing and blocks ask_user.
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    expect(await toolCall({ toolName: "ask_user", input: {} }, {})).toEqual({
      block: true,
      reason: "Autonomous mode — make your best judgment based on available context.",
    });
    const implPrompt = (await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt ?? "";
    expect(implPrompt).toContain("There is no user driving this phase");
  });

  it("quick task completion line tells the agent to call pp_phase_complete", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask({ ...ctx, cwd } as any, "quick", "quick");
    expect(orchestrator.active!.state.phase).toBe("quick");

    const beforeStart = pi._handlers.get("before_agent_start")!;
    const prompt = (await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt ?? "";
    expect(prompt).toContain("call pp_phase_complete");
    expect(prompt).not.toContain("advance it via the /pp menu");
  });

  it("autonomous plan-phase prompt body contains no /pp guidance", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask({ ...ctx, cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "synthesize";

    const beforeStart = pi._handlers.get("before_agent_start")!;
    const prompt = (await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt ?? "";
    expect(prompt).not.toContain("/pp");
  });

  it("persists retry bookkeeping flags in task state", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    const state = loadTask(taskDir);
    expect(state.plannerFailureAutoRetried).toBe(false);
    expect(state.reviewerFailureAutoRetried).toBe(false);
  });

  it("blocks ask_user in autonomous mode after first phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "plan";
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "ask_user", input: {} }, {});
    expect(result).toEqual({ block: true, reason: "Autonomous mode — make your best judgment based on available context." });
  });

  it("blocks ask_user whenever effective mode is autonomous", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "implement";
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "ask_user", input: {} }, {});
    expect(result).toEqual({ block: true, reason: "Autonomous mode — make your best judgment based on available context." });
  });

  it("resume preserves autonomous mode", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const title = "implement";
    const pp = getCommand(pi, "pp");
    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Resume"] }, choose: "Resume" })
      .expect({ question: "Resume", options: { include: [title] }, choose: title });
    await pp(undefined, ctx);

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.mode).toBe("autonomous");
  });

  it("resume preserves autonomousConfig", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "resume autonomous config", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        brainstorm: { reviewPreset: "regular", maxReviewPasses: 1 },
        plan: { plannerPreset: "regular", reviewPreset: "regular", maxReviewPasses: 2 },
        implement: { reviewPreset: "regular", maxReviewPasses: 3 },
      },
    };
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const pp = getCommand(pi, "pp");
    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Resume"] }, choose: "Resume" })
      .expect({ question: "Resume", options: { include: ["resume autonomous config"] }, choose: "resume autonomous config" });
    await pp(undefined, ctx);

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.autonomousConfig).toEqual({
      phases: {
        brainstorm: { reviewPreset: "regular", maxReviewPasses: 1 },
        plan: { plannerPreset: "regular", reviewPreset: "regular", maxReviewPasses: 2 },
        implement: { reviewPreset: "regular", maxReviewPasses: 3 },
      },
    });
  });

  it("autonomous mode skips planner preset picker during transition", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        brainstorm: { reviewPreset: "regular", maxReviewPasses: 0 },
        plan: { plannerPreset: "regular", reviewPreset: "regular", maxReviewPasses: 0 },
        implement: { reviewPreset: "regular", maxReviewPasses: 0 },
      },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-autonomous-skip-planner", { summary: "done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(menu.transcript.filter((entry) => entry.question.includes("Planner preset"))).toHaveLength(0);
  });

  it("autonomous first review triggers automatically and second step proceeds after reviewer output", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        implement: { reviewPreset: "regular", maxReviewPasses: 2 },
      },
    };
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    mkdirSync(join(taskDir, "plans"), { recursive: true });
    writeFileSync(
      join(taskDir, "plans", "1_synthesized.md"),
      makeValidPlan(["- [x] P1. Done item — Done when: synthesized plan is fully checked"]),
      "utf-8",
    );

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const first = await ppPhaseComplete.execute("call-autonomous-review-1", { summary: "done" }, undefined, undefined, ctx);
    expect(first.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);
    expect(orchestrator.active!.state.reviewCycle).not.toBeNull();
    expect(orchestrator.active!.state.reviewCycle?.pass).toBe(1);
    expect(["await_reviewers", "apply_feedback"]).toContain(orchestrator.active!.state.reviewCycle?.step);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    for (const v of ["opus", "gpt", "gemini"]) {
      writeFileSync(join(reviewsDir, `1_${v}_round-1.md`), "VERDICT: APPROVE\n- CRITICAL: none", "utf-8");
    }
    emitSubagentCreated(pi, "reviewer-auto-1", "Code reviewer (test)");
    emitSubagentCompleted(pi, "reviewer-auto-1", "Code reviewer (test)");

    const second = await ppPhaseComplete.execute("call-autonomous-review-2", { summary: "applied" }, undefined, undefined, ctx);
    expect(second.content[0].text).toBe("");
    expect(orchestrator.active).toBeNull();
  });

  it("switching to guided during await_reviewers shows reviewer failure dialog", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "implement", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "await_reviewers";
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "await_reviewers", pass: 1 };
    orchestrator.active!.state.effectiveMode = "guided";
    orchestrator.failedReviewerVariants = ["test"];
    orchestrator.pendingSubagentSpawns = 0;
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    menu.expect({
      question: /Some reviewers failed:/,
      options: {
        exact: ["Retry failed reviewers", "Work with available reviewer outputs", "Continue without review", "Stop task"],
      },
      choose: "Continue without review",
    });
    emitSubagentCompleted(pi, "reviewer-guided-switch", "Code reviewer (test)");
    await new Promise((r) => setTimeout(r, 10));

    expect(menu.transcript.some((entry) => entry.question.includes("Some reviewers failed:"))).toBe(true);
  });

  it("review task autonomous config covers only plan/implement, not the review first phase", async () => {
    const cwd = makeTempDir();
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    registerEventHandlers(orchestrator);
    registerCommandHandlers(orchestrator);
    const ctx = makeCtx({ cwd });

    const sessionStartHandler = pi._handlers.get("session_start")!;
    await sessionStartHandler({}, ctx);

    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Review"] }, choose: "Review" })
      .expect({ question: "Review", options: { include: ["Describe"] }, choose: "Describe" })
      .expect({ question: "Mode", options: { include: ["Autonomous"] }, choose: "Autonomous" })
      .expect({ question: "Autonomous", options: { include: ["Start"] }, choose: "Start" });
    ctx.ui.input.mockResolvedValueOnce("Review current branch changes");
    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(orchestrator.active!.type).toBe("review");
    expect(orchestrator.active!.state.autonomousConfig?.phases.review).toBeUndefined();
    expect(orchestrator.active!.state.autonomousConfig?.phases.implement?.reviewPreset).toBe("regular");
  });

  it("quick task does not track modified files", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "quick", "quick");
    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/quick.ts" }, isError: false, content: [] }, {});

    expect(orchestrator.active!.modifiedFiles.size).toBe(0);
    expect(orchestrator.active!.state.modifiedFiles ?? []).toEqual([]);
  });

  it("quick task does not run afterEdit", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");

    await orchestrator.startTask(makeCtx() as any, "quick", "quick");
    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/quick.ts" }, isError: false, content: [] }, {});

    expect(runAfterEditSpy).not.toHaveBeenCalled();
  });

  it("autonomous ask_user blocked in plan and implement", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask({ ...makeCtx(), cwd } as any, "implement", "implement", undefined, undefined, "autonomous");
    const toolCall = pi._handlers.get("tool_call")!;
    const blocked = { block: true, reason: "Autonomous mode — make your best judgment based on available context." };

    orchestrator.active!.state.phase = "plan";
    expect(await toolCall({ toolName: "ask_user", input: {} }, {})).toEqual(blocked);

    orchestrator.active!.state.phase = "implement";
    expect(await toolCall({ toolName: "ask_user", input: {} }, {})).toEqual(blocked);
  });
});

describe("review task lifecycle", () => {
  it("review task starts in review phase", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "review", "Review changes");

    expect(orchestrator.active!.type).toBe("review");
    expect(orchestrator.active!.state.phase).toBe("review");
    expect(orchestrator.active!.state.step).toBe("llm_work");
  });

  it("review task transitions review to plan to implement to done", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "review", "Review flow");
    const taskDir = orchestrator.active!.dir;

    await moveTaskToImplementPhase(pi, orchestrator, ctx, "call-review-to-plan", "call-plan-to-implement");
    expect(orchestrator.active!.state.phase).toBe("implement");

    expectImplementToDone(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-implement-to-done", { summary: "done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("review phase exit criteria requires USER_REQUEST and RESEARCH", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "review", "Review validation");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    const result = await ppPhaseComplete.execute("call-review-validation", { summary: "done" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Transition blocked");
    expect(result.content[0].text).toContain("USER_REQUEST.md");
    expect(orchestrator.active!.state.phase).toBe("review");
  });
});

describe("debug task lifecycle", () => {
  it("debug task starts in debug phase", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "debug", "Debug issue");

    expect(orchestrator.active!.type).toBe("debug");
    expect(orchestrator.active!.state.phase).toBe("debug");
  });

  it("debug task transitions debug to plan to implement to done", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "Debug flow");
    const taskDir = orchestrator.active!.dir;

    await moveTaskToImplementPhase(pi, orchestrator, ctx, "call-debug-to-plan", "call-debug-plan-to-implement");
    expect(orchestrator.active!.state.phase).toBe("implement");

    expectImplementToDone(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("call-debug-implement-to-done", { summary: "done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });
});

describe("modified file tracking", () => {
  it("tool_result tracks write and edit in implement phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Track writes");
    await moveTaskToImplementPhase(pi, orchestrator, ctx, "call-track-brainstorm", "call-track-plan");

    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/a.ts" }, isError: false, content: [] }, {});
    await toolResult({ toolName: "edit", input: { path: "src/b.ts" }, isError: false, content: [] }, {});

    expect(orchestrator.active!.modifiedFiles.has(join(cwd, "src", "a.ts"))).toBe(true);
    expect(orchestrator.active!.modifiedFiles.has(join(cwd, "src", "b.ts"))).toBe(true);
  });

  it("source write clears reviewApprovedClean so post-approval edits get re-reviewed", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "Stale flag");
    await moveTaskToImplementPhase(pi, orchestrator, ctx, "call-stale-brainstorm", "call-stale-plan");
    orchestrator.active!.state.reviewApprovedClean = true;

    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/c.ts" }, isError: false, content: [] }, {});

    expect(orchestrator.active!.state.reviewApprovedClean).toBe(false);
  });

  it("tool_result ignores writes inside .pp directory", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");

    await orchestrator.startTask(makeCtx() as any, "implement", "Ignore .pp writes");
    orchestrator.active!.state.phase = "implement";
    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: ".pp/state/implement/x/note.md" }, isError: false, content: [] }, {});

    expect(orchestrator.active!.modifiedFiles.size).toBe(0);
    expect(runAfterEditSpy).not.toHaveBeenCalled();
  });

  it("tool_result ignores writes outside implement phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");

    await orchestrator.startTask(makeCtx() as any, "implement", "Ignore non-implement writes");
    orchestrator.active!.state.phase = "brainstorm";
    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/not-tracked.ts" }, isError: false, content: [] }, {});

    expect(orchestrator.active!.modifiedFiles.size).toBe(0);
    expect(runAfterEditSpy).not.toHaveBeenCalled();
  });

  it("root repo edits trigger root afterEdit commands", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");
    const loadRepoAfterEditCommandsSpy = vi.spyOn(commandsModule, "loadRepoAfterEditCommands");

    await orchestrator.startTask(makeCtx() as any, "implement", "afterEdit root");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.repos = [{ path: cwd, isRoot: true }];
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "src/root.ts" }, isError: false, content: [] }, {});

    expect(runAfterEditSpy).toHaveBeenCalledTimes(1);
    expect(runAfterEditSpy.mock.calls[0]?.[0]).toBe("src/root.ts");
    expect(loadRepoAfterEditCommandsSpy).not.toHaveBeenCalled();
  });

  it("extra repo edits trigger extra repo afterEdit when extra configs are enabled", async () => {
    const cwd = makeTempDir();
    const extraRepo = join(cwd, "extra-repo");
    mkdirSync(extraRepo, { recursive: true });
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");
    const loadRepoAfterEditCommandsSpy = vi
      .spyOn(commandsModule, "loadRepoAfterEditCommands")
      .mockReturnValue({ "cmd-1": { run: "npm run lint", globs: ["**/*.ts"] } });

    await orchestrator.startTask(makeCtx() as any, "implement", "afterEdit extra");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, loadExtraRepoConfigs: true },
    } as any;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.repos = [
      { path: cwd, isRoot: true },
      { path: extraRepo, isRoot: false },
    ];
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "extra-repo/src/extra.ts" }, isError: false, content: [] }, {});

    expect(loadRepoAfterEditCommandsSpy).toHaveBeenCalledWith(extraRepo);
    expect(runAfterEditSpy).toHaveBeenCalledTimes(1);
    expect(runAfterEditSpy).toHaveBeenCalledWith(
      "src/extra.ts",
      { "cmd-1": { run: "npm run lint", globs: ["**/*.ts"] } },
      orchestrator.config.performance.commands.afterEdit,
      extraRepo,
    );
  });

  it("extra repo edits are skipped when ignoreExtraRepoConfigs is true", async () => {
    const cwd = makeTempDir();
    const extraRepo = join(cwd, "extra-repo");
    mkdirSync(extraRepo, { recursive: true });
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const runAfterEditSpy = vi.spyOn(commandsModule, "runAfterEdit");
    const loadRepoAfterEditCommandsSpy = vi.spyOn(commandsModule, "loadRepoAfterEditCommands");

    await orchestrator.startTask(makeCtx() as any, "implement", "afterEdit extra skipped");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, loadExtraRepoConfigs: false },
    } as any;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.repos = [
      { path: cwd, isRoot: true },
      { path: extraRepo, isRoot: false },
    ];
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    const toolResult = pi._handlers.get("tool_result")!;
    await toolResult({ toolName: "write", input: { path: "extra-repo/src/extra.ts" }, isError: false, content: [] }, {});

    expect(loadRepoAfterEditCommandsSpy).not.toHaveBeenCalled();
    expect(runAfterEditSpy).not.toHaveBeenCalled();
  });

  it("pp_commit with autoCommit disabled returns message", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "commit disabled");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, autoCommit: false },
    } as any;

    const ppCommit = getTool(pi, "pp_commit");
    const result = await ppCommit.execute("call-commit-disabled", { message: "msg" });

    expect(result.content[0].text).toContain("autoCommit is disabled");
  });

  it("pp_commit with no modified files returns message", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "commit empty");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, autoCommit: true },
    } as any;
    pi.exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const ppCommit = getTool(pi, "pp_commit");
    const result = await ppCommit.execute("call-commit-empty", { message: "msg" });

    expect(result.content[0].text).toContain("No modified files to commit");
  });

  it("pp_commit with unregistered repo returns error", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "commit invalid repo");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, autoCommit: true },
    } as any;

    const ppCommit = getTool(pi, "pp_commit");
    const result = await ppCommit.execute("call-commit-unregistered", {
      message: "msg",
      repo: join(cwd, "unregistered"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Repository is not registered");
  });

  it("pp_commit clears modified files after success", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const autoCommitSpy = vi.spyOn(commandsModule, "autoCommit").mockReturnValue({ ok: true, commitHash: "abc123" });
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "commit clear");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, autoCommit: true },
    } as any;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.modifiedFiles.add(join(cwd, "src", "tracked.ts"));
    orchestrator.active!.state.modifiedFiles = [...orchestrator.active!.modifiedFiles];
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    pi.exec.mockResolvedValueOnce({
      code: 0,
      stdout: " M src/tracked.ts\n",
      stderr: "",
    });

    const ppCommit = getTool(pi, "pp_commit");
    const result = await ppCommit.execute("call-pp-commit", { message: "commit files" });

    expect(result.content[0].text).toContain("Committed 1 file");
    expect(orchestrator.active!.modifiedFiles.size).toBe(0);
    expect(orchestrator.active!.state.modifiedFiles).toEqual([]);
    expect(autoCommitSpy).toHaveBeenCalled();
  });

  it("pp_commit parses renamed files and stages new path", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const autoCommitSpy = vi.spyOn(commandsModule, "autoCommit").mockReturnValue({ ok: true, commitHash: "abc123" });

    await orchestrator.startTask(makeCtx() as any, "implement", "commit rename parse");
    orchestrator.config = {
      ...orchestrator.config,
      general: { ...orchestrator.config.general, autoCommit: true },
    } as any;
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.repos = [{ path: cwd, isRoot: true }];
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    pi.exec.mockResolvedValueOnce({
      code: 0,
      stdout: "R  src/old.ts -> src/new.ts\n",
      stderr: "",
    });

    const ppCommit = getTool(pi, "pp_commit");
    const result = await ppCommit.execute("call-pp-commit-rename", { message: "rename file" });

    expect(result.content[0].text).toContain("Committed 1 file");
    expect(autoCommitSpy).toHaveBeenCalledWith(["src/new.ts"], "rename file", cwd);
  });
});

describe("resume and recovery", () => {
  it("resume paused task restores task phase and step", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "resume phase state");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "synthesize";
    orchestrator.active!.state.modifiedFiles = [join(cwd, "src", "restored.ts")];
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const pp = getCommand(pi, "pp");
    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Resume"] }, choose: "Resume" })
      .expect({ question: "Resume", options: { include: ["resume phase state"] }, choose: "resume phase state" });
    await pp(undefined, ctx);

    expect(orchestrator.active).not.toBeNull();
    expect(orchestrator.active!.state.phase).toBe("plan");
    expect(orchestrator.active!.state.step).toBe("synthesize");
    expect(orchestrator.active!.modifiedFiles.has(join(cwd, "src", "restored.ts"))).toBe(true);
  });

  it("resume prunes stale repos that no longer exist", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const staleRepo = join(cwd, "missing-repo");
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "resume stale repos");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.repos = [
      { path: cwd, isRoot: true },
      { path: staleRepo, isRoot: false },
    ];
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const pp = getCommand(pi, "pp");
    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Resume"] }, choose: "Resume" })
      .expect({ question: "Resume", options: { include: ["resume stale repos"] }, choose: "resume stale repos" });
    await pp(undefined, ctx);

    expect(orchestrator.active!.state.repos).toEqual([{ path: cwd, isRoot: true }]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pruned 1 stale repo"), "warning");
  });

  it("getActiveTask returns null when multiple unlocked tasks exist", () => {
    const cwd = makeTempDir();
    createTask(cwd, "implement", "first unlocked");
    createTask(cwd, "debug", "second unlocked");

    const active = getActiveTask(cwd);

    expect(active).toBeNull();
  });

  it("getActiveTask returns the single unlocked task", () => {
    const cwd = makeTempDir();
    const taskDir = createTask(cwd, "implement", "single unlocked");

    const active = getActiveTask(cwd);

    expect(active?.dir).toBe(taskDir);
  });
});

describe("crash resume", () => {
  it("resume in await_planners with partial plan outputs moves to synthesize when all enabled outputs exist", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "resume planners complete");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    mkdirSync(join(taskDir, "plans"), { recursive: true });
    writeFileSync(
      join(taskDir, "plans", `${Math.floor(Date.now() / 1000)}_test.md`),
      makeValidPlan(["- [ ] P1. Planner output item — Done when: planner output exists"]),
      "utf-8",
    );
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "await_planners";
    orchestrator.active!.state.activePlannerPreset = "regular";
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const result = await resumeTask(orchestrator, ctx, { dir: taskDir, state: loadTask(taskDir), type: "implement" });

    expect(result.ok).toBe(true);
    expect(orchestrator.active!.state.step).toBe("synthesize");
  });

  it("resume in await_planners with missing outputs keeps await_planners and attempts planner respawn", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "resume planners missing");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "await_planners";
    orchestrator.active!.state.activePlannerPreset = "regular";
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const result = await resumeTask(orchestrator, ctx, { dir: taskDir, state: loadTask(taskDir), type: "implement" });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.ok).toBe(true);
    expect(orchestrator.active!.state.step).toBe("await_planners");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pp-planners-error" }),
      { deliverAs: "steer" },
    );
  });

  it("resume in reviewCycle apply_feedback delivers review outputs and keeps cycle active", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "resume apply feedback");
    const taskDir = orchestrator.active!.dir;
    mkdirSync(join(taskDir, "code-reviews"), { recursive: true });
    writeFileSync(join(taskDir, "code-reviews", `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "Review note", "utf-8");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "apply_feedback";
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 1 };
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const result = await resumeTask(orchestrator, ctx, { dir: taskDir, state: loadTask(taskDir), type: "implement" });

    expect(result.ok).toBe(true);
    expect(orchestrator.active!.state.reviewCycle).toEqual({ kind: "auto", step: "apply_feedback", pass: 1 });
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pp-review-ready",
        content: expect.stringContaining("Review cycle is in apply_feedback step."),
      }),
      { deliverAs: "steer" },
    );
  });

  it("resume prunes stale repos and sends warning notification", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const staleRepo = join(cwd, "gone");
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "resume stale notify");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.repos = [
      { path: cwd, isRoot: true },
      { path: staleRepo, isRoot: false },
    ];
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const result = await resumeTask(orchestrator, ctx, { dir: taskDir, state: loadTask(taskDir), type: "implement" });

    expect(result.ok).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Pruned 1 stale repo(s) that no longer exist.", "warning");
  });

  it("resume with missing planner preset falls back to first available preset and warns", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "resume missing preset");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "await_planners";
    orchestrator.active!.state.activePlannerPreset = "nonexistent";
    saveTask(taskDir, orchestrator.active!.state);
    await orchestrator.cleanupActive();

    const result = await resumeTask(orchestrator, ctx, { dir: taskDir, state: loadTask(taskDir), type: "implement" });

    expect(result.ok).toBe(true);
    expect(orchestrator.active!.state.activePlannerPreset).toBe("regular");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Planner preset "nonexistent" not found. Falling back to "regular".',
      "warning",
    );
  });
});

describe("brainstorm and plan review cycles", () => {
  it("brainstorm review cycle reaches apply_feedback and finalizeReviewCycle returns to user_gate", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "brainstorm review cycle");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    mkdirSync(join(taskDir, "brainstorm-reviews"), { recursive: true });
    writeFileSync(
      join(taskDir, "brainstorm-reviews", `${Math.floor(Date.now() / 1000)}_test_round-1.md`),
      "Brainstorm review feedback",
      "utf-8",
    );

    const message = await enterReviewCycle(orchestrator, ctx, "regular");
    await new Promise((r) => setTimeout(r, 10));

    expect(message).toContain("Started review cycle pass 1");
    expect(orchestrator.active!.state.reviewCycle?.step).toBe("apply_feedback");
    expect(orchestrator.active!.state.step).toBe("apply_feedback");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pp-review-ready",
        content: expect.stringContaining("Brainstorm review feedback"),
      }),
      { deliverAs: "followUp" },
    );

    finalizeReviewCycle(orchestrator.active!);

    expect(orchestrator.active!.state.step).toBe("user_gate");
    expect(orchestrator.active!.state.reviewCycle).toBeNull();
    expect(orchestrator.active!.state.reviewPass).toBe(1);
  });

  it("brainstorm review-ready message names the artifacts under review, not a code diff", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "brainstorm review message");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    mkdirSync(join(taskDir, "brainstorm-reviews"), { recursive: true });
    writeFileSync(
      join(taskDir, "brainstorm-reviews", `${Math.floor(Date.now() / 1000)}_test_round-1.md`),
      "Brainstorm review feedback",
      "utf-8",
    );

    await enterReviewCycle(orchestrator, ctx, "regular");
    await new Promise((r) => setTimeout(r, 10));

    const readyMessages = (pi.sendUserMessage as any).mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((text: string) => text.includes("ready for apply_feedback"));
    expect(readyMessages.length).toBeGreaterThan(0);
    expect(readyMessages[readyMessages.length - 1]).toContain("USER_REQUEST.md");
    expect(readyMessages[readyMessages.length - 1]).toContain("RESEARCH.md");
    expect(readyMessages[readyMessages.length - 1]).toContain("artifacts/");
  });

  it("plan review cycle reaches apply_feedback and finalizeReviewCycle returns to user_gate", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "plan review cycle");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    mkdirSync(join(taskDir, "plans"), { recursive: true });
    writeFileSync(
      join(taskDir, "plans", `${Math.floor(Date.now() / 1000)}_synthesized.md`),
      makeValidPlan(["- [x] P1. Plan ready — Done when: synthesized plan exists"]),
      "utf-8",
    );
    mkdirSync(join(taskDir, "plan-reviews"), { recursive: true });
    writeFileSync(
      join(taskDir, "plan-reviews", `${Math.floor(Date.now() / 1000)}_test_round-1.md`),
      "Plan review feedback",
      "utf-8",
    );
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "synthesize";
    saveTask(taskDir, orchestrator.active!.state);

    const message = await enterReviewCycle(orchestrator, ctx, "regular");
    await new Promise((r) => setTimeout(r, 10));

    expect(message).toContain("Started review cycle pass 1");
    expect(orchestrator.active!.state.reviewCycle?.step).toBe("apply_feedback");
    expect(orchestrator.active!.state.step).toBe("apply_feedback");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pp-review-ready",
        content: expect.stringContaining("Plan review feedback"),
      }),
      { deliverAs: "followUp" },
    );

    finalizeReviewCycle(orchestrator.active!);

    expect(orchestrator.active!.state.step).toBe("user_gate");
    expect(orchestrator.active!.state.reviewCycle).toBeNull();
    expect(orchestrator.active!.state.reviewPass).toBe(1);
  });

  it("brainstorm review with no artifacts spawns nothing and clears the cycle", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "review no artifacts");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.phase = "brainstorm";
    orchestrator.active!.state.step = "llm_work";
    saveTask(taskDir, orchestrator.active!.state);

    const message = await enterReviewCycle(orchestrator, ctx, "regular");
    await new Promise((r) => setTimeout(r, 10));

    expect(message).toContain("Started review cycle pass 1");
    expect(orchestrator.active!.state.reviewCycle).toBeNull();
    expect(orchestrator.active!.state.step).toBe("llm_work");
    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pp-review-ready" }),
      { deliverAs: "followUp" },
    );
  });
});

describe("artifact validation enforcement", () => {
  it("writing invalid USER_REQUEST.md appends validation-error", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "validate ur");
    writeFileSync(join(orchestrator.active!.dir, "USER_REQUEST.md"), "# Wrong\n\n## Nope\n", "utf-8");

    const toolResult = pi._handlers.get("tool_result")!;
    const result = await toolResult({
      toolName: "write",
      input: { path: join(orchestrator.active!.dir, "USER_REQUEST.md") },
      isError: false,
      content: [{ type: "text", text: "written" }],
    }, {});

    const last = result.content[result.content.length - 1];
    expect(last.text).toContain("<validation-error>");
    expect(last.text).toContain("USER_REQUEST.md structure is invalid");
  });

  it("writing invalid RESEARCH.md appends validation-error", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "validate research");
    writeFileSync(join(orchestrator.active!.dir, "RESEARCH.md"), "## Affected Code\n\n", "utf-8");

    const toolResult = pi._handlers.get("tool_result")!;
    const result = await toolResult({
      toolName: "write",
      input: { path: join(orchestrator.active!.dir, "RESEARCH.md") },
      isError: false,
      content: [{ type: "text", text: "written" }],
    }, {});

    const last = result.content[result.content.length - 1];
    expect(last.text).toContain("<validation-error>");
    expect(last.text).toContain("RESEARCH.md structure is invalid");
  });

  it("writing valid USER_REQUEST.md does not append validation error", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "validate ur valid");
    writeFileSync(join(orchestrator.active!.dir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");

    const toolResult = pi._handlers.get("tool_result")!;
    const result = await toolResult({
      toolName: "write",
      input: { path: join(orchestrator.active!.dir, "USER_REQUEST.md") },
      isError: false,
      content: [{ type: "text", text: "written" }],
    }, {});

    expect(result).toBeUndefined();
  });

  it("writing invalid artifact markdown appends validation-error", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    await orchestrator.startTask(makeCtx() as any, "implement", "validate artifact");
    const artifactDir = join(orchestrator.active!.dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "note.md");
    writeFileSync(artifactPath, "## Heading only\n", "utf-8");

    const toolResult = pi._handlers.get("tool_result")!;
    const result = await toolResult({
      toolName: "write",
      input: { path: artifactPath },
      isError: false,
      content: [{ type: "text", text: "written" }],
    }, {});

    const last = result.content[result.content.length - 1];
    expect(last.text).toContain("<validation-error>");
    expect(last.text).toContain("Artifact structure is invalid");
  });
});

describe("tool blocking", () => {
  it("blocks write to .pp/state.json", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "write", input: { path: ".pp/state.json" } }, {});
    expect(result).toEqual({ block: true, reason: "state.json is managed by the extension" });
  });

  it("blocks write to .pp/config.json", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "edit", input: { path: ".pp/config.json" } }, {});
    expect(result).toEqual({ block: true, reason: "config.json is managed by the user, not the LLM" });
  });

  it("allows markdown writes in .pp/state", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "write", input: { path: ".pp/state/implement/123/notes.md" } }, {});
    expect(result).toBeUndefined();
  });

  it("blocks non-markdown writes in .pp/state", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const toolCall = pi._handlers.get("tool_call")!;

    const result = await toolCall({ toolName: "write", input: { path: ".pp/state/implement/123/data.json" } }, {});
    expect(result).toEqual({ block: true, reason: "Cannot write non-.md files in .pp/state/" });
  });
});

describe("error retry", () => {
  it("turn_end with error retries with exponential backoff", async () => {
    vi.useFakeTimers();
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "retry test");
    const turnEnd = pi._handlers.get("turn_end")!;

    await turnEnd({ message: { stopReason: "error", errorMessage: "rate limited", content: [] } }, ctx);

    expect(orchestrator.errorRetryCount).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Retrying in 2s"), "warning");

    await vi.advanceTimersByTimeAsync(2000);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Previous request failed"), { deliverAs: "followUp" });
    vi.useRealTimers();
  });

  it("turn_end stops retrying after max retries", async () => {
    vi.useFakeTimers();
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "retry max test");
    const turnEnd = pi._handlers.get("turn_end")!;

    for (let i = 0; i < 6; i++) {
      await turnEnd({ message: { stopReason: "error", errorMessage: "api down", content: [] } }, ctx);
    }

    expect(orchestrator.errorRetryCount).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Stopping auto-retry"), "error");
    vi.useRealTimers();
  });

  it("successful turn resets error count", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "retry reset test");
    const turnEnd = pi._handlers.get("turn_end")!;

    await turnEnd({ message: { stopReason: "error", errorMessage: "once", content: [] } }, ctx);
    expect(orchestrator.errorRetryCount).toBe(1);

    await turnEnd({ message: { stopReason: "stop", content: [] } }, ctx);
    expect(orchestrator.errorRetryCount).toBe(0);
  });

  it("empty turn triggers continuation nudge", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "nudge test");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    const turnEnd = pi._handlers.get("turn_end")!;

    await turnEnd({ message: { stopReason: "stop", content: [] }, toolResults: [] }, ctx);

    expect(orchestrator.nudgeTimestamps.length).toBe(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Continue the implement phase"), { deliverAs: "followUp" });
  });

  it("nudge halts after repeated interruptions", async () => {
    vi.useFakeTimers();
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "nudge halt");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    const turnEnd = pi._handlers.get("turn_end")!;

    for (let i = 0; i < 25; i += 1) {
      await turnEnd({ message: { stopReason: "stop", content: [] }, toolResults: [] }, ctx);
    }

    expect(orchestrator.nudgeHalted).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pp-continuation-halted" }),
      { deliverAs: "steer" },
    );
    vi.useRealTimers();
  });

  it("repeated text-only stops re-nudge instead of latching once", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "text stop test", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    const turnEnd = pi._handlers.get("turn_end")!;

    const textTurn = { message: { stopReason: "stop", content: [{ type: "text", text: "thinking out loud" }] }, toolResults: [] };
    for (let i = 0; i < 3; i += 1) {
      await turnEnd(textTurn, ctx);
    }

    const reminderCalls = (pi.sendUserMessage as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("Continue the implement phase"),
    );
    expect(reminderCalls.length).toBe(3);
    expect(reminderCalls[0][0]).toContain("Do NOT apologize");
    expect(orchestrator.nudgeHalted).toBe(false);
  });

  it("text-only stalls never trip the permanent halt", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "text stop halt test", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    const turnEnd = pi._handlers.get("turn_end")!;

    const textTurn = { message: { stopReason: "stop", content: [{ type: "text", text: "still talking" }] }, toolResults: [] };
    for (let i = 0; i < 30; i += 1) {
      await turnEnd(textTurn, ctx);
    }

    expect(orchestrator.nudgeHalted).toBe(false);
  });

  it("a tool-call turn resets the text-stop rate limit", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "text stop reset test", undefined, undefined, "autonomous");
    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    const turnEnd = pi._handlers.get("turn_end")!;

    await turnEnd({ message: { stopReason: "stop", content: [{ type: "text", text: "a" }] }, toolResults: [] }, ctx);
    expect(orchestrator.textStopTimestamps.length).toBe(1);
    await turnEnd({ message: { stopReason: "stop", content: [{ type: "toolCall" }] }, toolResults: [] }, ctx);
    expect(orchestrator.textStopTimestamps.length).toBe(0);
  });
});

describe("compaction", () => {
  it("compactAndTransition calls ctx.compact for phase transition", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);
    const compactSpy = vi.fn((opts?: any) => {
      if (opts?.onComplete) opts.onComplete();
    });
    const ctx = makeCtx({ compact: compactSpy });

    await orchestrator.startTask(ctx as any, "implement", "compaction");
    orchestrator.compactAndTransition(ctx as any, orchestrator.active!.dir, "plan");

    expect(compactSpy).toHaveBeenCalledWith(expect.objectContaining({ customInstructions: expect.stringContaining("Phase transition") }));
  });

  it("defers compaction until agent_end when not idle, then delivers Begin working", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const compactCbs: Array<{ onComplete?: () => void; onError?: (e: Error) => void }> = [];
    // Agent is mid-turn (tool in-flight): not idle, and compaction is deferred.
    const compactSpy = vi.fn((opts?: any) => { compactCbs.push(opts); });
    const ctx = makeCtx({ isIdle: vi.fn().mockReturnValue(false), compact: compactSpy });

    await orchestrator.startTask(ctx as any, "implement", "deferred compaction");
    orchestrator.compactAndTransition(ctx as any, orchestrator.active!.dir, "implement");

    // Not idle -> no compaction yet; controller is pending.
    expect(compactSpy).not.toHaveBeenCalled();

    // Agent goes idle: agent_end fires compaction.
    await pi._handlers.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
    expect(compactSpy).toHaveBeenCalledTimes(1);

    // Compaction throws the "too small" no-op: must still resume + deliver.
    compactCbs[0]!.onError!(new Error("Nothing to compact (session too small)"));

    await vi.waitFor(() => {
      const sentBeginWorking = pi.sendUserMessage.mock.calls.some(
        (c: any[]) => c[0] === "[PI-PI] Entered implement phase. Begin working." && c[1]?.deliverAs === "followUp",
      );
      expect(sentBeginWorking).toBe(true);
    });
    expect(orchestrator.transitionController.getState()).toBe("running");
  });

  it("session_before_compact returns phase summary when pending", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    await orchestrator.startTask(makeCtx() as any, "implement", "phase compact test");

    orchestrator.phaseCompactionPending = true;
    orchestrator.phaseCompactionSummary = "Phase summary text";
    const beforeCompact = pi._handlers.get("session_before_compact")!;
    const result = await beforeCompact({ preparation: { firstKeptEntryId: "e1", tokensBefore: 123 } }, {});

    expect(result.compaction.summary).toBe("Phase summary text");
  });

  it("session_before_compact returns task done summary when pending", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);

    orchestrator.taskDoneCompactionPending = true;
    orchestrator.taskDoneCompactionSummary = "Task done summary";
    const beforeCompact = pi._handlers.get("session_before_compact")!;
    const result = await beforeCompact({ preparation: { firstKeptEntryId: "e2", tokensBefore: 456 } }, {});

    expect(result.compaction.summary).toBe("Task done summary");
  });

  it("session_before_compact re-injects artifacts after natural compaction", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "reinject artifacts");
    writeFileSync(join(orchestrator.active!.dir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(orchestrator.active!.dir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    const beforeCompact = pi._handlers.get("session_before_compact")!;
    const result = await beforeCompact({ preparation: { firstKeptEntryId: "e3", tokensBefore: 789 } }, {});

    expect(result).toBeUndefined();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pp-artifact-reinject", content: expect.stringContaining("USER_REQUEST.md") }),
      { deliverAs: "steer" },
    );
  });
});

describe("input blocking during await", () => {
  it("blocks user input during await_planners", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "await planners");
    orchestrator.active!.state.step = "await_planners";
    const inputHandler = pi._handlers.get("input")!;

    const result = await inputHandler({ source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
  });

  it("blocks user input during await_reviewers", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "await reviewers");
    orchestrator.active!.state.step = "await_reviewers";
    const inputHandler = pi._handlers.get("input")!;

    const result = await inputHandler({ source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
  });
});

describe("context injection", () => {
  it("injectContextAndArtifacts sends context files as steer messages", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".pp", "context"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "context", "main.md"), "---\ninject: context\nagents: [main]\n---\nContext body", "utf-8");
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "inject context");
    pi.sendMessage.mockClear();
    orchestrator.injectContextAndArtifacts(orchestrator.active!.dir, orchestrator.active!.state.phase);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pp-context", content: expect.stringContaining("Context body") }),
      { deliverAs: "steer" },
    );
  });

  it("injectContextAndArtifacts sends phase artifacts", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "inject artifacts");
    writeFileSync(join(orchestrator.active!.dir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(orchestrator.active!.dir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");
    pi.sendMessage.mockClear();
    orchestrator.injectContextAndArtifacts(orchestrator.active!.dir, orchestrator.active!.state.phase);

    const artifactCalls = pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "pp-artifact");
    expect(artifactCalls.length).toBeGreaterThan(0);
    expect(artifactCalls.some((c: any[]) => String(c[0].content).includes("USER_REQUEST.md"))).toBe(true);
  });

  it("registerAgents appends context to agent prompts", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".pp", "context"), { recursive: true });
    writeFileSync(join(cwd, ".pp", "context", "explore-system.md"), "---\ninject: system\nagents: [explore]\n---\nExplore context", "utf-8");
    const { orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx({ cwd });

    await orchestrator.startTask(ctx as any, "implement", "register agents");
    (registerAgentDefinitions as any).mockClear();
    orchestrator.registerAgents();

    const defs = (registerAgentDefinitions as any).mock.calls[0][1] as Array<{ type: string; prompt: string }>;
    const explore = defs.find((d) => d.type === "explore");
    expect(explore?.prompt).toContain("Explore context");
  });
});

describe("session lifecycle", () => {
  it("session_start registers tools and commands", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);

    expect(pi.registerCommand).toHaveBeenCalledWith("pp", expect.anything());
    const toolNames = [...pi._tools.keys()];
    expect(toolNames).toContain("pp_phase_complete");
    expect(toolNames).toContain("pp_commit");
    expect(toolNames).toContain("pp_register_repo");
  });

  it("session_start detects paused tasks and notifies", async () => {
    const cwd = makeTempDir();
    createTask(cwd, "implement", "Paused task");
    const pi = makePi();
    const orchestrator = new Orchestrator(pi as any);
    registerEventHandlers(orchestrator);
    registerCommandHandlers(orchestrator);
    const ctx = makeCtx({ cwd });

    const sessionStart = pi._handlers.get("session_start")!;
    await sessionStart({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Paused task"), "info");
  });

  it("session_start loads config", async () => {
    const cwd = makeTempDir();
    const { orchestrator } = await setupOrchestrator(cwd);

    expect(orchestrator.config).toBeDefined();
    expect(orchestrator.config.agents.orchestrators.implement.model).toBe("test/model");
  });

  it("session_shutdown dumps usage summary", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const dumpSpy = vi.spyOn(usageTrackerModule, "dumpUsageSummary").mockImplementation(() => undefined);
    const shutdown = pi._handlers.get("session_shutdown")!;

    await shutdown({}, { sessionManager: { getSessionId: () => "session-id-1" } });

    expect(dumpSpy).toHaveBeenCalledTimes(1);
    expect(dumpSpy).toHaveBeenCalledWith(expect.anything(), "session-id-1");
  });
});

describe("menu contracts", () => {
  it("settings menu without active task has new top-level sections", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    menu
      .expect({ question: "/pp", options: { include: ["Settings"] }, choose: "Settings" })
      .expect({ question: "Settings", options: { exact: ["General", "Agents", "Commands", "Performance", "LSP", "Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("info menu shows Doctor and hides LSP", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    menu
      .expect({ question: "/pp", options: { include: ["Info"] }, choose: "Info" })
      .expect({
        question: "Info",
        options: {
          include: ["Subagents", "Usage", "Doctor", "Back"],
          exclude: ["LSP"],
        },
        choose: "Back",
      })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("info doctor option calls runDoctor", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();
    const runDoctorSpy = vi.mocked(doctorModule.runDoctor);

    menu
      .expect({ question: "/pp", options: { include: ["Info"] }, choose: "Info" })
      .expect({ question: "Info", options: { include: ["Doctor", "Back"] }, choose: "Doctor" })
      .expect({ question: "Info", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(runDoctorSpy).toHaveBeenCalledTimes(1);
    expect(runDoctorSpy).toHaveBeenCalledWith(orchestrator, ctx);
  });

  it("settings lsp menu restarts servers", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();
    const restart = vi.fn(async () => undefined);
    (globalThis as any)[Symbol.for("pi-lsp:api")] = { restart };

    menu
      .expect({ question: "/pp", options: { include: ["Settings"] }, choose: "Settings" })
      .expect({ question: "Settings", options: { include: ["LSP"] }, choose: "LSP" })
      .expect({ question: "LSP", options: { exact: ["Restart all servers", "Back"] }, choose: "Restart all servers" })
      .expect({ question: "LSP", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "Settings", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("settings lsp restart warns when API is missing", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();
    delete (globalThis as any)[Symbol.for("pi-lsp:api")];

    menu
      .expect({ question: "/pp", options: { include: ["Settings"] }, choose: "Settings" })
      .expect({ question: "Settings", options: { include: ["LSP"] }, choose: "LSP" })
      .expect({ question: "LSP", options: { exact: ["Restart all servers", "Back"] }, choose: "Restart all servers" })
      .expect({ question: "LSP", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "Settings", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("LSP API is not available.", "warning");
  });

  it("settings agents submenu has orchestrators and subagents", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    menu
      .expect({ question: "/pp", options: { include: ["Settings"] }, choose: "Settings" })
      .expect({ question: "Settings", options: { include: ["Agents", "Back"] }, choose: "Agents" })
      .expect({ question: "Agents", options: { exact: ["Orchestrators", "Subagents", "Back"] }, choose: "Back" })
      .expect({ question: "Settings", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("active task menu in guided implement phase has exact options", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract");

    menu.expect({
      question: m.taskMenu("implement", "brainstorm"),
      options: {
        exact: ["Next", "Review", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("active task menu hides Review while waiting for planners", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract waiting");
    orchestrator.active!.state.phase = "plan";
    orchestrator.active!.state.step = "await_planners";
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    menu.expect({
      question: m.taskMenu("implement", "plan"),
      options: {
        exact: ["Next", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("active task menu in autonomous mode has exact options", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract auto", undefined, undefined, "autonomous");

    // brainstorm is a forced-interactive phase, so even an autonomous task
    // shows the full interactive menu (Next/Review).
    menu.expect({
      question: m.taskMenu("implement", "brainstorm"),
      options: {
        exact: ["Next", "Review", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("autonomous debug task shows interactive menu in debug phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "debug", "contract debug auto", undefined, undefined, "autonomous");

    menu.expect({
      question: m.taskMenu("debug", "debug"),
      options: {
        exact: ["Next", "Review", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("autonomous review task shows interactive menu in review phase", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "review", "contract review auto", undefined, undefined, "autonomous");

    menu.expect({
      question: m.taskMenu("review", "review"),
      options: {
        exact: ["Next", "Review", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("autonomous menu 'Complete task' completes the task", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract complete", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;

    expectActiveTaskNext(menu, "Complete");

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("autonomous menu 'Pause task' pauses without completing", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract pause", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;

    expectActiveTaskNext(menu, "Pause");

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).not.toBe("done");
  });

  it("completing a task mid-review clears reviewCycle without incrementing reviewPass", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "complete mid review", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 1 };
    orchestrator.active!.state.step = "apply_feedback";
    orchestrator.active!.state.reviewPass = 0;
    orchestrator.active!.state.reviewPassByKind = {};
    saveTask(taskDir, orchestrator.active!.state);

    expectActiveTaskNext(menu, "Complete");

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    const finalState = loadTask(taskDir);
    expect(finalState.reviewCycle).toBeNull();
    expect(finalState.reviewPass).toBe(0);
    expect(finalState.reviewPassByKind?.implement?.auto ?? 0).toBe(0);
  });

  it("pausing a task mid-review clears reviewCycle without incrementing reviewPass", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "pause mid review", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.reviewCycle = { kind: "auto", step: "apply_feedback", pass: 1 };
    orchestrator.active!.state.step = "apply_feedback";
    orchestrator.active!.state.reviewPass = 0;
    orchestrator.active!.state.reviewPassByKind = {};
    saveTask(taskDir, orchestrator.active!.state);

    expectActiveTaskNext(menu, "Pause");

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    const finalState = loadTask(taskDir);
    expect(finalState.reviewCycle).toBeNull();
    expect(finalState.reviewPass).toBe(0);
    expect(finalState.reviewPassByKind?.implement?.auto ?? 0).toBe(0);
  });

  it("quick task menu has exact options", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "quick", "contract quick");

    menu.expect({
      question: m.taskMenu("quick", "quick"),
      options: {
        exact: ["Complete", "Pause", "Info", "Settings", "Back"],
      },
      choose: "Back",
    });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("Next submenu options change when continue is unavailable", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract next");
    menu
      .expect({ question: m.taskMenu("implement", "brainstorm"), options: { include: ["Next"] }, choose: "Next" })
      .expect({ question: "Next", options: { exact: ["Continue to plan & implement", "Complete", "Pause", "Back"] }, choose: "Back" })
      .expect({ question: m.taskMenu("implement", "brainstorm"), options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);

    orchestrator.active!.state.phase = "implement";
    orchestrator.active!.state.step = "llm_work";
    saveTask(orchestrator.active!.dir, orchestrator.active!.state);

    menu
      .expect({ question: m.taskMenu("implement", "implement"), options: { include: ["Next"] }, choose: "Next" })
      .expect({ question: "Next", options: { exact: ["Complete", "Pause", "Back"] }, choose: "Back" })
      .expect({ question: m.taskMenu("implement", "implement"), options: { include: ["Back"] }, choose: "Back" });

    await pp(undefined, ctx);
  });

  it("Review submenu has exact options", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "contract review");

    menu
      .expect({ question: m.taskMenu("implement", "brainstorm"), options: { include: ["Review"] }, choose: "Review" })
      .expect({ question: "Review", options: { exact: [m.autoReview, "Review on my own", "Back"] }, choose: "Back" })
      .expect({ question: m.taskMenu("implement", "brainstorm"), options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });

  it("mode picker options are exact", async () => {
    const cwd = makeTempDir();
    const { pi } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    menu
      .expect({ question: "/pp", options: { include: ["Task"] }, choose: "Task" })
      .expect({ question: "Task", options: { include: ["Implement"] }, choose: "Implement" })
      .expect({ question: "Implement", options: { include: ["New"] }, choose: "New" })
      .expect({ question: "Mode", options: { exact: ["Guided", "Autonomous", "Back"] }, choose: "Back" })
      .expect({ question: "Implement", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "Task", options: { include: ["Back"] }, choose: "Back" })
      .expect({ question: "/pp", options: { include: ["Back"] }, choose: "Back" });

    const pp = getCommand(pi, "pp");
    await pp(undefined, ctx);
  });
});

describe("full user flows", () => {
  it("guided implement happy path", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "guided flow", undefined, undefined, "guided");
    const taskDir = orchestrator.active!.dir;
    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    expectBrainstormToPlan(menu);
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("flow-guided-1", { summary: "brainstorm done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    emitSubagentCreated(pi, "flow-guided-planner", "Planner (test)");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), makeValidPlan(["- [ ] P1. Draft — Done when: draft exists"]), "utf-8");
    emitSubagentCompleted(pi, "flow-guided-planner", "Planner (test)");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), makeValidPlan(["- [x] P1. Ready — Done when: checked"]), "utf-8");

    expectPlanToImplement(menu);
    await ppPhaseComplete.execute("flow-guided-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    expectImplementToDone(menu);
    await ppPhaseComplete.execute("flow-guided-3", { summary: "implement done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("autonomous implement happy path", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "implement", "autonomous flow", undefined, undefined, "autonomous");
    const taskDir = orchestrator.active!.dir;
    orchestrator.active!.state.autonomousConfig = {
      phases: {
        brainstorm: { reviewPreset: "regular", maxReviewPasses: 0 },
        plan: { plannerPreset: "regular", reviewPreset: "regular", maxReviewPasses: 0 },
        implement: { reviewPreset: "regular", maxReviewPasses: 1 },
      },
    };
    saveTask(taskDir, orchestrator.active!.state);

    writeFileSync(join(taskDir, "USER_REQUEST.md"), VALID_USER_REQUEST, "utf-8");
    writeFileSync(join(taskDir, "RESEARCH.md"), VALID_RESEARCH, "utf-8");

    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("flow-auto-1", { summary: "brainstorm done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const plansDir = join(taskDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    emitSubagentCreated(pi, "flow-auto-planner", "Planner (test)");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000)}_test.md`), makeValidPlan(["- [ ] P1. Draft — Done when: draft exists"]), "utf-8");
    emitSubagentCompleted(pi, "flow-auto-planner", "Planner (test)");
    writeFileSync(join(plansDir, `${Math.floor(Date.now() / 1000) + 1}_synthesized.md`), makeValidPlan(["- [x] P1. Ready — Done when: checked"]), "utf-8");

    await ppPhaseComplete.execute("flow-auto-2", { summary: "plan done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const firstReview = await ppPhaseComplete.execute("flow-auto-3", { summary: "implement done" }, undefined, undefined, ctx);
    expect(firstReview.content[0].text).toMatch(/Reviews are running|Started review cycle pass/);

    const reviewsDir = join(taskDir, "code-reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, `${Math.floor(Date.now() / 1000)}_test_round-1.md`), "LGTM", "utf-8");
    emitSubagentCreated(pi, "flow-auto-reviewer", "Code reviewer (test)");
    emitSubagentCompleted(pi, "flow-auto-reviewer", "Code reviewer (test)");

    await ppPhaseComplete.execute("flow-auto-4", { summary: "feedback applied" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });

  it("quick task happy path", async () => {
    const cwd = makeTempDir();
    const { pi, orchestrator } = await setupOrchestrator(cwd);
    const ctx = makeCtx();

    await orchestrator.startTask(ctx as any, "quick", "quick flow");
    const taskDir = orchestrator.active!.dir;

    expectQuickMenu(menu, "Complete");
    const ppPhaseComplete = getTool(pi, "pp_phase_complete");
    await ppPhaseComplete.execute("flow-quick-1", { summary: "quick done" }, undefined, undefined, ctx);

    expect(orchestrator.active).toBeNull();
    expect(loadTask(taskDir).phase).toBe("done");
  });
});
