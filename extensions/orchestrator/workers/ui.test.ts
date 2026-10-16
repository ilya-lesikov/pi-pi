import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_MESSAGE_TYPE, type WorkerMessageDetails } from "./delivery.js";
import { WorkerManager } from "./manager.js";
import type { WorkerSession, WorkerSessionHooks, WorkerSpawnSpec } from "./types.js";
import { openWorkerViewer, registerWorkerUi, WorkerViewer, WorkerWidget } from "./ui.js";

// Colors wrap text in escape codes, so a width check proves truncation counts visible cells only.
const theme = { fg: (_color: string, text: string) => `\x1b[33m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

const KEY = { escape: "\x1b", enter: "\r", up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F" };

function setup() {
  const sessions: Array<{ hooks: WorkerSessionHooks; finish(text?: string): void; transcript: unknown[]; interrupted: number }> = [];
  const manager = new WorkerManager({
    createSession: async (_spec, hooks) => {
      let resolve: () => void = () => {};
      let text = "";
      const entry = { hooks, transcript: [] as unknown[], interrupted: 0, finish(next = "done") { text = next; resolve(); } };
      sessions.push(entry);
      const session: WorkerSession = {
        run: () => new Promise<void>((done) => { resolve = done; }),
        steer() {},
        interruptTool: () => { entry.interrupted++; return entry.interrupted === 1; },
        abort() { resolve(); },
        dispose() {},
        setModel: async () => true,
        lastAssistantText: () => text,
        lastError: () => undefined,
        contextPercent: () => undefined,
        transcript: () => entry.transcript,
      };
      return session;
    },
    maxConcurrent: () => 2,
    stallWarnMs: () => 1000,
    stopGraceMs: 60_000,
  });
  return { manager, sessions };
}

function spec(overrides: Partial<WorkerSpawnSpec> = {}): WorkerSpawnSpec {
  return { type: "explore", description: "look around the auth module", prompt: "find it", model: "p/m", thinking: "high", notify: "wake", ...overrides };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function expectFits(lines: string[], width: number) {
  for (const line of lines) expect(visibleWidth(line), JSON.stringify(plain(line))).toBeLessThanOrEqual(width);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker update renderer", () => {
  function renderer() {
    let render: any;
    const handlers = new Map<string, () => Promise<void>>();
    const orchestrator: any = {
      workers: null,
      pi: { registerMessageRenderer: (type: string, fn: any) => { expect(type).toBe(WORKER_MESSAGE_TYPE); render = fn; }, on: (name: string, fn: any) => handlers.set(name, fn) },
    };
    registerWorkerUi(orchestrator);
    return { render: (details: WorkerMessageDetails | undefined, expanded = false) => render({ details }, { expanded }, theme), orchestrator, handlers };
  }

  const item = (overrides: Partial<WorkerMessageDetails["items"][number]> = {}): WorkerMessageDetails["items"][number] => ({
    kind: "settled", id: "explore-1", type: "explore", description: "find x", status: "completed", summary: "found x\nat a.ts:1", toolUses: 3, durationMs: 65_000, ...overrides,
  });

  it("renders nothing for a message without items", () => {
    const { render } = renderer();
    expect(render(undefined)).toBeUndefined();
    expect(render({ items: [] })).toBeUndefined();
  });

  it("shows a completed worker's stats and the first line of its summary, the whole summary when expanded", () => {
    const { render } = renderer();
    const collapsed = render({ items: [item()] }).render(200).map(plain);
    expect(collapsed[0]).toContain("✓ explore find x 1m5s · 3 tools");
    expect(collapsed[1]).toContain("⎿  found x");
    expect(collapsed.join("\n")).not.toContain("at a.ts:1");
    const expanded = render({ items: [item()] }, true).render(200).map(plain).join("\n");
    expect(expanded).toContain("at a.ts:1");
  });

  it("shows a failed worker's status and error, and a reviewer's findings", () => {
    const { render } = renderer();
    const failed = render({ items: [item({ status: "failed", error: "429 rate limited", summary: "" })] }).render(200).map(plain);
    expect(failed[0]).toContain("✗ explore find x failed · 1m5s · 3 tools");
    expect(failed[1]).toContain("⎿  429 rate limited");
    const review = render({ items: [item({ findings: 4, seriousFindings: 2, summary: "" }), item({ findings: 1, summary: "" })] }).render(200).map(plain);
    expect(review[0]).toContain("4 findings (2 critical/major)");
    expect(review[1]).toMatch(/1 findings$/);
  });

  it("shows a question and a stall notice", () => {
    const { render } = renderer();
    const lines = render({ items: [item({ kind: "question", question: "which db?" }), item({ kind: "stall", silentMs: 180_000 })] }).render(200).map(plain);
    expect(lines[0]).toBe("? explore find x asks: which db?");
    expect(lines[1]).toBe("… explore find x silent 3m");
  });

  it("wraps every item within the given width", () => {
    const { render } = renderer();
    const details = { items: [item({ summary: "x".repeat(300) }), item({ kind: "question", question: "why ".repeat(40) }), item({ status: "killed", error: "e".repeat(200) })] };
    for (const width of [20, 40, 80]) expectFits(render(details, true).render(width), width);
  });

  it("detaches the panel when the session shuts down", async () => {
    const { orchestrator, handlers } = renderer();
    expect(orchestrator.workerWidget).toBeInstanceOf(WorkerWidget);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    orchestrator.workerWidget.attach({ ui });
    await handlers.get("session_shutdown")!();
    expect(ui.setStatus).toHaveBeenLastCalledWith("workers", undefined);
  });
});

describe("WorkerWidget", () => {
  function mount(rows: number | undefined = 40) {
    const { manager, sessions } = setup();
    const orchestrator: any = { workers: manager };
    const widget = new WorkerWidget(orchestrator);
    let component: { render(width: number): string[] } | null = null;
    const tui = { terminal: { rows }, requestRender: vi.fn() };
    const ui = {
      setWidget: vi.fn((_key: string, factory: any) => { component = factory ? factory(tui, theme) : null; }),
      setStatus: vi.fn(),
    };
    widget.attach({ ui });
    return { manager, sessions, widget, ui, tui, orchestrator, render: (width: number) => component!.render(width), mounted: () => component !== null };
  }

  it("stays hidden with no workers and in a session without a UI", () => {
    const { ui, mounted } = mount();
    expect(mounted()).toBe(false);
    expect(ui.setStatus).toHaveBeenLastCalledWith("workers", undefined);
    const { manager } = setup();
    const headless = new WorkerWidget({ workers: manager } as any);
    const hidden = { setWidget: vi.fn(), setStatus: vi.fn() };
    headless.attach({ hasUI: false, ui: hidden });
    manager.spawn(spec());
    expect(hidden.setWidget).not.toHaveBeenCalled();
  });

  it("lists running, queued and asking workers, the one waiting on the user first", async () => {
    const { manager, sessions, ui, render } = mount();
    manager.spawn(spec());
    manager.spawn(spec({ type: "task", description: "fix it" }));
    manager.spawn(spec({ type: "librarian", description: "read docs" }));
    await flush();
    void sessions[1]!.hooks.askParent("which branch?\n  main or dev", undefined);
    expect(ui.setStatus).toHaveBeenLastCalledWith("workers", "3 workers · 1 waiting on you");
    const lines = render(120).map(plain);
    expect(lines[0]).toBe("Workers · 2 running · 1 queued · 1 waiting on you · /pp › Workers");
    expect(lines[1]).toMatch(/^⠋ task fix it 0s · 0 tools · task-2$/);
    expect(lines[2]).toBe("  ? asks (0s): which branch? main or dev");
    expect(lines[3]).toMatch(/^⠋ explore look around the auth module/);
    expect(lines[4]).toBe("  ⎿  starting: sending the prompt (0s)");
    expect(lines[5]).toBe("◦ librarian read docs queued");
  });

  it("shows what a running worker is doing: progress, step, last output, or its last line of text", async () => {
    const { manager, sessions, render } = mount();
    manager.spawn(spec());
    await flush();
    const hooks = sessions[0]!.hooks;
    hooks.onEvent();
    hooks.onStep("thinking");
    vi.advanceTimersByTime(5000);
    hooks.onOutput("hmm");
    vi.advanceTimersByTime(2000);
    expect(plain(render(200)[2]!)).toBe("  ⎿  thinking (7s) · last output 2s ago");
    hooks.reportProgress("read 3 of 5 files");
    expect(plain(render(200)[2]!)).toBe("  ⎿  read 3 of 5 files · thinking (7s) · last output 2s ago");
    const record = manager.list()[0]!;
    record.progress = undefined;
    record.step = undefined;
    record.lastText = "first\n\n  the   last line \n";
    expect(plain(render(200)[2]!)).toBe("  ⎿  the last line");
    record.lastText = "";
    expect(plain(render(200)[2]!)).toBe("  ⎿  thinking…");
  });

  it("marks a silent worker as stalled and advances the spinner while any is active", async () => {
    const { manager, sessions, render, tui } = mount();
    manager.spawn(spec());
    await flush();
    sessions[0]!.hooks.onEvent();
    vi.advanceTimersByTime(200);
    expect(plain(render(200)[1]!)).toMatch(/^⠙ /);
    expect(tui.requestRender).toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 120_000);
    manager.tick();
    expect(plain(render(200)[1]!)).toMatch(/^… explore .* silent 2m$/);
  });

  it("keeps a finished worker on the panel for a while, then removes the panel", async () => {
    const { manager, sessions, ui, render, mounted } = mount();
    manager.spawn(spec());
    manager.spawn(spec({ type: "task", description: "fix it" }));
    await flush();
    sessions[0]!.finish();
    manager.kill(manager.list()[1]!.id);
    await flush();
    expect(ui.setStatus).toHaveBeenLastCalledWith("workers", undefined);
    const lines = render(200).map(plain);
    expect(lines[0]).toBe("Workers · 0 running · 2 done · /pp › Workers");
    expect(lines[1]).toMatch(/^✓ explore look around the auth module \d+s · 0 tools · explore-1$/);
    expect(lines[2]).toMatch(/^✗ task fix it .* task-2 killed$/);
    expect(mounted()).toBe(true);
    vi.setSystemTime(Date.now() + 31_000);
    expect(render(200)).toEqual([]);
  });

  it("removes the panel once nothing is visible", async () => {
    const { manager, ui, widget } = mount();
    manager.spawn(spec());
    manager.kill(manager.list()[0]!.id);
    vi.setSystemTime(Date.now() + 31_000);
    widget.update();
    expect(ui.setWidget).toHaveBeenLastCalledWith("workers", undefined);
  });

  it("unregisters itself from its own refresh once the last worker ages out", async () => {
    const { manager, ui } = mount();
    manager.spawn(spec());
    await flush();
    // Settled out of band, so the widget hears nothing and only its ticker notices.
    manager.list()[0]!.status = "completed";
    manager.list()[0]!.settledAt = Date.now() - 31_000;
    vi.advanceTimersByTime(200);
    expect(ui.setWidget).toHaveBeenLastCalledWith("workers", undefined);
  });

  it("never exceeds its share of the terminal or the given width", async () => {
    const { manager, sessions, render } = mount(20);
    for (let i = 0; i < 6; i++) manager.spawn(spec({ description: `worker number ${i} with a long description` }));
    await flush();
    for (const session of sessions) void session.hooks.askParent("a very long question ".repeat(10), undefined);
    for (const width of [6, 10, 30, 80]) {
      const lines = render(width);
      expect(lines.length).toBeLessThanOrEqual(6);
      expectFits(lines, width);
      if (width >= 12) expect(plain(lines.at(-1)!)).toMatch(/… \d+ more/);
    }
  });

  it("caps at twelve rows when the terminal height is unknown", async () => {
    const { manager, render } = mount(undefined);
    for (let i = 0; i < 20; i++) manager.spawn(spec());
    expect(render(80).length).toBeLessThanOrEqual(12);
  });

  it("parks while suspended and comes back on resume", async () => {
    const { manager, ui, widget, mounted } = mount();
    manager.spawn(spec());
    expect(mounted()).toBe(true);
    widget.suspend();
    expect(mounted()).toBe(false);
    manager.spawn(spec());
    expect(mounted()).toBe(false);
    widget.resume();
    expect(mounted()).toBe(true);
    expect(ui.setWidget).toHaveBeenLastCalledWith("workers", expect.any(Function), { placement: "aboveEditor" });
  });

  it("follows the session's new manager and stops listening to the old one", async () => {
    const { manager, orchestrator, widget, ui } = mount();
    const next = setup().manager;
    orchestrator.workers = next;
    widget.follow();
    widget.follow();
    ui.setStatus.mockClear();
    manager.spawn(spec());
    expect(ui.setStatus).not.toHaveBeenCalled();
    next.spawn(spec());
    expect(ui.setStatus).toHaveBeenLastCalledWith("workers", "1 worker");
  });
});

describe("WorkerViewer", () => {
  function open(rows = 30) {
    const { manager, sessions } = setup();
    const tui: any = { terminal: { rows }, requestRender: vi.fn() };
    const done = vi.fn();
    const record = manager.spawn(spec());
    const viewer = new WorkerViewer(tui, theme, manager, record.id, done);
    const text = (width = 100) => viewer.render(width).map(plain);
    const type = (value: string) => { for (const ch of value) viewer.handleInput(ch); };
    return { manager, sessions, record, viewer, done, tui, text, type };
  }

  it("frames the transcript inside the given width", async () => {
    const { sessions, viewer } = open();
    await flush();
    sessions[0]!.transcript.push(
      { role: "user", content: "find the bug ".repeat(30) },
      { role: "assistant", content: [{ type: "text", text: "looking ".repeat(30) }, { type: "toolCall", name: "bash", arguments: { command: "grep -rn ".repeat(30) } }] },
      { role: "toolResult", content: [{ type: "text", text: "r".repeat(700) }] },
    );
    for (const width of [10, 24, 60, 120]) {
      const lines = viewer.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
    expect(viewer.render(9)).toEqual([]);
  });

  it("shows the task, the worker's text and tool calls, truncated results, and the current step", async () => {
    const { sessions, text } = open(60);
    await flush();
    sessions[0]!.hooks.onEvent();
    sessions[0]!.hooks.onStep("thinking");
    sessions[0]!.transcript.push(
      { role: "user", content: "find the bug" },
      { role: "custom", content: [{ type: "text", text: "steer: hurry" }] },
      { role: "assistant", content: [{ type: "text", text: "I will grep." }, { type: "toolCall", name: "bash", arguments: { command: "grep  -rn\nfoo" } }, { type: "toolCall", name: "x", arguments: { a: 1 } }] },
      { role: "toolResult", content: [{ type: "text", text: "r".repeat(700) }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: null }] },
      { role: "toolResult", content: "  " },
    );
    const body = text(200).join("\n");
    expect(body).toContain("explore look around the auth module · running");
    expect(body).toContain("[Task]");
    expect(body).toContain("find the bug");
    expect(body).toContain("[Message]");
    expect(body).toContain("steer: hurry");
    expect(body).toContain("[Worker]");
    expect(body).toContain("I will grep.");
    expect(body).toContain("[bash] grep -rn foo");
    expect(body).toContain('[x] {"a":1}');
    expect(body).toContain("… (truncated)");
    expect(body).toContain("▍ thinking (0s)");
    expect(body).toContain("Enter steer · i interrupt tool · x stop · K kill · ↑↓ PgUp/PgDn scroll · Esc close");
  });

  it("shows the result and error of a finished worker", async () => {
    const { sessions, record, text } = open();
    await flush();
    sessions[0]!.hooks.submitResult({ status: "partial", summary: "half done", body: "the rest is blocked" });
    sessions[0]!.finish();
    await flush();
    record.error = "ran out of time";
    const body = text(120).join("\n");
    expect(body).toContain("(no transcript retained)");
    expect(body).toContain("[Result: partial]");
    expect(body).toContain("half done");
    expect(body).toContain("the rest is blocked");
    expect(body).toContain("[Error]");
    expect(body).toContain("ran out of time");
    expect(body).toContain("Enter follow-up · ↑↓ PgUp/PgDn scroll · Esc close");
  });

  it("says when a worker is queued or no longer retained", () => {
    const { manager } = setup();
    const queued = [manager.spawn(spec()), manager.spawn(spec()), manager.spawn(spec())][2]!;
    const t = { terminal: { rows: 30 }, requestRender: vi.fn() } as any;
    const body = new WorkerViewer(t, theme, manager, queued.id, () => {}).render(80).map(plain).join("\n");
    expect(body).toContain("(queued)");
    const gone = new WorkerViewer(t, theme, manager, "nobody", () => {}).render(80).map(plain);
    expect(gone.join("\n")).toContain("This worker is no longer retained.");
    expect(gone).toHaveLength(4);
  });

  it("answers a pending question from the composer", async () => {
    const { sessions, viewer, text, type } = open();
    await flush();
    const answer = sessions[0]!.hooks.askParent("which db?", undefined);
    expect(text().join("\n")).toContain("? which db?");
    expect(text().at(-2)).toContain("Enter answer");
    viewer.handleInput("a");
    expect(text().at(-2)).toContain("answer ›");
    type("postgres");
    viewer.handleInput(KEY.enter);
    await expect(answer).resolves.toBe("postgres");
    expect(text().at(-2)).toContain("Answer sent.");
  });

  it("steers a running worker, ignores an empty message, and closes the composer on escape", async () => {
    const { manager, viewer, text, type, record } = open();
    await flush();
    const send = vi.spyOn(manager, "send");
    viewer.handleInput(KEY.enter);
    expect(text().at(-2)).toContain("steer ›");
    viewer.handleInput(KEY.escape);
    expect(text().at(-2)).not.toContain("steer ›");
    viewer.handleInput(KEY.enter);
    type("   ");
    viewer.handleInput(KEY.enter);
    expect(send).not.toHaveBeenCalled();
    viewer.handleInput(KEY.enter);
    type("hurry up");
    viewer.handleInput(KEY.enter);
    expect(send).toHaveBeenCalledWith(record.id, "hurry up");
    expect(text().at(-2)).toContain("Steer sent.");
  });

  it("reports what a message to a finished, queued or released worker did", async () => {
    const { manager, viewer, text, type } = open();
    const send = vi.spyOn(manager, "send");
    for (const [outcome, notice] of [["resumed", "Resumed with your message."], ["queued", "Added to its task."], ["gone", "It can no longer take messages."]] as const) {
      send.mockReturnValueOnce(outcome);
      viewer.handleInput(KEY.enter);
      type("more");
      viewer.handleInput(KEY.enter);
      expect(text().at(-2)).toContain(notice);
    }
  });

  it("interrupts the current tool and asks twice before stopping or killing", async () => {
    const { manager, record, viewer, text, sessions } = open();
    await flush();
    viewer.handleInput("i");
    expect(text().at(-2)).toContain("Interrupted the current tool call.");
    viewer.handleInput("i");
    expect(text().at(-2)).toContain("No tool call in progress.");
    expect(sessions[0]!.interrupted).toBe(2);
    const stop = vi.spyOn(manager, "stop");
    viewer.handleInput("x");
    expect(text().at(-2)).toContain("x again to STOP");
    viewer.handleInput("z");
    expect(text().at(-2)).not.toContain("x again to STOP");
    viewer.handleInput("x");
    viewer.handleInput("x");
    expect(stop).toHaveBeenCalledWith(record.id);
    expect(text().at(-2)).toContain("Asked to wrap up");
    viewer.handleInput("K");
    expect(text(200).at(-2)).toContain("K again to KILL");
    viewer.handleInput("K");
    expect(record.status).toBe("killed");
    expect(text(200).at(-2)).toContain("Killed.");
    viewer.handleInput("i");
    viewer.handleInput("x");
    expect(text().at(-2)).not.toContain("STOP");
  });

  it("scrolls the transcript and follows new output only from the bottom", async () => {
    const { sessions, viewer, text, tui, record } = open(12);
    await flush();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    sessions[0]!.transcript.push({ role: "user", content: lines });
    record.step = undefined;
    const visible = () => text(60).slice(3, 9).map((line) => line.replace(/[│ ]/g, ""));
    expect(visible().at(-1)).toBe("line39");
    viewer.handleInput(KEY.home);
    expect(visible()[0]).toBe("[Task]");
    viewer.handleInput(KEY.down);
    expect(visible()[0]).toBe("line0");
    viewer.handleInput(KEY.pageDown);
    expect(visible()[0]).toBe("line6");
    viewer.handleInput(KEY.pageUp);
    viewer.handleInput(KEY.up);
    expect(visible()[0]).toBe("[Task]");
    sessions[0]!.transcript.push({ role: "user", content: "newer" });
    expect(visible().at(-1)).toBe("line4");
    viewer.handleInput(KEY.end);
    expect(visible().at(-1)).toBe("newer");
    tui.requestRender.mockClear();
    viewer.handleInput("w");
    expect(tui.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("closes on escape or q and stops refreshing", () => {
    for (const key of [KEY.escape, "q"]) {
      const { viewer, done, tui } = open();
      viewer.handleInput(key);
      expect(done).toHaveBeenCalledTimes(1);
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(2000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    }
  });
});

describe("openWorkerViewer", () => {
  it("opens a full-screen overlay with the panel parked, and restores it after", async () => {
    const { manager } = setup();
    const record = manager.spawn(spec());
    const workerWidget = { suspend: vi.fn(), resume: vi.fn() };
    const orchestrator: any = { workers: manager, workerWidget };
    let viewer: any;
    const custom = vi.fn(async (factory: any, options: any) => {
      expect(workerWidget.suspend).toHaveBeenCalled();
      expect(workerWidget.resume).not.toHaveBeenCalled();
      expect(options).toMatchObject({ overlay: true, overlayOptions: { width: "100%" } });
      let closed: unknown = "open";
      viewer = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, (value: unknown) => { closed = value; });
      viewer.handleInput("q");
      expect(closed).toBeUndefined();
    });
    await openWorkerViewer(orchestrator, { ui: { custom } }, record.id);
    expect(viewer).toBeInstanceOf(WorkerViewer);
    expect(workerWidget.resume).toHaveBeenCalled();
  });

  it("restores the panel even when the overlay fails", async () => {
    const { manager } = setup();
    const record = manager.spawn(spec());
    const workerWidget = { suspend: vi.fn(), resume: vi.fn() };
    await expect(openWorkerViewer({ workers: manager, workerWidget } as any, { ui: { custom: async () => { throw new Error("no tty"); } } }, record.id)).rejects.toThrow("no tty");
    expect(workerWidget.resume).toHaveBeenCalled();
  });

  it("does nothing for an unknown worker or a UI without overlays", async () => {
    const { manager } = setup();
    const record = manager.spawn(spec());
    const custom = vi.fn();
    await openWorkerViewer({ workers: manager } as any, { ui: { custom } }, "nobody");
    await openWorkerViewer({ workers: manager } as any, { ui: {} }, record.id);
    await openWorkerViewer({ workers: null } as any, { ui: { custom } }, record.id);
    expect(custom).not.toHaveBeenCalled();
  });
});
