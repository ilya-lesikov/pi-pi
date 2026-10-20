import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerAskUser } from "./index.js";
import { registerConfirm } from "./confirm.js";
import { askQuestion, askUser, isCancel } from "./ui.js";
import { attachHost } from "../notices.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const SPACE = " ";
const CTRL_E = "\x05";
const ALT_LEFT = "\x1b[1;3D";
const ALT_RIGHT = "\x1b[1;3C";

const BINDINGS: Record<string, string[]> = {
  "tui.input.submit": [ENTER],
  "tui.input.newLine": ["shift+enter"],
  "tui.select.confirm": [ENTER],
  "tui.select.cancel": [ESC, CTRL_C],
  "tui.select.up": [UP],
  "tui.select.down": [DOWN],
};

const keybindings = {
  matches: (data: string, id: string) => (BINDINGS[id] ?? []).includes(data),
  getKeys: (id: string) => (BINDINGS[id] ?? []).map((key) => ({ [ENTER]: "enter", [ESC]: "escape", [CTRL_C]: "ctrl+c", [UP]: "up", [DOWN]: "down" })[key] ?? key),
};

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

type Script = (component: any, step: number) => void;

// Each custom() call mounts the real component and plays `script` against it; `step` counts mounts.
function fakeUI(script: Script, extra: Record<string, any> = {}) {
  const frames: string[][] = [];
  let step = 0;
  const ui = {
    working: [] as Array<string | undefined>,
    setWorkingMessage(message?: string) {
      ui.working.push(message);
    },
    custom: (factory: any) => new Promise((settle) => {
      const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
      const component = factory(tui, theme, keybindings, settle);
      component.press = (...keys: string[]) => {
        for (const key of keys) component.handleInput(key);
        frames.push(component.render(100));
      };
      frames.push(component.render(100));
      script(component, step++);
    }),
    ...extra,
  };
  return { ui, frames };
}

function harness(script: Script, extra: Record<string, any> = {}, ctxExtra: Record<string, any> = {}) {
  let tool: any;
  registerAskUser({ registerTool: (t: any) => (tool = t) } as any);
  const { ui, frames } = fakeUI(script, extra);
  const ctx = { hasUI: true, ui, ...ctxExtra };
  const updates: any[] = [];
  const run = (params: any, signal?: AbortSignal) => tool.execute("id", tool.prepareArguments(params), signal, (u: any) => updates.push(u), ctx);
  return { tool, ui, frames, ctx, run, updates };
}

const text = (result: any) => result.content[0].text as string;
const screen = (frames: string[][]) => frames[frames.length - 1]!.join("\n");

describe("ask_user in the terminal", () => {
  it("returns a single selection and shows the question as the main line", async () => {
    const { run, ui, frames } = harness((c) => c.press(DOWN, ENTER));
    const result = await run({ question: "Pick a database", header: "DB", options: ["A", { title: "B", description: "bee" }] });
    expect(text(result)).toBe("User answered: B");
    expect(result.details).toMatchObject({ question: "Pick a database", header: "DB", options: [{ title: "A" }, { title: "B", description: "bee" }], response: { kind: "selection", selections: ["B"] }, cancelled: false, status: "answered" });
    expect(ui.working).toEqual(["Waiting for user to answer…", undefined]);
    const first = frames[0]!.join("\n");
    expect(first).toMatch(/╭─ ask_user · DB ─/);
    expect(first).toContain("Pick a database");
    expect(first).not.toContain("Question");
    expect(first).toContain("Other… type your own answer");
  });

  it("drops a context field a model still sends instead of failing", async () => {
    const { run, frames } = harness((c) => c.press(ENTER));
    const result = await run({ question: "Pick", context: "old field", options: ["A", "B"] });
    expect(text(result)).toBe("User answered: A");
    expect(screen(frames)).not.toContain("old field");
    expect(result.details.context).toBeUndefined();
  });

  it("focuses and marks the recommended option", async () => {
    const { run, frames } = harness((c) => c.press(ENTER));
    const result = await run({ question: "Pick", options: ["A", "B", "C"], recommended: "C" });
    expect(text(result)).toBe("User answered: C");
    expect(frames[0]!.join("\n")).toMatch(/❯ 3 C {2}★ recommended/);
  });

  it("answers at once with a digit and opens Other… with its own digit", async () => {
    expect(text(await harness((c) => c.press("2")).run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: B");
    const other = harness((c) => c.press("3", ..."mine", ENTER));
    expect(text(await other.run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: mine");
  });

  it("ignores ctrl+c in the list and in the editors", async () => {
    const { run, frames } = harness((c) => c.press(CTRL_C, DOWN, DOWN, ENTER, CTRL_C, ..."x", ENTER));
    expect(text(await run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: x");
    for (const frame of frames) expect(frame.join("\n")).not.toContain("ctrl+c");
  });

  it("cancels on esc after an optional reason, and with the reason when one is typed", async () => {
    const plain = harness((c) => c.press(ESC, ESC));
    const result = await plain.run({ question: "Pick", options: ["A", "B"] });
    expect(result.details).toMatchObject({ cancelled: true, cancelReason: "user", status: "cancelled" });
    expect(text(result)).toMatch(/^User cancelled the question\. Do not ask it again/);
    const why = harness((c) => c.press(ESC, ..."need more info", ENTER));
    const reasoned = await why.run({ question: "Pick", options: ["A", "B"] });
    expect(reasoned.details.cancelNote).toBe("need more info");
    expect(text(reasoned)).toContain('Their reason: "need more info"');
    expect(screen(why.frames)).toContain("Why cancel? (optional)");
  });

  it("takes a free answer from Other…, keeping the draft when going back", async () => {
    const { run, frames } = harness((c) => c.press(DOWN, DOWN, ENTER, ..."dra", ESC, ENTER, ..."ft", ENTER));
    expect(text(await run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: draft");
    expect(frames.some((frame) => frame.join("\n").includes("Your answer"))).toBe(true);
  });

  it("asks for free text directly when there are no options", async () => {
    const { run } = harness((c) => c.press(..."hello", ENTER));
    const result = await run({ question: "Name?" });
    expect(text(result)).toBe("User answered: hello");
    expect(result.details.response).toEqual({ kind: "freeform", text: "hello" });
  });

  it("adds a comment with ctrl+e and keeps the pick when the comment is abandoned", async () => {
    const commented = harness((c) => c.press(DOWN, CTRL_E, ..."why not", ENTER));
    expect(text(await commented.run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: B — why not");
    expect(screen(commented.frames)).toContain("Comment on B");
    const abandoned = harness((c) => c.press(CTRL_E, ESC, ENTER));
    expect(text(await abandoned.run({ question: "Pick", options: ["A", "B"] }))).toBe("User answered: A");
    const off = harness((c) => c.press(CTRL_E, ENTER));
    expect(text(await off.run({ question: "Pick", options: ["A", "B"], allowComment: false }))).toBe("User answered: A");
  });

  it("toggles several options, never submits an empty selection, and adds a custom item", async () => {
    const { run, frames } = harness((c) => c.press(ENTER, DOWN, DOWN, SPACE, DOWN, SPACE, ..."E2E", ENTER, ENTER));
    const result = await run({ question: "Checks?", options: ["Unit", "Lint", "Scan"], allowMultiple: true });
    expect(result.details.response).toEqual({ kind: "selection", selections: ["Unit", "Scan"], other: "E2E" });
    expect(text(result)).toBe("User answered: Unit, Scan, Other: E2E");
    expect(frames[1]!.join("\n")).toContain("☑ Unit");
    expect(screen(frames)).toContain("Other… E2E");
  });

  it("moves between questions with the arrow keys and keeps earlier answers", async () => {
    let mounts = 0;
    const { run } = harness((c, step) => {
      mounts++;
      if (step === 0) c.press(DOWN, ENTER);
      else if (step === 1) c.press(LEFT);
      else if (step === 2) c.press(RIGHT);
      else c.press(ALT_RIGHT, ENTER);
    });
    const result = await run({ questions: [{ question: "One", options: ["A", "B"] }, { question: "Two", options: ["C", "D"] }] });
    expect(text(result)).toBe("User answered:\n1. One: B\n2. Two: C");
    expect(mounts).toBe(4);
  });

  it("shows the counter and header in the frame and keeps the help line on one row", async () => {
    const { run, frames } = harness((c) => c.press(ENTER));
    await run({ questions: [{ question: "One", header: "Region", options: ["A", "B"] }] });
    expect(frames[0]![0]).toMatch(/ask_user · 1\/1 · Region/);
    const help = frames[0]!.filter((line) => line.includes("esc cancel"));
    expect(help).toHaveLength(1);
    for (const line of frames[0]!) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it("cancels with reason signal when aborted while open, and before opening", async () => {
    const controller = new AbortController();
    const { run } = harness(() => controller.abort());
    expect((await run({ question: "Pick", options: ["A", "B"] }, controller.signal)).details).toMatchObject({ cancelled: true, cancelReason: "signal" });
    expect((await harness(() => {}).run({ question: "Pick", options: ["A", "B"] }, controller.signal)).details.cancelReason).toBe("signal");
  });
});

describe("ask_user validation", () => {
  const run = (params: any) => harness(() => {}).run(params);

  it("rejects one option, duplicates and decline-only options before showing anything", async () => {
    expect(text(await run({ question: "Pick", options: ["Only"] }))).toMatch(/one option is not a choice/);
    expect(text(await run({ question: "Pick", options: ["A", "a"] }))).toMatch(/twice/);
    expect(text(await run({ question: "Go?", options: ["Yes", "Cancel"] }))).toMatch(/only declines.*use confirm/);
    expect(text(await run({ question: "Pick", options: ["A", "B"], recommended: "C" }))).toMatch(/not one of its options/);
    expect((await run({ questions: [{ question: "One", options: ["A", "B"] }, { question: "Two", options: ["X"] }] })).isError).toBe(true);
  });

  it("allows a decline option next to two real ones", async () => {
    const { run: go } = harness((c) => c.press(ENTER));
    expect(text(await go({ question: "Pick", options: ["A", "B", "Skip"] }))).toBe("User answered: A");
  });
});

describe("ask_user without a UI", () => {
  it("returns every question with full options and asks the model to proceed on stated assumptions", async () => {
    let tool: any;
    registerAskUser({ registerTool: (t: any) => (tool = t) } as any);
    const result = await tool.execute("id", tool.prepareArguments({ questions: [
      { question: "Strategy?", options: [{ title: "Rolling", description: "default" }, "Canary"], recommended: "Canary" },
      { question: "Checks?", options: ["Unit", "Lint"], allowMultiple: true, recommended: "Unit" },
    ] }), undefined, undefined, { hasUI: false });
    expect(result.isError).toBeUndefined();
    expect(result.details.status).toBe("unattended");
    expect(text(result)).toContain("1) Strategy?\n1. Rolling — default\n2. Canary (recommended)");
    expect(text(result)).toContain("2) Checks? (several answers allowed)");
    expect(text(result)).toContain("Take the recommended option for each");
  });
});

describe("ask_user over host dialogs", () => {
  afterEach(() => {
    delete process.env.PASEO_AGENT_ID;
    attachHost({ mode: "tui" });
  });

  function dialogHost(answers: Array<string | undefined | ((title: string, options?: string[]) => string | undefined)>) {
    const calls: Array<{ method: string; title: string; options?: string[]; placeholder?: string }> = [];
    const next = (title: string, options?: string[]) => {
      const answer = answers.shift();
      return typeof answer === "function" ? answer(title, options) : answer;
    };
    const ui = {
      select: vi.fn(async (title: string, options: string[]) => (calls.push({ method: "select", title, options }), next(title, options))),
      input: vi.fn(async (title: string, placeholder: string) => (calls.push({ method: "input", title, placeholder }), next(title))),
      notify: vi.fn(),
    };
    let tool: any;
    registerAskUser({ registerTool: (t: any) => (tool = t) } as any);
    const ctx = { hasUI: true, mode: "rpc", ui, isIdle: () => false };
    attachHost(ctx);
    return { calls, ui, run: (params: any) => tool.execute("id", tool.prepareArguments(params), undefined, undefined, ctx) };
  }

  it("sends one-line titles and Title — description options without numbers, and answers by label", async () => {
    const { calls, run } = dialogHost(["Blue/green (recommended) — instant rollback"]);
    const result = await run({ question: "Strategy?\nfor payments", options: ["Rolling", { title: "Blue/green", description: "instant rollback" }], recommended: "Blue/green" });
    expect(text(result)).toBe("User answered: Blue/green");
    expect(calls).toEqual([{ method: "select", title: "Strategy? for payments", options: ["Rolling", "Blue/green (recommended) — instant rollback", "Other…"] }]);
  });

  it("accepts a host answering with the bare option title instead of the label it was shown", async () => {
    const { run } = dialogHost(["Blue/green"]);
    expect(text(await run({ question: "Pick", options: ["Rolling", { title: "Blue/green", description: "instant rollback" }] }))).toBe("User answered: Blue/green");
  });

  it("keeps titles and options within the strictest host's limits", async () => {
    const long = "q".repeat(400);
    const { calls, run } = dialogHost(["A"]);
    await run({ question: long, options: ["A", "o".repeat(900)] });
    expect(calls[0]!.title.length).toBeLessThanOrEqual(160);
    expect(Math.max(...calls[0]!.options!.map((o) => o.length))).toBeLessThanOrEqual(200);
  });

  it("pages a long option list", async () => {
    const options = Array.from({ length: 70 }, (_, i) => `opt${i}`);
    const { calls, run } = dialogHost([(_t, o) => o!.at(-1), "opt55"]);
    expect(text(await run({ question: "Pick", options, allowFreeform: false }))).toBe("User answered: opt55");
    expect(calls[0]!.options!.length).toBeLessThanOrEqual(64);
    expect(calls[0]!.options!.at(-1)).toMatch(/^More… \(22 more\)$/);
  });

  it("takes Other… through an input, and a typed answer the host made up as the answer", async () => {
    const { calls, run } = dialogHost(["Other…", "use argo"]);
    expect(text(await run({ question: "Strategy?", options: ["A", "B"] }))).toBe("User answered: use argo");
    expect(calls[1]).toMatchObject({ method: "input", title: "Your answer — Strategy?", placeholder: "Type your answer" });
    const sentinel = dialogHost(["✏️ Type custom response...", "my own"]);
    expect(text(await sentinel.run({ question: "Strategy?", options: ["A", "B"] }))).toBe("User answered: my own");
  });

  it("offers a comment only when asked for, and a dismissed comment keeps the answer", async () => {
    const { calls, run } = dialogHost(["Add a comment…", undefined, (_t, o) => o![1]]);
    const result = await run({ question: "Pick", options: ["A", "B"], allowComment: true });
    expect(text(result)).toBe("User answered: B");
    expect(calls[0]!.options).toEqual(["A", "B", "Other…", "Add a comment…"]);
    const plain = dialogHost(["A"]);
    await plain.run({ question: "Pick", options: ["A", "B"] });
    expect(plain.calls[0]!.options).toEqual(["A", "B", "Other…"]);
  });

  it("attaches a comment typed before picking", async () => {
    const { calls, run } = dialogHost(["Add a comment…", "keep surge at 1", "B"]);
    expect(text(await run({ question: "Pick", options: ["A", "B"], allowComment: true }))).toBe("User answered: B — keep surge at 1");
    expect(calls[2]!.title).toBe("(comment added) Pick");
  });

  it("selects several options with Add and Remove entries and an explicit Use selected", async () => {
    const { calls, run } = dialogHost(["Add Unit", "Add Lint", "Remove Unit", "Add Scan — slow", (_t, o) => o!.find((x) => x.startsWith("Use selected"))]);
    const result = await run({ question: "Checks?", options: ["Unit", "Lint", { title: "Scan", description: "slow" }], allowMultiple: true });
    expect(result.details.response).toEqual({ kind: "selection", selections: ["Lint", "Scan"] });
    expect(calls[0]!.options).toEqual(["Add Unit", "Add Lint", "Add Scan — slow", "Add your own…"]);
    expect(calls[4]!.title).toBe("(2 selected: Lint, Scan) Checks?");
    expect(calls[4]!.options).toContain("Use selected (2)");
  });

  it("gives up on a host that keeps returning the same choice instead of looping", async () => {
    const { run } = dialogHost(Array.from({ length: 20 }, () => (_t: string, o?: string[]) => o![0]));
    const result = await run({ question: "Checks?", options: ["Unit", "Lint"], allowMultiple: true });
    expect(result.details.status).toBe("incomplete");
    expect(text(result)).toMatch(/Ask the question in plain prose/);
  });

  it("learns that the host cannot take typed text, hides Other…, and tells the model to ask in prose", async () => {
    const { calls, run } = dialogHost(["Other…", undefined, undefined]);
    const result = await run({ question: "Pick", options: ["A", "B"] });
    expect(calls.map((c) => c.method)).toEqual(["select", "input", "select"]);
    expect(calls[2]!.title).toBe("(typing is unavailable here) Pick");
    expect(calls[2]!.options).toEqual(["A", "B"]);
    expect(result.details.status).toBe("cancelled");
    const freeText = dialogHost([undefined]);
    const typed = await freeText.run({ question: "Name?" });
    expect(typed.details.status).toBe("typing_unavailable");
    expect(text(typed)).toMatch(/cannot collect typed answers/);
  });

  it("walks a sequence with Back and a final review", async () => {
    const { calls, run } = dialogHost(["A", "← Back", "B", "D", "Change 2: Two: D", "C", "Submit"]);
    const result = await run({ questions: [{ question: "One", options: ["A", "B"] }, { question: "Two", options: ["C", "D"] }] });
    expect(text(result)).toBe("User answered:\n1. One: B\n2. Two: C");
    expect(calls[0]!.title).toBe("(1/2) One");
    expect(calls[1]!.options).toContain("← Back");
    expect(calls[4]!.title).toBe("Submit these answers?");
  });

  it("reports earlier answers as not submitted when a sequence is cancelled", async () => {
    const { run } = dialogHost(["A", undefined]);
    const result = await run({ questions: [{ question: "One", options: ["A", "B"] }, { question: "Two", options: ["C", "D"] }] });
    expect(text(result)).toMatch(/^Stopped at question 2\/2: \(cancelled\)\..*Answered before stopping \(not submitted as a batch\):\n1\. One: A/s);
  });

  it("lets Paseo's own form collect the comment, and leaves Other… to it", async () => {
    process.env.PASEO_AGENT_ID = "a";
    const { calls, run } = dialogHost(["B", "looks fine"]);
    const result = await run({ question: "Pick", options: ["A", "B"], allowComment: true });
    expect(text(result)).toBe("User answered: B — looks fine");
    expect(calls[0]!.options).toEqual(["A", "B"]);
    expect(calls[1]).toMatchObject({ method: "input", placeholder: "Optional comment — leave empty to skip" });
  });
});

describe("ask_user rendering", () => {
  let tool: any;
  registerAskUser({ registerTool: (t: any) => (tool = t) } as any);

  it("shows the header or the question count on the call line", () => {
    expect(tool.renderCall({ question: "Which db?", header: "DB" }, theme).render(80).join("\n")).toContain("ask_user DB");
    expect(tool.renderCall({ questions: [{}, {}] }, theme).render(80).join("\n")).toContain("ask_user 2 questions");
  });

  it("summarises every answer on one line each", () => {
    const answer = (question: string, response: any) => ({ question, options: [], response, cancelled: !response, status: response ? "answered" : "cancelled" });
    const details = { ...answer("Two", { kind: "freeform", text: "hi" }), answers: [answer("One", { kind: "selection", selections: ["A"], comment: "ok" }), answer("Two", { kind: "freeform", text: "hi" }), answer("Three", null)] };
    const out = tool.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme).render(120).join("\n");
    expect(out).toContain("✓ One  →  A  “ok”");
    expect(out).toContain("✓ Two  →  “hi”");
    expect(out).toContain("✗ Three  cancelled");
  });

  it("lists the options with the chosen one marked when expanded", () => {
    const details = { question: "Pick", options: [{ title: "A" }, { title: "B", description: "bee" }], response: { kind: "selection", selections: ["B"] }, cancelled: false };
    const out = tool.renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme).render(120).join("\n");
    expect(out).toContain("○ A");
    expect(out).toContain("● B — bee");
  });
});

describe("confirm", () => {
  function confirmTool() {
    let tool: any;
    registerConfirm({ registerTool: (t: any) => (tool = t) } as any);
    return tool;
  }

  it("answers yes and no from the terminal, with y and n", async () => {
    const tool = confirmTool();
    const yes = fakeUI((c) => c.press("y"));
    const resultYes = await tool.execute("id", { question: "Delete?" }, undefined, undefined, { hasUI: true, ui: yes.ui });
    expect(resultYes.details.decision).toBe("yes");
    expect(yes.frames[0]!.join("\n")).toMatch(/╭─ confirm ─/);
    const no = fakeUI((c) => c.press("n"));
    expect((await tool.execute("id", { question: "Delete?" }, undefined, undefined, { hasUI: true, ui: no.ui })).content[0].text).toMatch(/^User declined: no\. Do not do it/);
  });

  it("puts No first for a dangerous action and reports a dismissal as not approved", async () => {
    const tool = confirmTool();
    const enter = fakeUI((c) => c.press(ENTER));
    expect((await tool.execute("id", { question: "Drop db?", danger: true }, undefined, undefined, { hasUI: true, ui: enter.ui })).details.decision).toBe("no");
    const esc = fakeUI((c) => c.press(ESC, ESC));
    const dismissed = await tool.execute("id", { question: "Drop db?" }, undefined, undefined, { hasUI: true, ui: esc.ui });
    expect(dismissed.details.decision).toBe("dismissed");
    expect(dismissed.content[0].text).toMatch(/not approved/);
  });

  it("uses the host's native confirm with the question in the title", async () => {
    const tool = confirmTool();
    const confirm = vi.fn(async () => true);
    const result = await tool.execute("id", { question: "Delete\n3 namespaces?", detail: "recreated on next PR" }, undefined, undefined, { hasUI: true, mode: "rpc", ui: { confirm } });
    expect(confirm).toHaveBeenCalledWith("Delete 3 namespaces?", "recreated on next PR", expect.anything());
    expect(result.details.decision).toBe("yes");
  });

  it("without a user, proceeds only on reversible actions and never on dangerous ones", async () => {
    const tool = confirmTool();
    expect((await tool.execute("id", { question: "Restart?" }, undefined, undefined, { hasUI: false })).content[0].text).toMatch(/Proceed only if the action is reversible/);
    expect((await tool.execute("id", { question: "Drop?", danger: true }, undefined, undefined, { hasUI: false })).content[0].text).toMatch(/Do not do it/);
  });
});

describe("askUser for pi-pi's own menus", () => {
  it("returns a selection, a cancel, or null without a UI", async () => {
    const { ui } = fakeUI((c) => c.press(DOWN, ENTER));
    expect(await askUser({ hasUI: true, ui }, { question: "Menu", options: ["One", "Two"], allowFreeform: false, allowComment: false })).toEqual({ kind: "selection", selections: ["Two"] });
    const esc = fakeUI((c) => c.press(ESC));
    expect(isCancel(await askUser({ hasUI: true, ui: esc.ui }, { question: "Menu", options: ["One", "Two"], allowFreeform: false }))).toBe(true);
    expect(await askQuestion({ hasUI: false, ui: null }, { question: "x" })).toBeNull();
  });
});
