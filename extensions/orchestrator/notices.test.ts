import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHost, fitLine } from "./host.js";
import { asCommand, attachHost, commandNotice, currentHost, notice, registerNotices, report } from "./notices.js";

function makePi(): any {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    on: vi.fn((name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
  };
}

function ctx(mode: string | undefined, idle = false): any {
  return { mode, isIdle: () => idle, ui: { notify: vi.fn() } };
}

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["BB_THREAD_ID", "PASEO_AGENT_ID", "T3_PI_RUNTIME_MODE", "ORCA_PANE_KEY", "ORCA_AGENT_LAUNCH_TOKEN"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("detectHost", () => {
  it("names each host by mode and the markers its spawner leaves", () => {
    expect(detectHost(undefined).id).toBe("tui");
    expect(detectHost("tui").id).toBe("tui");
    expect(detectHost("print").id).toBe("print");
    expect(detectHost("json").headless).toBe(true);
    expect(detectHost("rpc", {}).id).toBe("rpc");
    expect(detectHost("rpc", { BB_THREAD_ID: "t" }).id).toBe("bb");
    expect(detectHost("rpc", { PASEO_AGENT_ID: "a" }).id).toBe("paseo");
    expect(detectHost("rpc", { T3_PI_RUNTIME_MODE: "x" }).id).toBe("t3");
    expect(detectHost("rpc", { ORCA_PANE_KEY: "p" }).id).toBe("orca");
    // A marker leaking into a terminal session does not make it a host.
    expect(detectHost("tui", { BB_THREAD_ID: "t" }).id).toBe("tui");
  });

  it("knows which hosts end a command-only turn", () => {
    expect(detectHost("rpc", { BB_THREAD_ID: "t" }).settlesCommandOnlyPrompt).toBe(false);
    expect(detectHost("rpc", { PASEO_AGENT_ID: "a" }).settlesCommandOnlyPrompt).toBe(true);
    expect(detectHost("rpc", {}).settlesCommandOnlyPrompt).toBeUndefined();
  });

  it("learns that typed text is unavailable only from an instant cancel during a live run", () => {
    const host = detectHost("rpc", {});
    host.observeTextDialog(false, 5, false);
    expect(host.offersText).toBe(true);
    host.observeTextDialog(false, 2000, true);
    expect(host.offersText).toBe(true);
    host.observeTextDialog(false, 5, true);
    expect(host.offersText).toBe(false);
    host.observeTextDialog(true, 3000, true);
    expect(host.offersText).toBe(true);
    host.observeTextDialog(false, 5, true);
    expect(host.offersText).toBe(true);
  });
});

describe("fitLine", () => {
  it("flattens line breaks and truncates with an ellipsis", () => {
    expect(fitLine("a\n\nb   c", 20)).toBe("a b c");
    expect(fitLine("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
    expect(fitLine("x".repeat(30), 10)).toHaveLength(10);
  });
});

describe("notices", () => {
  it("keeps presentation messages out of the model's context", () => {
    const pi = makePi();
    registerNotices(pi);
    const filter = pi.handlers.get("context")[0];
    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: "pp-notice", content: "⚠ x" },
      { role: "custom", customType: "pp-report", content: "r" },
      { role: "custom", customType: "subagent-notification", content: "" },
      { role: "custom", customType: "pi-pi-worker", content: "w" },
    ];
    expect(filter({ messages }).messages.map((m: any) => m.customType ?? m.role)).toEqual(["user", "pi-pi-worker"]);
    expect(filter({ messages: messages.slice(0, 1) })).toBeUndefined();
  });

  it("only notifies in the terminal", () => {
    const pi = makePi();
    registerNotices(pi);
    const c = ctx("tui");
    attachHost(c);
    notice(c, "rerouted", "warning");
    expect(c.ui.notify).toHaveBeenCalledWith("rerouted", "warning");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("adds a chat copy on bb, where notify is dropped, and holds it for the next run while idle", async () => {
    process.env.BB_THREAD_ID = "t";
    const pi = makePi();
    registerNotices(pi);
    const live = ctx("rpc", false);
    attachHost(live);
    expect(currentHost().id).toBe("bb");
    notice(live, "rerouted", "warning");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pp-notice", content: "⚠ rerouted", display: true }), { triggerTurn: false });
    pi.sendMessage.mockClear();
    const idle = ctx("rpc", true);
    notice(idle, "config error", "error");
    notice(idle, "config error", "error");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await pi.handlers.get("agent_start")[0]({}, live);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toBe("✗ config error");
  });

  it("holds T3 notices raised between turns until a turn shows them, without a chat copy", async () => {
    process.env.T3_PI_RUNTIME_MODE = "x";
    const pi = makePi();
    registerNotices(pi);
    const idle = ctx("rpc", true);
    attachHost(idle);
    notice(idle, "startup problem", "warning");
    expect(idle.ui.notify).not.toHaveBeenCalled();
    const live = ctx("rpc", false);
    await pi.handlers.get("agent_start")[0]({}, live);
    expect(live.ui.notify).toHaveBeenCalledWith("startup problem", "warning");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("notifies once and replays only the chat copy on an unmarked host", async () => {
    const pi = makePi();
    registerNotices(pi);
    const idle = ctx("rpc", true);
    attachHost(idle);
    notice(idle, "x", "info");
    expect(idle.ui.notify).toHaveBeenCalledTimes(1);
    const live = ctx("rpc", false);
    await pi.handlers.get("agent_start")[0]({}, live);
    expect(live.ui.notify).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("writes to stderr without a UI", () => {
    const pi = makePi();
    registerNotices(pi);
    const c = ctx("print");
    attachHost(c);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    notice(c, "rerouted", "warning");
    report(c, "pi-pi · status", "line");
    expect(write.mock.calls.map((call) => call[0])).toEqual(["pi-pi: rerouted\n", "pi-pi · status\nline\n"]);
    expect(c.ui.notify).not.toHaveBeenCalled();
  });

  it("puts reports in the chat on bb and on unmarked hosts, but not on T3 or in the terminal", () => {
    for (const [env, mode, chat] of [[{}, "tui", false], [{ BB_THREAD_ID: "t" }, "rpc", true], [{ T3_PI_RUNTIME_MODE: "x" }, "rpc", false], [{}, "rpc", true], [{ PASEO_AGENT_ID: "a" }, "rpc", false]] as const) {
      Object.assign(process.env, env);
      const pi = makePi();
      registerNotices(pi);
      const c = ctx(mode);
      attachHost(c);
      report(c, "pi-pi · status", "Model x");
      expect(c.ui.notify).toHaveBeenCalledWith("pi-pi · status\nModel x", "info");
      expect(pi.sendMessage.mock.calls.length > 0).toBe(chat);
      for (const key of Object.keys(env)) delete process.env[key];
    }
  });

  it("strips presentation messages from what compaction summarizes", () => {
    const pi = makePi();
    registerNotices(pi);
    const preparation = {
      messagesToSummarize: [{ role: "user", content: "a" }, { role: "custom", customType: "pp-report", content: "r" }],
      turnPrefixMessages: [{ role: "custom", customType: "pp-notice", content: "n" }, { role: "assistant", content: [] }],
    };
    pi.handlers.get("session_before_compact")[0]({ preparation });
    expect(preparation.messagesToSummarize.map((m: any) => m.role)).toEqual(["user"]);
    expect(preparation.turnPrefixMessages.map((m: any) => m.role)).toEqual(["assistant"]);
  });

  it("shows a command's notices at once on T3, whose turn is open for the command", async () => {
    process.env.T3_PI_RUNTIME_MODE = "x";
    const pi = makePi();
    registerNotices(pi);
    const idle = ctx("rpc", true);
    attachHost(idle);
    await asCommand(async () => notice(idle, "Config update rejected", "error"));
    expect(idle.ui.notify).toHaveBeenCalledWith("Config update rejected", "error");
    delete process.env.T3_PI_RUNTIME_MODE;
  });

  it("on bb, sends a command notice as a chat message right away and shows an idle report in a text dialog", async () => {
    process.env.BB_THREAD_ID = "t";
    const pi = makePi();
    registerNotices(pi);
    const idle: any = ctx("rpc", true);
    idle.ui.editor = vi.fn(async () => undefined);
    attachHost(idle);
    commandNotice(idle, "may stay busy", "warning");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pp-notice", content: "⚠ may stay busy" }), { triggerTurn: false });
    await report(idle, "pi-pi · status", "Model x");
    expect(idle.ui.editor).toHaveBeenCalledWith("pi-pi · status (read-only; closing discards edits)", "Model x");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    delete process.env.BB_THREAD_ID;
  });
});
