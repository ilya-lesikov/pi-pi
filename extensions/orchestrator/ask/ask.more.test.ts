import { describe, expect, it } from "vitest";
import { registerAskUser } from "./index.js";
import { askQuestion, askUser } from "./ui.js";

const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_E = "\x05";
const CTRL_J = "\n";
const CTRL_K = "\x0b";
const SPACE = " ";
const ALT_LEFT = "\x1b[1;3D";
const ALT_RIGHT = "\x1b[1;3C";

const BINDINGS: Record<string, string[]> = {
  "tui.input.submit": [ENTER],
  "tui.input.newLine": ["shift+enter"],
  "tui.select.confirm": [ENTER],
  "tui.select.cancel": [ESC, CTRL_C],
  "tui.select.up": ["\x1b[A"],
  "tui.select.down": ["\x1b[B"],
};
const keybindings = {
  matches: (data: string, id: string) => (BINDINGS[id] ?? []).includes(data),
  getKeys: (id: string) => (BINDINGS[id] ?? []).map((key) => ({ [ENTER]: "enter", [ESC]: "escape", [CTRL_C]: "ctrl+c" })[key] ?? key),
};
const plain = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
// Tags colours so tests can tell which style a fragment was rendered in.
const tagged = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

function fakeUI(script: (component: any, step: number) => void, extra: Record<string, any> = {}) {
  let step = 0;
  return {
    custom: (factory: any) => new Promise((done) => {
      const component = factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, plain, keybindings, done);
      component.press = (...keys: string[]) => keys.forEach((key) => component.handleInput(key));
      component.screen = () => component.render(100).join("\n");
      script(component, step++);
    }),
    ...extra,
  };
}

function tool() {
  let registered: any;
  registerAskUser({ registerTool: (t: any) => (registered = t) } as any);
  return registered;
}

const render = (component: any) => component.render(200).map((line: string) => line.trimEnd()).join("\n");

describe("ask_user renderCall", () => {
  const { renderCall } = tool();

  it("shows the question, options and flags", () => {
    const out = render(renderCall({ question: "Pick", options: ["A", { title: "B" }, {}], allowMultiple: true, allowComment: true }, plain));
    expect(out).toContain("ask_user Pick");
    expect(out).toContain("3 option(s): A, B, ");
    expect(out).toContain("[multi-select]");
    expect(out).toContain("[optional comment]");
  });

  it("summarises a questions sequence by count and first question", () => {
    const out = render(renderCall({ questions: [{ question: "one" }, { question: "two" }] }, plain));
    expect(out).toContain("2 questions · one");
    expect(out).not.toContain("option(s)");
  });

  it("tolerates partially streamed arguments", () => {
    expect(render(renderCall({}, plain))).toContain("ask_user");
  });
});

describe("ask_user renderResult", () => {
  const { renderResult } = tool();
  const result = (details: any, content = "") => ({ content: [{ type: "text", text: content }], details });
  const answered = (question: string, response: any, extra: any = {}) => ({ question, options: [], response, cancelled: false, ...extra });

  it("renders errors in the error colour", () => {
    expect(render(renderResult(result({ error: "missing question" }), { expanded: false, isPartial: false }, tagged))).toContain("<error>✗ missing question</error>");
  });

  it("shows the streamed waiting text while partial, falling back to a default", () => {
    expect(render(renderResult(result({}, "Waiting for user input (2/3)..."), { expanded: false, isPartial: true }, plain))).toContain("Waiting for user input (2/3)...");
    expect(render(renderResult({ content: [{ type: "image" }], details: {} }, { expanded: false, isPartial: true }, plain))).toContain("Waiting for user input...");
  });

  it("shows Cancelled for cancelled, missing or unanswered details", () => {
    for (const details of [undefined, { cancelled: true, response: null }, { cancelled: false, response: null }]) {
      expect(render(renderResult(result(details), { expanded: true, isPartial: false }, plain))).toContain("Cancelled");
    }
  });

  it("collapses a multi-answer result to a count and lists the answers when expanded", () => {
    const answers = [answered("one", { kind: "selection", selections: ["A"] }), answered("two", { kind: "freeform", text: "hi" }), answered("three", null)];
    const details = { ...answers[1], answers };
    const collapsed = render(renderResult(result(details), { expanded: false, isPartial: false }, plain));
    expect(collapsed).toContain("✓ 3 answers");
    expect(collapsed).not.toContain("1. one");
    const expanded = render(renderResult(result(details), { expanded: true, isPartial: false }, plain));
    expect(expanded).toContain("1. one: A\n2. two: hi\n3. three: cancelled");
  });

  it("marks a freeform answer as written", () => {
    const out = render(renderResult(result(answered("Why", { kind: "freeform", text: "because" })), { expanded: true, isPartial: false }, plain));
    expect(out).toContain("✓ (wrote) because");
    expect(out).toContain("Q: Why");
    expect(out).not.toContain("Options:");
  });

  it("expands a selection into the question, context, options with chosen markers, and comment", () => {
    const details = answered("Pick", { kind: "selection", selections: ["B"], comment: "note" }, { context: "ctx", options: [{ title: "A" }, { title: "B", description: "bee" }] });
    const collapsed = render(renderResult(result(details), { expanded: false, isPartial: false }, plain));
    expect(collapsed.trim()).toBe("✓ B — note");
    const out = render(renderResult(result(details), { expanded: true, isPartial: false }, plain));
    expect(out).toContain("Q: Pick\nctx\nOptions:\n  ○ A\n  ● B — bee\nComment: note");
  });

  it("omits the comment line when the selection has none", () => {
    const details = answered("Pick", { kind: "selection", selections: ["A"] }, { options: [{ title: "A" }] });
    expect(render(renderResult(result(details), { expanded: true, isPartial: false }, plain))).not.toContain("Comment:");
  });
});

describe("ask_user execute", () => {
  it("passes non-object arguments through prepareArguments untouched", () => {
    const { prepareArguments } = tool();
    expect(prepareArguments(null)).toBeNull();
    expect(prepareArguments("x")).toBe("x");
    expect(prepareArguments({ question: "q", questions: [null, { question: "a", options: ["", "B"] }] })).toEqual({ question: "q", questions: [null, { question: "a", options: [{ title: "B" }] }] });
  });

  it("keeps an explicit allowMultiple over the multiSelect alias", () => {
    expect(tool().prepareArguments({ question: "q", allowMultiple: false, multiSelect: true })).toEqual({ question: "q", allowMultiple: false });
  });

  it("does not emit a waiting update for a single question without options", async () => {
    const t = tool();
    const updates: any[] = [];
    const ctx = { hasUI: true, ui: { input: async () => "free" } };
    const result = await t.execute("id", { question: "Why?" }, undefined, (u: any) => updates.push(u), ctx);
    expect(result.content[0].text).toBe("User answered: free");
    expect(updates).toEqual([]);
  });

  it("reports a null dialog answer as a cancel without a reason", async () => {
    const t = tool();
    const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined } };
    const result = await t.execute("id", { question: "Pick", options: ["A"] }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("User cancelled the question");
    expect(result.details).toEqual({ question: "Pick", context: undefined, options: [{ title: "A" }], response: null, cancelled: true });
  });

  it("stops a sequence at the cancelled question, keeping earlier answers", async () => {
    const t = tool();
    const ui = fakeUI((c, step) => c.press(step < 2 ? ENTER : CTRL_C));
    const updates: any[] = [];
    const result = await t.execute("id", { questions: [{ question: "one", options: ["A"] }, { question: "two", options: ["B"] }, { question: "three", options: ["C"] }, { question: "four", options: ["D"] }] }, undefined, (u: any) => updates.push(u), { hasUI: true, ui });
    expect(result.content[0].text).toBe("User cancelled question 3/4");
    expect(result.details.answers.map((a: any) => a.response?.selections?.[0] ?? null)).toEqual(["A", "B", null]);
    expect(updates.map((u) => u.content[0].text)).toEqual(["Waiting for user input (1/4)...", "Waiting for user input (2/4)...", "Waiting for user input (3/4)..."]);
  });

  it("asks an option-less sequence item via input and ignores navigation keys at the edges", async () => {
    const t = tool();
    const ui = fakeUI((c) => {
      c.press(ALT_LEFT, ALT_RIGHT);
      c.press(ENTER);
    }, { input: async () => "typed" });
    const result = await t.execute("id", { questions: [{ question: "one", options: ["A"] }, { question: "two" }] }, undefined, undefined, { hasUI: true, ui });
    expect(result.content[0].text).toBe("User answered:\n1. one: A\n2. two: typed");
  });

  it("returns no answer when there is no UI at all", async () => {
    expect(await askQuestion({ hasUI: true, ui: undefined }, { question: "q" })).toBeNull();
  });
});

describe("ask dialogs fallback", () => {
  const rpc = (ui: Record<string, any>) => ({ hasUI: true, mode: "rpc", ui });

  it("collects several selections from a comma list, then a comment", async () => {
    const prompts: string[] = [];
    const answers = [" A , ,C ", " ok "];
    const ui = { input: async (prompt: string) => (prompts.push(prompt), answers.shift()) };
    const result = await askUser(rpc(ui), { question: "Pick", context: "ctx", options: ["A", "B", "C"], allowMultiple: true });
    expect(result).toEqual({ kind: "selection", selections: ["A", "C"], comment: "ok" });
    expect(prompts[0]).toBe("Pick\n\nContext:\nctx\n\nOptions (select one or more):\n1. A\n2. B\n3. C");
    expect(prompts[1]).toContain("Selected options:\n- A\n- C");
  });

  it("treats a dismissed or blank multi-select input as no answer", async () => {
    for (const raw of [undefined, " , "]) {
      expect(await askUser(rpc({ input: async () => raw }), { question: "Pick", options: ["A"], allowMultiple: true })).toBeNull();
    }
  });

  it("skips the comment dialog when comments are disabled", async () => {
    let inputs = 0;
    const ui = { input: async () => (inputs++, "A") };
    expect(await askUser(rpc(ui), { question: "Pick", options: ["A"], allowMultiple: true, allowComment: false })).toEqual({ kind: "selection", selections: ["A"] });
    expect(inputs).toBe(1);
  });

  it("drops the selection when the comment dialog is dismissed, and keeps it on an empty comment", async () => {
    const comments = [undefined, "  "];
    const ui = { select: async () => "A", input: async () => comments.shift() };
    expect(await askUser(rpc(ui), { question: "Pick", options: ["A"] })).toBeNull();
    expect(await askUser(rpc(ui), { question: "Pick", options: ["A"] })).toEqual({ kind: "selection", selections: ["A"] });
  });

  it("routes the freeform entry to an input dialog", async () => {
    const choices: string[][] = [];
    const ui = { select: async (_p: string, titles: string[]) => (choices.push(titles), "Type something…"), input: async () => " mine " };
    expect(await askUser(rpc(ui), { question: "Pick", options: ["A"] })).toEqual({ kind: "freeform", text: "mine" });
    expect(choices[0]).toEqual(["A", "Type something…"]);
  });

  it("offers no freeform entry when freeform is disabled", async () => {
    const choices: string[][] = [];
    const ui = { select: async (_p: string, titles: string[]) => (choices.push(titles), "A") };
    await askUser(rpc(ui), { question: "Pick", options: ["A"], allowFreeform: false, allowComment: false });
    expect(choices[0]).toEqual(["A"]);
  });

  it("cancels with reason signal when aborted during any dialog", async () => {
    const cases: Array<[Record<string, any>, Record<string, any>]> = [
      [{ input: async () => "A" }, { allowMultiple: true }],
      [{ select: async () => "Type something…", input: async () => "x" }, {}],
      [{ select: async () => "A", input: async () => "c" }, {}],
    ];
    for (const [handlers, opts] of cases) {
      const controller = new AbortController();
      const ui = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (...args: any[]) => {
        const value = await fn(...args);
        if (name === "input") controller.abort();
        return value;
      }]));
      expect(await askUser(rpc(ui), { question: "Pick", options: ["A"], signal: controller.signal, ...opts })).toEqual({ __cancel: true, reason: "signal" });
    }
  });

  it("cancels with reason signal when aborted during the no-options input", async () => {
    const controller = new AbortController();
    const ui = { input: async () => (controller.abort(), "late") };
    expect(await askUser({ hasUI: true, ui }, { question: "Why?", signal: controller.signal })).toEqual({ __cancel: true, reason: "signal" });
  });
});

describe("ask component keys", () => {
  it("wraps the cursor with ctrl+k/ctrl+j and ignores digits past the options", async () => {
    const ui = fakeUI((c) => c.press("5", CTRL_K, CTRL_K, CTRL_K, CTRL_J, ENTER));
    // From A, up wraps through the freeform row to B then A; down returns to B.
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A", "B"] })).toEqual({ kind: "selection", selections: ["B"] });
  });

  it("selects by digit in single-select mode", async () => {
    const ui = fakeUI((c) => c.press("2", ENTER));
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A", "B"] })).toEqual({ kind: "selection", selections: ["B"] });
  });

  it("opens the freeform editor with space on the freeform row in multi-select", async () => {
    const ui = fakeUI((c) => {
      c.press(CTRL_K, SPACE);
      expect(c.screen()).toContain("Custom response");
      c.press("y", ENTER);
    });
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A"], allowMultiple: true })).toEqual({ kind: "freeform", text: "y" });
  });

  it("ignores ctrl+e on the freeform row and when comments are disabled", async () => {
    const ui = fakeUI((c, step) => {
      if (step === 0) c.press(CTRL_K, CTRL_E);
      else c.press(CTRL_E);
      expect(c.screen()).not.toContain("Optional comment");
      c.press(ESC);
    });
    await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A"] });
    await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A"], allowComment: false });
  });

  it("comments on all checked options and cancels from the editor with ctrl+c", async () => {
    const ui = fakeUI((c, step) => {
      c.press(SPACE, "2", CTRL_E);
      expect(c.screen()).toContain("Selected options:");
      expect(c.screen()).toContain("A, B");
      expect(c.screen()).toContain("ctrl+c cancel");
      c.press(step === 0 ? CTRL_C : ENTER);
    });
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A", "B"], allowMultiple: true })).toEqual({ __cancel: true, reason: "user" });
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A", "B"], allowMultiple: true })).toEqual({ kind: "selection", selections: ["A", "B"] });
  });

  it("forwards focus to the open editor only", async () => {
    const ui = fakeUI((c) => {
      c.focused = true;
      expect(c.focused).toBe(true);
      c.press(CTRL_E);
      c.focused = false;
      c.focused = true;
      c.invalidate();
      expect(c.screen()).toContain("Optional comment");
      c.press(ESC);
      c.focused = true;
      c.press(ENTER);
    });
    expect(await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A"] })).toEqual({ kind: "selection", selections: ["A"] });
  });

  it("shows only the cursor block when it does not fit the available rows", async () => {
    const huge = "word ".repeat(400);
    let frame = "";
    const ui = {
      custom: (factory: any) => new Promise((done) => {
        const c = factory({ requestRender() {}, terminal: { rows: 10, columns: 40 } }, plain, keybindings, done);
        c.handleInput(CTRL_J);
        frame = c.render(40).join("\n");
        c.handleInput(ENTER);
      }),
    };
    await askUser({ hasUI: true, ui }, { question: "Pick", options: ["A", { title: "B", description: huge }], allowFreeform: false });
    expect(frame).toContain("(2/2)");
    expect(frame).not.toContain("1. A");
  });

  it("does not resolve twice when aborted after the user already answered", async () => {
    const controller = new AbortController();
    const resolved: unknown[] = [];
    const ui = {
      custom: (factory: any) => new Promise((done) => {
        const c = factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, plain, keybindings, (v: unknown) => (resolved.push(v), done(v)));
        c.handleInput(ENTER);
        controller.abort();
      }),
    };
    const result = await askQuestion({ hasUI: true, ui }, { question: "Pick", options: ["A"], signal: controller.signal });
    expect(resolved).toEqual([{ kind: "selection", selections: ["A"] }]);
    // The abort lands before askQuestion resumes, so it still reports the signal.
    expect(result).toEqual({ __cancel: true, reason: "signal" });
  });
});
