import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerAskUser } from "./index.js";
import { askQuestion, askUser, isCancel } from "./ui.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const CTRL_E = "\x05";
const ALT_LEFT = "\x1b[1;3D";
const ALT_RIGHT = "\x1b[1;3C";

const BINDINGS: Record<string, string[]> = {
  "tui.input.submit": [ENTER],
  "tui.input.newLine": ["shift+enter"],
  "tui.select.confirm": [ENTER],
  "tui.select.cancel": [ESC, "\x03"],
  "tui.select.up": [UP],
  "tui.select.down": [DOWN],
};

const keybindings = {
  matches: (data: string, id: string) => (BINDINGS[id] ?? []).includes(data),
  getKeys: (id: string) => (BINDINGS[id] ?? []).map((key) => ({ [ENTER]: "enter", [ESC]: "escape", "\x03": "ctrl+c", [UP]: "up", [DOWN]: "down" })[key] ?? key),
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
    resolved: [] as unknown[],
    custom: (factory: any) => new Promise((settle) => {
      const resolve = (value: unknown) => (ui.resolved.push(value), settle(value));
      const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
      const component = factory(tui, theme, keybindings, resolve);
      component.frames = frames;
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

describe("ask_user tool", () => {
  it("returns a single selection with compatible details", async () => {
    const { run, ui } = harness((c) => c.press(DOWN, ENTER));
    const result = await run({ question: "Pick", context: " ctx ", options: ["A", { title: "B", description: "bee" }] });
    expect(text(result)).toBe("User answered: B");
    expect(result.details).toEqual({ question: "Pick", context: "ctx", options: [{ title: "A" }, { title: "B", description: "bee" }], response: { kind: "selection", selections: ["B"] }, cancelled: false });
    expect(ui.working).toEqual(["Waiting for user to answer…", undefined]);
  });

  it("takes a freeform answer from the Type something row", async () => {
    const { run, frames } = harness((c) => c.press(DOWN, ENTER, "h", "i", ENTER));
    const result = await run({ question: "Pick", options: ["A"] });
    expect(text(result)).toBe("User answered: hi");
    expect(result.details.response).toEqual({ kind: "freeform", text: "hi" });
    expect(screen(frames.slice(0, 1))).toContain("Type something.");
  });

  it("ignores an empty freeform submit and keeps the draft on esc", async () => {
    const { run } = harness((c) => {
      c.press(DOWN, ENTER, ENTER, "x", ESC);
      expect(screen(c.frames)).toContain("Question");
      c.press(ENTER, ENTER);
    });
    const result = await run({ question: "Pick", options: ["A"] });
    expect(text(result)).toBe("User answered: x");
  });

  it("adds a comment with ctrl+e", async () => {
    const { run } = harness((c) => {
      c.press(CTRL_E, "n", "o", "t", "e");
      expect(screen(c.frames)).toContain("Optional comment");
      expect(screen(c.frames)).toContain("Selected option:");
      c.press(ENTER);
    });
    const result = await run({ question: "Pick", options: ["A", "B"] });
    expect(text(result)).toBe("User answered: A — note");
    expect(result.details.response).toEqual({ kind: "selection", selections: ["A"], comment: "note" });
  });

  it("toggles and submits several options", async () => {
    const { run, frames } = harness((c) => c.press(SPACE, DOWN, DOWN, SPACE, "2", "2", ENTER));
    const result = await run({ question: "Pick", options: ["A", "B", "C"], allowMultiple: true });
    expect(text(result)).toBe("User answered: A, C");
    expect(screen(frames.slice(0, 4))).toContain("[✓] C");
  });

  it("salvages mangled options and the multiSelect alias", async () => {
    const { tool, run } = harness((c) => c.press(SPACE, DOWN, SPACE, DOWN, SPACE, ENTER));
    const prepared = tool.prepareArguments({ question: "Pick", multiSelect: true, options: [{ label: "L" }, { value: "V", description: "d" }, 3, { title: "" }, null], questions: [{ question: "q", multiSelect: false, options: [true] }] });
    expect(prepared).toEqual({ question: "Pick", allowMultiple: true, options: [{ title: "L" }, { title: "V", description: "d" }, { title: "3" }], questions: [{ question: "q", allowMultiple: false, options: [{ title: "true" }] }] });
    const result = await run({ question: "Pick", multiSelect: true, options: [{ label: "L" }, { value: "V" }, 3] });
    expect(text(result)).toBe("User answered: L, V, 3");
  });

  it("rejects neither and both question forms", async () => {
    const { run } = harness(() => {});
    const neither = await run({});
    expect(neither.isError).toBe(true);
    expect(text(neither)).toBe("ask_user requires `question` or a non-empty `questions` array");
    const both = await run({ question: "a", questions: [{ question: "b" }] });
    expect(both.isError).toBe(true);
    expect(text(both)).toBe("Use either `question` or `questions`, not both");
  });

  it("prints the question when there is no UI", async () => {
    const { run, ctx } = harness(() => {});
    ctx.hasUI = false;
    const single = await run({ question: "Pick", context: "why", options: ["A", { title: "B", description: "bee" }] });
    expect(single.isError).toBe(true);
    expect(text(single)).toBe("Ask requires interactive mode. Please answer:\n\nPick\n\nContext:\nwhy\n\nOptions:\n1. A\n2. B — bee\n\nYou can also answer freely.\n\nAfter choosing an option, you may add an optional comment.");
    const multi = await run({ questions: [{ question: "a" }, { question: "b" }] });
    expect(text(multi)).toBe("Ask requires interactive mode. 2 questions could not be presented.");
  });

  it("cancels with reason user on esc", async () => {
    const { run } = harness((c) => c.press(ESC));
    const result = await run({ question: "Pick", options: ["A"] });
    expect(text(result)).toBe("User cancelled the question");
    expect(result.details).toMatchObject({ cancelled: true, cancelReason: "user", response: null });
  });

  it("cancels with reason signal when aborted while open, and before opening", async () => {
    const controller = new AbortController();
    const { run, ui } = harness((c) => {
      controller.abort();
      c.press(ENTER);
    });
    const result = await run({ question: "Pick", options: ["A"] }, controller.signal);
    expect(result.details).toMatchObject({ cancelled: true, cancelReason: "signal" });
    expect(ui.resolved).toEqual([{ __cancel: true, reason: "signal" }]);

    let opened = false;
    const late = harness(() => (opened = true));
    const already = await late.run({ question: "Pick", options: ["A"] }, controller.signal);
    expect(already.details).toMatchObject({ cancelled: true, cancelReason: "signal" });
    expect(await askUser(late.ctx, { question: "Pick", options: ["A"], signal: controller.signal })).toEqual({ __cancel: true, reason: "signal" });
    expect(opened).toBe(false);
  });

  it("falls back to dialogs in rpc mode with a comment", async () => {
    const calls: any[] = [];
    const { run } = harness(() => {}, {
      select: async (...args: any[]) => (calls.push(["select", ...args]), "B"),
      input: async (...args: any[]) => (calls.push(["input", ...args]), "why"),
    }, { mode: "rpc" });
    const result = await run({ question: "Pick", options: ["A", "B"] });
    expect(text(result)).toBe("User answered: B — why");
    expect(calls[0].slice(0, 3)).toEqual(["select", "Pick", ["A", "B", "Type something…"]]);
    expect(calls[0][3]).toHaveProperty("signal");
    expect(calls[1][1]).toContain("Selected option:\n- B");
  });

  it("rejects a late dialog answer after abort without opening another dialog", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const { run } = harness(() => {}, {
      select: async () => {
        calls.push("select");
        controller.abort();
        return "A";
      },
      input: async () => (calls.push("input"), "x"),
    }, { mode: "rpc" });
    const result = await run({ question: "Pick", options: ["A"] }, controller.signal);
    expect(result.details).toMatchObject({ cancelled: true, cancelReason: "signal" });
    expect(calls).toEqual(["select"]);
  });

  it("falls back to dialogs when custom returns undefined", async () => {
    const result = await askUser({ hasUI: true, ui: { custom: async () => undefined, select: async () => "A" } }, { question: "Pick", options: ["A"], allowComment: false });
    expect(result).toEqual({ kind: "selection", selections: ["A"] });
  });

  it("asks for free text with input when there are no options", async () => {
    const answers = ["  note ", "  "];
    const ui = { input: async (_p: string, placeholder: string, opts: any) => (expect(placeholder).toBe("Type your answer..."), expect(opts).toHaveProperty("signal"), answers.shift()) };
    expect(await askUser({ hasUI: true, ui }, { question: "Why?", options: [], allowFreeform: true })).toEqual({ kind: "freeform", text: "note" });
    expect(await askUser({ hasUI: true, ui }, { question: "Why?", options: [] })).toBeNull();
  });

  it("returns the cancel sentinel from askUser for menus", async () => {
    const { ui } = fakeUI((c) => c.press(ESC));
    const result = await askUser({ hasUI: true, ui }, { question: "Menu", options: ["A"], allowFreeform: false, allowComment: false });
    expect(isCancel(result) && result.reason).toBe("user");
  });

  it("walks a sequence with back navigation, preselection and in-place overwrite", async () => {
    const { run, updates } = harness((c, step) => {
      const shown = screen(c.frames);
      if (step === 0) {
        expect(shown).toContain("Question 1/3");
        c.press(ALT_RIGHT);
        expect(c.frames.length).toBe(2);
        c.press(DOWN, ENTER);
      } else if (step === 1) {
        expect(shown).toContain("Question 2/3");
        c.press(SPACE, DOWN, SPACE, ENTER);
      } else if (step === 2) {
        c.press(ALT_LEFT);
      } else if (step === 3) {
        expect(shown).toContain("[✓] X");
        expect(shown).toContain("[✓] Y");
        c.press(ALT_LEFT);
      } else if (step === 4) {
        expect(shown).toMatch(/→ 2\. B/);
        c.press(UP, ENTER);
      } else if (step === 5) {
        expect(shown).toContain("[✓] Y");
        c.press(ALT_RIGHT);
      } else {
        expect(shown).toContain("Question 3/3");
        c.press(ENTER);
      }
    });
    const result = await run({ questions: [{ question: "one", options: ["A", "B"] }, { question: "two", options: ["X", "Y"], allowMultiple: true }, { question: "three", options: ["P"] }] });
    expect(text(result)).toBe("User answered:\n1. one: A\n2. two: X, Y\n3. three: P");
    expect(result.details.answers).toHaveLength(3);
    expect(result.details.question).toBe("three");
    expect(updates[0].content[0].text).toBe("Waiting for user input (1/3)...");
  });

  it("cancels the whole sequence from any question", async () => {
    const { run } = harness((c, step) => c.press(step === 0 ? ENTER : ESC));
    const result = await run({ questions: [{ question: "one", options: ["A"] }, { question: "two", options: ["B"] }] });
    expect(text(result)).toBe("User cancelled question 2/2");
    expect(result.details).toMatchObject({ question: "two", cancelled: true, cancelReason: "user" });
    expect(result.details.answers).toHaveLength(2);
  });
});

describe("ask component", () => {
  it("never renders wider than the given width", async () => {
    const { ui } = fakeUI((c) => {
      for (const width of [20, 7, 3, 100]) {
        for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      c.handleInput(CTRL_E);
      for (const line of c.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
      c.handleInput(ESC);
      c.handleInput(ESC);
    });
    await askUser({ hasUI: true, ui }, {
      question: "A question long enough to wrap at twenty columns",
      options: [{ title: "Option with a long title", description: "a fairly long description that has to wrap many times over" }, "B"],
      allowMultiple: true,
    });
  });

  it("scrolls long lists to keep the cursor visible", async () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ title: `opt${i + 1}`, description: "desc" }));
    const { ui, frames } = fakeUI((c) => {
      c.press(UP);
      c.press(ENTER);
    });
    const result = await askUser({ hasUI: true, ui }, { question: "Pick", options, allowFreeform: false });
    expect(result).toEqual({ kind: "selection", selections: ["opt30"] });
    expect(frames[0]!.length).toBeLessThanOrEqual(40);
    expect(screen(frames.slice(0, 2))).toContain("opt30");
    expect(screen(frames.slice(0, 2))).toContain("(30/30)");
  });

  it("clamps an invalid initial index to the first option", async () => {
    const picked: string[] = [];
    for (const initialIndex of [1, 7, -1, 0.5]) {
      const { ui } = fakeUI((c) => c.press(ENTER));
      const result: any = await askQuestion({ hasUI: true, ui }, { question: "Pick", options: ["A", "B"], initialIndex });
      picked.push(result.selections[0]);
    }
    expect(picked).toEqual(["B", "A", "A", "A"]);
  });
});
