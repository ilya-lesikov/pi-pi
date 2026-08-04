import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("./orchestrator.js", () => ({ Orchestrator: vi.fn() }));
vi.mock("./command-handlers.js", () => ({ registerCommandHandlers: vi.fn() }));
vi.mock("./event-handlers.js", () => ({ registerEventHandlers: vi.fn() }));
vi.mock("./cbm.js", () => ({ registerCbmTools: vi.fn() }));
vi.mock("./exa.js", () => ({ registerExaTools: vi.fn() }));
vi.mock("./ast-search.js", () => ({ registerAstSearchTool: vi.fn() }));
vi.mock("./flant-infra.js", () => ({ initFlantSync: vi.fn(), migrateLegacyFlantSettings: vi.fn() }));
vi.mock("./billing-spoof.js", () => ({ registerBillingHook: vi.fn() }));
vi.mock("./suppress-pierre-theme-spam.js", () => ({ suppressPierreThemeSpam: vi.fn() }));

import init from "./index.js";

const ORCHESTRATOR_KEY = Symbol.for("pi-pi:orchestrator-initialized");
const ORCHESTRATOR_CWD_KEY = Symbol.for("pi-pi:orchestrator-cwd");
const SUBAGENT_SESSION_KEY = Symbol.for("pi-pi:subagent-session");

const VALID_PLAN = [
  "# Plan",
  "",
  "## Scope",
  "Do the thing.",
  "",
  "## Checklist",
  "",
  "- [ ] Thing is done — Done when: the test passes",
].join("\n");

afterEach(() => {
  (globalThis as any)[ORCHESTRATOR_KEY] = undefined;
  (globalThis as any)[ORCHESTRATOR_CWD_KEY] = undefined;
  (globalThis as any)[SUBAGENT_SESSION_KEY] = undefined;
  vi.clearAllMocks();
});

// Drives the real tool_result hook in index.ts against the REAL validatePlan, so
// the stub carve-out is verified against measured validator behavior rather than
// a mock.
function setupHook(): { hook: (event: any, ctx: any) => Promise<any>; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pp-plan-hook-"));
  // The plan/artifact tool_result hook is registered on the already-initialized
  // (subagent) branch, which is also where planners actually write their files.
  (globalThis as any)[ORCHESTRATOR_KEY] = true;
  (globalThis as any)[ORCHESTRATOR_CWD_KEY] = cwd;
  const handlers = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, fn: any) => handlers.set(name, fn)),
    registerTool: vi.fn(),
  } as any;
  init(pi);
  return { hook: handlers.get("tool_result")!, cwd };
}

async function writeAndHook(cwd: string, hook: any, filename: string, content: string): Promise<string> {
  const plansDir = join(cwd, "task", "plans");
  mkdirSync(plansDir, { recursive: true });
  const target = join(plansDir, filename);
  writeFileSync(target, content, "utf-8");
  const result = await hook({
    toolName: "write",
    input: { path: target },
    isError: false,
    content: [{ type: "text", text: "written" }],
  }, {});
  return (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

describe("plan-variant validation hook (stub carve-out)", () => {
  it("accepts a bare PLAN_STATUS: INCOMPLETE stub with no validation errors", async () => {
    const { hook, cwd } = setupHook();
    // The planner's FIRST action writes this stub so the file exists even if the
    // run later dies. It is deliberately not a plan yet, so answering with the
    // four structure errors would make the tooling fight its own convention.
    const out = await writeAndHook(cwd, hook, "100_fable.md", "PLAN_STATUS: INCOMPLETE\n");
    expect(out).not.toContain("<validation-error>");
  });

  it("still rejects a malformed non-stub plan variant", async () => {
    const { hook, cwd } = setupHook();
    const out = await writeAndHook(cwd, hook, "100_fable.md", "# Plan\n\nnot a plan at all\n");
    expect(out).toContain("<validation-error>");
    expect(out).toContain("Plan structure is invalid");
  });

  it("accepts a finished plan ending in the PLAN_STATUS: COMPLETE marker", async () => {
    const { hook, cwd } = setupHook();
    const out = await writeAndHook(cwd, hook, "100_fable.md", `${VALID_PLAN}\n\nPLAN_STATUS: COMPLETE\n`);
    expect(out).not.toContain("<validation-error>");
  });
});
