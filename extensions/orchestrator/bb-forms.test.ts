import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormSpec as PluginFormSpec, FormValue as PluginFormValue } from "../../bb/forms.js";
import { BbForms, resetBbForms, type FormSpec, type FormValue } from "./bb-forms.js";
import { registerAskUser } from "./ask/index.js";
import { registerConfirm } from "./ask/confirm.js";

// The plugin keeps its own copy of the form types; these fail to compile when the two drift apart.
const specForPlugin = (spec: FormSpec): PluginFormSpec => spec;
const valueFromPlugin = (value: PluginFormValue): FormValue => value;

interface Call { method: string; body: any }

/** A fake of the plugin's RPC: `answer` decides each form_poll. */
function plugin(answer: (call: Call, polls: number) => any, options: { missing?: boolean; refuse?: boolean } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const fetch = vi.fn(async (url: string, init: any) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (options.missing) return new Response("{}", { status: 404 });
    if (options.refuse && method === "form_open") return new Response(JSON.stringify({ ok: false, error: { code: "handler_error", message: "Unsupported form: too long" } }), { status: 500 });
    let result: any = { ok: true };
    if (method === "form_poll") result = answer({ method, body }, ++polls);
    if (method === "form_cancel_session") result = { cancelled: 0 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const forms = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: fetch as any, sleep: async () => {} });
  return { forms, calls, fetch };
}

const ask: FormSpec = { version: 1, kind: "ask", questions: [{ question: "Pick", options: [{ title: "A" }, { title: "B" }], allowMultiple: false, allowFreeform: true, allowComment: true }] };

describe("bb forms", () => {
  it("opens a form, polls it, and returns the submitted value", async () => {
    const { forms, calls } = plugin((_call, polls) => (polls < 3 ? { state: "pending" } : { state: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: ["B"] }] } }));
    const outcome = await forms.ask(specForPlugin(ask) as FormSpec, { title: "Pick" });
    expect(outcome).toEqual({ outcome: "submitted", value: valueFromPlugin({ kind: "ask", answers: [{ kind: "selection", selections: ["B"] }] }) });
    expect(calls[0]).toMatchObject({ method: "form_open", body: { threadId: "thr_1", title: "Pick", form: ask } });
    expect(calls.filter((call) => call.method === "form_poll")).toHaveLength(3);
  });

  it("shows the form again when bb took it down without the user, and gives up after a few times", async () => {
    const { forms, calls } = plugin((_call, polls) => (polls === 1 ? { state: "unknown" } : polls === 2 ? { state: "cancelled", reason: "plugin-disposed" } : { state: "submitted", value: { kind: "decline" } }));
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "submitted", value: { kind: "decline" } });
    const opens = calls.filter((call) => call.method === "form_open");
    expect(opens).toHaveLength(3);
    // The same form each time, so a retried open never shows a second card.
    expect(new Set(opens.map((call) => call.body.formId)).size).toBe(1);
    const flapping = plugin(() => ({ state: "unknown" }));
    expect(await flapping.forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "cancelled", reason: "unreachable" });
  });

  it("reports the user's cancel as is", async () => {
    const { forms } = plugin(() => ({ state: "cancelled", reason: "user" }));
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "cancelled", reason: "user" });
  });

  it("falls back without showing anything when the plugin is not installed, and stops asking it for a while", async () => {
    const { forms, fetch } = plugin(() => ({ state: "pending" }), { missing: true });
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "unavailable" });
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back for a form the plugin refuses, but keeps using the plugin for the next", async () => {
    const { forms, fetch } = plugin(() => ({ state: "submitted", value: { kind: "decline" } }), { refuse: true });
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "unavailable" });
    await forms.ask(ask, { title: "Pick" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("takes down a form whose open it never heard back from, and falls back", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      const method = String(url).split("/").pop()!;
      calls.push(method);
      if (method === "form_open") throw new Error("timed out");
      return new Response(JSON.stringify({ ok: true, result: { ok: true } }), { status: 200 });
    });
    const forms = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: fetch as any, sleep: async () => {} });
    expect(await forms.ask(ask, { title: "Pick" })).toEqual({ outcome: "unavailable" });
    await Promise.resolve();
    expect(calls).toEqual(["form_open", "form_cancel"]);
  });

  it("counts the agent as asking from before the form opens, and remembers when it stopped", async () => {
    let busyDuringOpen = false;
    let now = 1000;
    const forms: BbForms = new BbForms({
      serverUrl: "http://bb.test",
      threadId: "thr_1",
      now: () => now,
      sleep: async () => {},
      fetch: (async (url: string) => {
        const method = String(url).split("/").pop()!;
        if (method === "form_open") busyDuringOpen = forms.busy;
        now = 5000;
        return new Response(JSON.stringify({ ok: true, result: method === "form_poll" ? { state: "cancelled", reason: "user" } : { ok: true } }), { status: 200 });
      }) as any,
    });
    await forms.ask(ask, { title: "Pick" });
    expect(busyDuringOpen).toBe(true);
    expect(forms.lastAskEndedAt).toBe(5000);
  });

  it("says the agent is asking while an ask form is up, but not for a worker's question", async () => {
    let seen: boolean[] = [];
    const { forms } = plugin((_call, polls) => {
      seen.push(forms.busy);
      return polls < 2 ? { state: "pending" } : { state: "cancelled", reason: "user" };
    });
    await forms.ask(ask, { title: "Pick" });
    expect(seen).toEqual([true, true]);
    expect(forms.busy).toBe(false);
    seen = [];
    await forms.ask({ version: 1, kind: "worker-question", workerId: "w", workerLabel: "w", questionId: "q", question: "?" }, { title: "w asks" });
    expect(seen.every((busy) => !busy)).toBe(true);
    // The user browsing pi-pi's menu is not the agent asking either.
    seen = [];
    await forms.ask(ask, { title: "Pick", fromMenu: true });
    expect(seen.every((busy) => !busy)).toBe(true);
  });

  it("tells a plugin too old to list its forms from one it could not ask", async () => {
    const old = plugin(() => ({ state: "pending" }), { missing: true });
    expect(await old.forms.supports(["input"])).toBe(false);
    const down = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any });
    expect(await down.supports(["input"])).toBeNull();
  });

  it("keeps the form's answer when it was submitted before a reply was typed, and passes the reply along", async () => {
    const { forms } = plugin(() => {
      forms.takeTyped("typed it");
      return { state: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: ["B"] }] } };
    });
    const outcome = await forms.ask(ask, { title: "Pick", onTyped: (text) => ({ kind: "ask", answers: [{ kind: "freeform", text }] }) });
    expect(outcome).toEqual({ outcome: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: ["B"] }] }, alsoTyped: "typed it" });
  });

  it("answers with a reply typed while the form is still pending", async () => {
    const { forms } = plugin((_call, polls) => {
      if (polls === 1) forms.takeTyped("typed it");
      return { state: "pending" };
    });
    const outcome = await forms.ask(ask, { title: "Pick", onTyped: (text) => ({ kind: "ask", answers: [{ kind: "freeform", text }] }) });
    expect(outcome).toEqual({ outcome: "submitted", value: { kind: "ask", answers: [{ kind: "freeform", text: "typed it" }] } });
  });

  it("does not return an answer that arrived after the tool call was aborted", async () => {
    const controller = new AbortController();
    const { forms } = plugin(() => {
      controller.abort();
      return { state: "submitted", value: { kind: "confirm", decision: "yes" } };
    });
    expect(await forms.ask(ask, { title: "Pick", signal: controller.signal })).toEqual({ outcome: "cancelled", reason: "signal" });
  });

  it("does not take a handler's not_found for a missing plugin", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "no such thread" } }), { status: 404 }));
    const forms = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: fetch as any, sleep: async () => {} });
    expect(await forms.supports(["input"])).toBeNull();
  });

  it("takes only the first reply typed in the chat; the next one is the agent's", async () => {
    const taken: boolean[] = [];
    const { forms } = plugin((_call, polls) => {
      if (polls === 1) taken.push(forms.takeTyped("go with B"), forms.takeTyped("and also check C"));
      return { state: "pending" };
    });
    const outcome = await forms.ask(ask, { title: "Pick", onTyped: (text) => ({ kind: "ask", answers: [{ kind: "freeform", text }] }) });
    expect(taken).toEqual([true, false]);
    expect(outcome).toEqual({ outcome: "submitted", value: { kind: "ask", answers: [{ kind: "freeform", text: "go with B" }] } });
  });

  it("takes a reply typed while the form is still opening, and keeps it if the open then fails", async () => {
    for (const openFails of [false, true]) {
      let release!: () => void;
      const opened = new Promise<void>((resolve) => { release = resolve; });
      const fetch = vi.fn(async (url: string) => {
        const method = String(url).split("/").pop()!;
        if (method === "form_open") {
          await opened;
          if (openFails) throw new Error("connection reset");
        }
        return new Response(JSON.stringify({ ok: true, result: method === "form_poll" ? { state: "pending" } : { ok: true } }), { status: 200 });
      });
      const forms = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: fetch as any, sleep: async () => {} });
      const outcome = forms.ask(ask, { title: "Pick", onTyped: (text) => ({ kind: "ask", answers: [{ kind: "freeform", text }] }) });
      await Promise.resolve();
      expect(forms.takeTyped("B")).toBe(true);
      release();
      expect(await outcome).toEqual({ outcome: "submitted", value: { kind: "ask", answers: [{ kind: "freeform", text: "B" }] } });
    }
  });

  it("gives up on a response whose body never arrives", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_url: string, init: any) => ({
        status: 200,
        ok: true,
        json: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }));
      const forms = new BbForms({ serverUrl: "http://bb.test", threadId: "thr_1", fetch: fetch as any, sleep: async () => {} });
      const outcome = forms.ask(ask, { title: "Pick" });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await outcome).toEqual({ outcome: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the form down when the tool call is aborted", async () => {
    const controller = new AbortController();
    const { forms, calls } = plugin((_call, polls) => {
      if (polls === 2) controller.abort();
      return { state: "pending" };
    });
    expect(await forms.ask(ask, { title: "Pick", signal: controller.signal })).toEqual({ outcome: "cancelled", reason: "signal" });
    await Promise.resolve();
    expect(calls.at(-1)?.method).toBe("form_cancel");
  });

  it("answers the newest open form with a reply typed in the chat", async () => {
    let typedDone = false;
    const { forms, calls } = plugin((_call, polls) => {
      if (polls === 2 && !typedDone) typedDone = forms.takeTyped("go with B");
      return { state: "pending" };
    });
    const outcome = await forms.ask(ask, { title: "Pick", onTyped: (text) => ({ kind: "ask", answers: [{ kind: "freeform", text }] }) });
    expect(outcome).toEqual({ outcome: "submitted", value: { kind: "ask", answers: [{ kind: "freeform", text: "go with B" }] } });
    expect(calls.at(-1)?.method).toBe("form_cancel");
    // Nothing open any more: a later message is the agent's.
    expect(forms.takeTyped("hello")).toBe(false);
  });
});

describe("ask_user and confirm under bb", () => {
  afterEach(() => {
    resetBbForms(undefined);
    delete process.env.BB_THREAD_ID;
  });

  function tools(forms: BbForms) {
    process.env.BB_THREAD_ID = "thr_1";
    resetBbForms(forms);
    const registered = new Map<string, any>();
    const pi: any = { registerTool: (tool: any) => registered.set(tool.name, tool) };
    registerAskUser(pi);
    registerConfirm(pi);
    const ui = { select: vi.fn(), confirm: vi.fn(async () => true), input: vi.fn(), notify: vi.fn() };
    const ctx = { hasUI: true, mode: "rpc", ui, isIdle: () => false };
    const run = (name: string, params: any) => {
      const tool = registered.get(name)!;
      return tool.execute("id", tool.prepareArguments ? tool.prepareArguments(params) : params, undefined, undefined, ctx);
    };
    return { run, ui };
  }

  const text = (result: any) => result.content.map((part: any) => part.text).join("");

  it("asks every question in one form and answers the model as the dialogs do", async () => {
    const { forms, calls } = plugin(() => ({ state: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: ["Unit", "Scan"], comment: "fast first" }, { kind: "freeform", text: "Friday" }] } }));
    const { run, ui } = tools(forms);
    const result = await run("ask_user", { questions: [
      { question: "Checks?", header: "Checks", options: [{ title: "Unit", description: "fast" }, "Lint", "Scan"], allowMultiple: true, recommended: "Unit" },
      { question: "When?", options: ["Today", "Friday"] },
    ] });
    expect(text(result)).toBe("User answered:\n1. Checks?: Unit, Scan — fast first\n2. When?: Friday");
    expect(ui.select).not.toHaveBeenCalled();
    expect(calls[0]!.body.form.questions[0]).toEqual({ question: "Checks?", header: "Checks", options: [{ title: "Unit", description: "fast" }, { title: "Lint" }, { title: "Scan" }], recommended: "Unit", allowMultiple: true, allowFreeform: true, allowComment: true });
  });

  it("reports a decline with its reason, as a cancel", async () => {
    const { forms } = plugin(() => ({ state: "submitted", value: { kind: "decline", note: "need more info" } }));
    const { run } = tools(forms);
    const result = await run("ask_user", { question: "Pick", options: ["A", "B"] });
    expect(result.details.status).toBe("cancelled");
    expect(text(result)).toContain('Their reason: "need more info"');
  });

  it("reports a cancelled form of several questions as a whole, and an empty answer as no answer", async () => {
    const { forms } = plugin(() => ({ state: "cancelled", reason: "user" }));
    const { run } = tools(forms);
    const several = await run("ask_user", { questions: [{ question: "A?", options: ["x", "z"] }, { question: "B?", options: ["y", "w"] }] });
    expect(text(several)).toMatch(/^User cancelled the form with all 2 questions\. Do not ask it again/);
    const empty = plugin(() => ({ state: "submitted", value: { kind: "ask", answers: [{ kind: "selection", selections: [] }] } }));
    const single = await tools(empty.forms).run("ask_user", { question: "Pick", options: ["A", "B"] });
    expect(single.details.status).toBe("cancelled");
  });

  it("does not report bb taking a form down as the user's decision", async () => {
    const { forms } = plugin(() => ({ state: "cancelled", reason: "thread-stopped" }));
    const { run } = tools(forms);
    expect(text(await run("confirm", { question: "Go?" }))).toMatch(/^Not confirmed — bb took the question down before the user answered \(thread-stopped\)/);
    expect(text(await run("ask_user", { question: "Pick", options: ["A", "B"] }))).toMatch(/bb took the form down \(thread-stopped\)/);
  });

  it("uses bb's dialogs when the plugin is not there", async () => {
    const { forms } = plugin(() => ({ state: "pending" }), { missing: true });
    const { run, ui } = tools(forms);
    ui.select.mockResolvedValueOnce("B" as never);
    expect(text(await run("ask_user", { question: "Pick", options: ["A", "B"] }))).toBe("User answered: B");
    expect(text(await run("confirm", { question: "Go?" }))).toMatch(/^User confirmed: yes/);
  });

  it("decides a confirm in the form, and a dangerous one leads with No", async () => {
    const { forms, calls } = plugin(() => ({ state: "submitted", value: { kind: "confirm", decision: "no", comment: "not today" } }));
    const { run, ui } = tools(forms);
    const result = await run("confirm", { question: "Drop the table?", detail: "prod", danger: true });
    expect(text(result)).toMatch(/^User declined: no\. They added: "not today"\./);
    expect(calls[0]!.body.form).toEqual({ version: 1, kind: "confirm", question: "Drop the table?", detail: "prod", danger: true });
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("reads a plain yes or no typed in the chat as the decision, and anything else as no decision", async () => {
    for (const [typed, expected] of [["yes", /^User confirmed: yes/], ["нет", /^User declined: no/], ["what does it drop?", /dismissed the question.*what does it drop\?/]] as const) {
      const { forms } = plugin((_call, polls) => {
        if (polls === 1) forms.takeTyped(typed);
        return { state: "pending" };
      });
      const { run } = tools(forms);
      expect(text(await run("confirm", { question: "Go?" }))).toMatch(expected);
    }
  });

  it("tells the model about a message typed after the form was submitted, with the form's answer", async () => {
    for (const [tool, params, value, expected] of [
      ["confirm", { question: "Go?" }, { kind: "confirm", decision: "yes" }, /^User confirmed: yes\.\nAfter deciding, the user also wrote in the chat: "and then deploy"$/],
      ["ask_user", { question: "Pick", options: ["A", "B"] }, { kind: "ask", answers: [{ kind: "selection", selections: ["B"] }] }, /^User answered: B\nAfter answering, the user also wrote in the chat: "and then deploy"$/],
    ] as const) {
      const { forms } = plugin(() => {
        forms.takeTyped("and then deploy");
        return { state: "submitted", value };
      });
      expect(text(await tools(forms).run(tool, params))).toMatch(expected);
    }
  });
});
