import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showReport } from "./report-view.js";
import { attachHost, registerNotices } from "./notices.js";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };

afterEach(() => {
  delete process.env.BB_THREAD_ID;
  attachHost({ mode: "tui" });
});

describe("showReport", () => {
  it("opens a scrollable view in the terminal that closes on esc", async () => {
    const frames: string[][] = [];
    const ui = {
      notify: vi.fn(),
      custom: (factory: any) => new Promise((resolve) => {
        const view = factory({ requestRender() {}, terminal: { rows: 8 } }, theme, null, resolve);
        frames.push(view.render(40));
        view.handleInput("\x1b[B");
        frames.push(view.render(40));
        view.handleInput("\x1b");
      }),
    };
    await showReport({ mode: "tui", ui }, "pi-pi · status", Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    expect(ui.notify).not.toHaveBeenCalled();
    expect(frames[0]![0]).toContain("pi-pi · status");
    expect(frames[0]!.join("\n")).toContain("line 0");
    expect(frames[1]!.join("\n")).not.toContain("line 0");
    expect(frames[0]!.join("\n")).toContain("↑↓ PgUp/PgDn scroll · Esc close");
    for (const line of frames[0]!) expect(visibleWidth(line)).toBe(40);
  });

  it("goes through the report channel on other hosts", async () => {
    process.env.BB_THREAD_ID = "t";
    const pi = { on: vi.fn(), sendMessage: vi.fn(), registerMessageRenderer: vi.fn() } as any;
    registerNotices(pi);
    const ctx = { mode: "rpc", isIdle: () => true, ui: { notify: vi.fn(), custom: vi.fn() } };
    attachHost(ctx);
    await showReport(ctx, "pi-pi · usage", "Total $1", "warning");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("pi-pi · usage\nTotal $1", "warning");
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pp-report", content: "pi-pi · usage\n\nTotal $1" }), { triggerTurn: false });
  });
});
