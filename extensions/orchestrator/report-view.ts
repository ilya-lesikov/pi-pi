import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { report } from "./notices.js";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

/**
 * Shows a report the user asked for from /pp. The terminal gets a scrollable
 * view that stays until closed; other hosts get it through the report
 * channel, which picks the surfaces that host actually shows.
 */
export async function showReport(ctx: any, title: string, text: string, level: "info" | "warning" | "error" = "info"): Promise<void> {
  const terminal = ctx?.mode === undefined || ctx?.mode === "tui";
  if (terminal && typeof ctx?.ui?.custom === "function") {
    await ctx.ui.custom((tui: TUI, theme: Theme, _keys: unknown, done: (value: undefined) => void) => new ReportView(tui, theme, title, text, () => done(undefined)), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
    });
    return;
  }
  await report(ctx, title, text, level);
}

class ReportView implements Component {
  private scroll = 0;
  private lastWidth = 80;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    private readonly text: string,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) return this.done();
    const total = this.body(this.lastWidth).length;
    const view = this.viewport();
    const max = Math.max(0, total - view);
    if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down")) this.scroll = Math.min(max, this.scroll + 1);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - view);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(max, this.scroll + view);
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = max;
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  private viewport(): number {
    return Math.max(3, (this.tui.terminal?.rows ?? 30) - 4);
  }

  private body(width: number): string[] {
    return this.text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
  }

  render(width: number): string[] {
    if (width < 10) return [];
    const th = this.theme;
    const inner = width - 4;
    this.lastWidth = inner;
    const body = this.body(inner);
    const view = Math.min(this.viewport(), body.length);
    const max = Math.max(0, body.length - view);
    const start = Math.min(this.scroll, max);
    const pad = (text: string) => text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
    const row = (text: string) => `${th.fg("border", "│")} ${truncateToWidth(pad(text), inner)} ${th.fg("border", "│")}`;
    const label = ` ${this.title} `;
    const top = th.fg("border", "╭─") + th.bold(truncateToWidth(label, Math.max(0, width - 4))) + th.fg("border", `${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`);
    const keys = [body.length > view ? "↑↓ PgUp/PgDn scroll" : "", "Esc close"].filter(Boolean).join(" · ");
    return [
      top,
      ...body.slice(start, start + view).map(row),
      row(th.fg("dim", keys)),
      th.fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];
  }
}
