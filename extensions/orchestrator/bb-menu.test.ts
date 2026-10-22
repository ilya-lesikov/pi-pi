import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The global config path is fixed when config.js loads; keep it off the developer's own.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "bb-menu-agent-"));
});

import { encodeQuestions, resetBbForms, type BbForms, type FormOutcome, type FormSpec } from "./bb-forms.js";
import { closeBbMenu, openBbMenu } from "./bb-menu.js";
import { activeMenu, menuAsk, MenuAborted, menuContext, menuNotices, menuReport } from "./bb-menu-ui.js";
import { getDefaultConfig, normalizeConfigDurations } from "./config.js";
import { attachHost, notice } from "./notices.js";
import { Orchestrator } from "./orchestrator.js";

afterAll(() => {
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Shown = { spec: FormSpec; title: string };

/** The plugin's forms, answered by `script` one form at a time. */
function fakeForms(script: Array<(shown: Shown) => FormOutcome>, kinds = ["ask", "confirm", "worker-question", "input", "report"]) {
  const shown: Shown[] = [];
  const forms = {
    ask: vi.fn(async (spec: FormSpec, options: { title: string; signal?: AbortSignal }) => {
      const entry = { spec, title: options.title };
      shown.push(entry);
      const next = script.shift();
      if (next) return next(entry);
      // Nothing scripted: stays up until taken down.
      return new Promise<FormOutcome>((resolve) => options.signal?.addEventListener("abort", () => resolve({ outcome: "cancelled", reason: "signal" }), { once: true }));
    }),
    supports: vi.fn(async (wanted: string[]) => wanted.every((kind) => kinds.includes(kind))),
  };
  return { forms: forms as unknown as BbForms, shown };
}

const pick = (title: string | RegExp) => ({ spec }: Shown): FormOutcome => {
  if (spec.kind !== "ask") throw new Error(`expected a question, got ${spec.kind}`);
  const option = spec.questions[0]!.options.find((entry) => (typeof title === "string" ? entry.title === title : title.test(entry.title)));
  if (!option) throw new Error(`no option ${title} in ${spec.questions[0]!.options.map((entry) => entry.title).join(" | ")}`);
  return { outcome: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: [option.title] }] } };
};
const closeReport = ({ spec }: Shown): FormOutcome => {
  if (spec.kind !== "report") throw new Error(`expected a report, got ${spec.kind}`);
  return { outcome: "submitted", value: { kind: "closed" } };
};
const type = (text: string) => ({ spec }: Shown): FormOutcome => {
  if (spec.kind !== "input") throw new Error(`expected a text box, got ${spec.kind}`);
  return { outcome: "submitted", value: { kind: "input", text } };
};
const dismiss = (): FormOutcome => ({ outcome: "cancelled", reason: "user" });

// pi's own dialogs cannot reach the user in bb between runs: the menu must never use them.
const unreachable = () => {
  throw new Error("pi's own dialog was used");
};
const piCtx = () => ({ mode: "rpc", hasUI: true, isIdle: () => true, model: null, sessionManager: {}, ui: { select: unreachable, input: unreachable, confirm: unreachable, editor: unreachable, custom: unreachable, notify: vi.fn() } });

function makeOrchestrator(cwd: string): Orchestrator {
  const orchestrator = new Orchestrator({ appendEntry: vi.fn(), registerAgent: vi.fn(), unregisterAgent: vi.fn(), events: { emit: vi.fn() } } as any);
  orchestrator.cwd = cwd;
  orchestrator.config = normalizeConfigDurations(getDefaultConfig());
  orchestrator.registerAgents = vi.fn() as any;
  return orchestrator;
}

describe("pi-pi's menu in bb", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bb-menu-"));
    process.env.BB_THREAD_ID = "thr_1";
    attachHost({ mode: "rpc" });
  });
  afterEach(() => {
    closeBbMenu();
    resetBbForms(undefined);
    delete process.env.BB_THREAD_ID;
    attachHost({ mode: "tui" });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runs /pp's own screens through the plugin's forms: menus, reports and text boxes", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const record: any = { id: "explore-1", spec: { type: "explore", description: "map repo" }, status: "running", createdAt: Date.now(), toolUses: 2 };
    const send = vi.fn(() => "steered");
    orchestrator.workers = { list: () => [record], get: () => record, sessionOf: () => ({ transcript: () => [] }), stop: vi.fn(), send } as any;
    const { forms, shown } = fakeForms([
      pick("Status"), closeReport,
      pick("Workers"), pick(/explore-1/), closeReport, pick("Send a message"), type("focus on tests"), closeReport, pick("Back"), pick("Back"),
      dismiss,
    ]);
    resetBbForms(forms);
    orchestrator.lastCtx = piCtx();

    const opened = openBbMenu(orchestrator);
    expect(opened.ok).toBe(true);
    await opened.closed;

    expect(shown.map((entry) => entry.spec.kind)).toEqual(["ask", "report", "ask", "ask", "report", "ask", "input", "report", "ask", "ask", "ask"]);
    expect(shown[1]!.title).toBe("pi-pi · status");
    // The menu's options keep their descriptions.
    expect((shown[0]!.spec as any).questions[0].options).toContainEqual({ title: "Status", description: "Model, context, providers, workers, and warnings" });
    expect(send).toHaveBeenCalledWith("explore-1", "focus on tests");
    expect(menuNotices().at(-1)?.text).toBe("explore-1: steered");
    expect(activeMenu()).toBeNull();
  });

  it("opens only while the agent is idle, and once", async () => {
    const orchestrator = makeOrchestrator(cwd);
    resetBbForms(fakeForms([]).forms);
    orchestrator.lastCtx = { ...piCtx(), isIdle: () => false };
    expect(openBbMenu(orchestrator)).toMatchObject({ ok: false, message: "pi-pi's menu opens while the agent is idle." });

    orchestrator.lastCtx = piCtx();
    const opened = openBbMenu(orchestrator);
    expect(opened.ok).toBe(true);
    expect(openBbMenu(orchestrator)).toMatchObject({ ok: false, message: "pi-pi's menu is already open." });
    closeBbMenu();
    await opened.closed;
  });

  it("unwinds every screen at once when it is taken down, rather than going back a level", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const { forms, shown } = fakeForms([pick("Settings")]);
    resetBbForms(forms);
    orchestrator.lastCtx = piCtx();
    const opened = openBbMenu(orchestrator);
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    closeBbMenu();
    await opened.closed;
    expect(shown).toHaveLength(2);
    expect(activeMenu()).toBeNull();
  });

  it("says why when bb takes the menu down, instead of vanishing", async () => {
    const orchestrator = makeOrchestrator(cwd);
    resetBbForms(fakeForms([() => ({ outcome: "unavailable" })]).forms);
    orchestrator.lastCtx = piCtx();
    await openBbMenu(orchestrator).closed;
    expect(menuNotices().at(-1)).toMatchObject({ level: "warning", text: "pi-pi's menu closed: pi-pi's bb plugin did not respond; try again in a minute" });
  });

  it("says so, and shows nothing, when the plugin is too old to draw the menu", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const { forms, shown } = fakeForms([], ["ask", "confirm", "worker-question"]);
    resetBbForms(forms);
    orchestrator.lastCtx = piCtx();
    await openBbMenu(orchestrator).closed;
    expect(shown).toHaveLength(0);
    expect(menuNotices().at(-1)).toMatchObject({ level: "error", text: expect.stringContaining("update it") });
  });

  it("shows notices raised anywhere while it is open beside it, not in the chat later", async () => {
    const orchestrator = makeOrchestrator(cwd);
    const { forms, shown } = fakeForms([]);
    resetBbForms(forms);
    orchestrator.lastCtx = piCtx();
    const opened = openBbMenu(orchestrator);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    notice(undefined, "Routing changed", "warning");
    expect(menuNotices().at(-1)).toMatchObject({ text: "Routing changed", level: "warning" });
    closeBbMenu();
    await opened.closed;
  });
});

describe("menu questions", () => {
  it("fits each page to the form's size, however long the descriptions", async () => {
    const options = Array.from({ length: 150 }, (_, i) => ({ title: `model-${i}`, description: "d".repeat(1400) }));
    const { forms, shown } = fakeForms([pick("model-3")]);
    await menuAsk({ forms, signal: new AbortController().signal }, { question: "Model?", options, allowMultiple: false, allowFreeform: false, allowComment: false });
    expect(JSON.stringify(shown[0]!.spec).length).toBeLessThan(60_000);
    expect((shown[0]!.spec as any).questions[0].options.at(-1).title).toMatch(/^More… \(\d+ more\)$/);
  });

  it("cuts a report to what fits once serialized, and says so", async () => {
    const { forms, shown } = fakeForms([closeReport]);
    await menuReport({ forms, signal: new AbortController().signal }, "Big", '"\n'.repeat(30_000));
    expect(JSON.stringify(shown[0]!.spec).length).toBeLessThan(60_000);
    expect((shown[0]!.spec as any).text).toMatch(/more characters not shown\.$/);
  });

  it("pages a list longer than the plugin takes", async () => {
    const options = Array.from({ length: 200 }, (_, i) => ({ title: `model-${i}` }));
    const { forms, shown } = fakeForms([pick(/^More…/), pick("model-170")]);
    const answer = await menuAsk({ forms, signal: new AbortController().signal }, { question: "Model?", options, allowMultiple: false, allowFreeform: false, allowComment: false });
    expect(answer).toEqual({ kind: "selection", selections: ["model-170"] });
    expect((shown[0]!.spec as any).questions[0].options).toHaveLength(151);
    expect((shown[1]!.spec as any).questions[0].options.at(-1).title).toBe("Back to the first page");
  });

  it("treats bb taking the form down as the menu closing, and the user's dismissal as going back", async () => {
    const question = { question: "Pick", options: [{ title: "a" }], allowMultiple: false, allowFreeform: false, allowComment: false };
    const session = (outcome: FormOutcome) => ({ forms: fakeForms([() => outcome]).forms, signal: new AbortController().signal });
    expect(await menuAsk(session({ outcome: "cancelled", reason: "user" }), question)).toBeNull();
    await expect(menuAsk(session({ outcome: "cancelled", reason: "thread-stopped" }), question)).rejects.toBeInstanceOf(MenuAborted);
    await expect(menuAsk(session({ outcome: "unavailable" }), question)).rejects.toBeInstanceOf(MenuAborted);
  });

  it("keeps pi's context live, and only its dialogs redirected", async () => {
    let model = "a";
    const target = {
      get model() { return model; },
      ui: { getEditorText() { return this === target.ui ? "draft" : "wrong this"; } },
    };
    const ctx = menuContext(target, { forms: fakeForms([]).forms, signal: new AbortController().signal });
    model = "b";
    expect(ctx.model).toBe("b");
    expect(ctx.ui.getEditorText()).toBe("draft");
    expect(ctx.bbMenu).toBeDefined();
  });
});

describe("encodeQuestions", () => {
  it("fits titles to the plugin and maps the picked one back to the original", () => {
    const long = "x".repeat(600);
    const encoded = encodeQuestions([{ question: "q", options: [{ title: `${long}1` }, { title: `${long}2` }], recommended: `${long}2`, allowMultiple: true, allowFreeform: false, allowComment: false }]);
    const [first, second] = encoded.questions[0]!.options.map((option) => option.title);
    expect(first!.length).toBeLessThanOrEqual(300);
    expect(second).not.toBe(first);
    expect(encoded.questions[0]!.recommended).toBe(second);
    expect(encoded.decode([{ kind: "selection", selections: [second!, first!] }])).toEqual([{ kind: "selection", selections: [`${long}2`, `${long}1`] }]);
  });
});
