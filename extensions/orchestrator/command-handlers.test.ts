import { afterEach, describe, expect, it, vi } from "vitest";
import { bbMenuAvailable, openBbMenu } from "./bb-menu.js";
import { registerCommandHandlers } from "./command-handlers.js";
import { attachHost } from "./notices.js";

vi.mock("./bb-menu.js", () => ({ bbMenuAvailable: vi.fn(async () => true), openBbMenu: vi.fn() }));
const showPpMenu = vi.fn(async () => {});
vi.mock("./pp-menu.js", () => ({ showPpMenu: (...args: any[]) => (showPpMenu as any)(...args) }));

function ppHandler() {
  let handler: (args: string, ctx: any) => Promise<void> = async () => {};
  const orchestrator: any = { pi: { registerCommand: (_name: string, options: any) => (handler = options.handler) } };
  registerCommandHandlers(orchestrator);
  return { orchestrator, run: (ctx: any) => handler("", ctx) };
}

afterEach(() => {
  delete process.env.BB_THREAD_ID;
  attachHost({ mode: "tui" });
  vi.clearAllMocks();
});

describe("/pp", () => {
  it("opens the plugin's menu in bb, and stays until it closes", async () => {
    process.env.BB_THREAD_ID = "thr_1";
    attachHost({ mode: "rpc" });
    let close!: () => void;
    vi.mocked(openBbMenu).mockReturnValue({ ok: true, message: "", closed: new Promise<void>((resolve) => (close = resolve)) });
    const { orchestrator, run } = ppHandler();
    const ctx = { mode: "rpc" };
    let done = false;
    const running = run(ctx).then(() => (done = true));
    await vi.waitFor(() => expect(openBbMenu).toHaveBeenCalledWith(orchestrator, ctx));
    expect(done).toBe(false);
    close();
    await running;
    expect(showPpMenu).not.toHaveBeenCalled();
  });

  it("shows pi's own menu where the plugin cannot draw one", async () => {
    process.env.BB_THREAD_ID = "thr_1";
    attachHost({ mode: "rpc" });
    vi.mocked(bbMenuAvailable).mockResolvedValueOnce(false);
    const { run } = ppHandler();
    await run({ mode: "rpc" });
    expect(openBbMenu).not.toHaveBeenCalled();
    expect(showPpMenu).toHaveBeenCalled();
  });
});
