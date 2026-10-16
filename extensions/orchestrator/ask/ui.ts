import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type Keybinding, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

export interface QuestionOption { title: string; description?: string }
export type AskResponse = { kind: "selection"; selections: string[]; comment?: string } | { kind: "freeform"; text: string };
export type CancelReason = "user" | "signal";
export interface AskCancel { __cancel: true; reason: CancelReason }
// A step through a `questions` sequence, reported the way a cancel is: execute() owns the index.
export interface AskNavigate { __navigate: "prev" | "next" }
export interface Navigation { index: number; total: number; canPrev: boolean; canNext: boolean }

export interface AskOptions {
  question: string;
  context?: string;
  options?: Array<string | QuestionOption>;
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  signal?: AbortSignal;
}

interface SequenceOptions {
  navigation?: Navigation;
  initialIndex?: number;
  checkedIndices?: number[];
}

interface Question {
  question: string;
  context?: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
}

type AskContext = { hasUI: boolean; ui: any; mode?: string };
type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type UIResult = AskResponse | AskCancel | AskNavigate | null;

const FREEFORM_ROW = "Type something.";
const FREEFORM_ENTRY = "Type something…";
// Proxies that mangle the option schema (Google function calling and the like) leave the model guessing the key.
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"];

const cancel = (reason: CancelReason): AskCancel => ({ __cancel: true, reason });

export function isCancel(value: unknown): value is AskCancel {
  return typeof value === "object" && value !== null && (value as AskCancel).__cancel === true;
}

export function isNavigate(value: unknown): value is AskNavigate {
  return typeof value === "object" && value !== null && "__navigate" in value;
}

function coerceOption(option: unknown): QuestionOption | null {
  if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
    const title = String(option).trim();
    return title ? { title } : null;
  }
  if (!option || typeof option !== "object") return null;
  const record = option as Record<string, unknown>;
  const key = OPTION_TITLE_KEYS.find((k) => typeof record[k] === "string" && (record[k] as string).trim());
  if (!key) return null;
  const title = (record[key] as string).trim();
  const description = typeof record.description === "string" && record.description.trim() ? record.description : undefined;
  return description ? { title, description } : { title };
}

export function normalizeOptions(options: readonly unknown[]): QuestionOption[] {
  return options.map(coerceOption).filter((option): option is QuestionOption => option !== null);
}

export function formatOptionList(options: readonly QuestionOption[]): string {
  return options.map((option, i) => `${i + 1}. ${option.title}${option.description ? ` — ${option.description}` : ""}`).join("\n");
}

export function formatResponse(response: AskResponse): string {
  if (response.kind === "freeform") return response.text;
  const selections = response.selections.join(", ");
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

function selection(selections: string[], comment?: string | null): AskResponse | null {
  const picked = selections.map((s) => s.trim()).filter(Boolean);
  if (!picked.length) return null;
  const note = comment?.trim();
  return note ? { kind: "selection", selections: picked, comment: note } : { kind: "selection", selections: picked };
}

function freeform(text: string | null | undefined): AskResponse | null {
  const trimmed = text?.trim();
  return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function withContext(q: Question): string {
  return q.context ? `${q.question}\n\nContext:\n${q.context}` : q.question;
}

export async function askUser(ctx: AskContext, opts: AskOptions): Promise<AskResponse | AskCancel | null> {
  // Without `navigation` the component never reports a step.
  return (await askQuestion(ctx, opts)) as AskResponse | AskCancel | null;
}

export async function askQuestion(ctx: AskContext, opts: AskOptions & SequenceOptions): Promise<UIResult> {
  if (!ctx.hasUI || !ctx.ui) return null;
  const { signal } = opts;
  if (signal?.aborted) return cancel("signal");
  const q: Question = {
    question: opts.question,
    context: opts.context?.trim() || undefined,
    options: normalizeOptions(opts.options ?? []),
    allowMultiple: opts.allowMultiple ?? false,
    allowFreeform: opts.allowFreeform ?? true,
    allowComment: opts.allowComment ?? true,
  };
  ctx.ui.setWorkingMessage?.("Waiting for user to answer…");
  try {
    if (!q.options.length) {
      const answer = await ctx.ui.input(withContext(q), "Type your answer...", { signal });
      return signal?.aborted ? cancel("signal") : freeform(answer);
    }
    if (ctx.mode === undefined || ctx.mode === "tui") {
      const result = await showComponent(ctx.ui, q, opts);
      if (signal?.aborted) return cancel("signal");
      if (result !== undefined) return result;
    }
    return await askViaDialogs(ctx.ui, q, signal);
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

async function showComponent(ui: any, q: Question, opts: AskOptions & SequenceOptions): Promise<UIResult | undefined> {
  const { signal } = opts;
  let onAbort: (() => void) | undefined;
  try {
    return await ui.custom((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: UIResult) => void) => {
      let settled = false;
      const finish = (result: UIResult) => {
        if (settled) return;
        settled = true;
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        done(result);
      };
      onAbort = () => finish(cancel("signal"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      return new AskComponent(q, opts, tui, theme, keybindings, finish);
    });
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

// RPC and other non-TUI hosts: custom() is unavailable, so walk the stock dialogs.
async function askViaDialogs(ui: any, q: Question, signal: AbortSignal | undefined): Promise<AskResponse | AskCancel | null> {
  const dialog = { signal };
  const prompt = withContext(q);
  let selections: string[];
  if (q.allowMultiple) {
    const raw = await ui.input(`${prompt}\n\nOptions (select one or more):\n${formatOptionList(q.options)}`, "Type your selection(s)...", dialog);
    if (signal?.aborted) return cancel("signal");
    if (raw == null) return null;
    selections = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    if (!selections.length) return null;
  } else {
    const titles = q.options.map((option) => option.title);
    const picked = await ui.select(prompt, q.allowFreeform ? [...titles, FREEFORM_ENTRY] : titles, dialog);
    if (signal?.aborted) return cancel("signal");
    if (picked == null) return null;
    if (picked === FREEFORM_ENTRY) {
      const answer = await ui.input(prompt, "Type your answer...", dialog);
      if (signal?.aborted) return cancel("signal");
      return freeform(answer);
    }
    selections = [picked];
  }
  if (!q.allowComment) return selection(selections);
  const label = selections.length === 1 ? "Selected option" : "Selected options";
  const comment = await ui.input(`${prompt}\n\n${label}:\n${selections.map((s) => `- ${s}`).join("\n")}`, "Optional comment (press Enter to skip)...", dialog);
  if (signal?.aborted) return cancel("signal");
  if (comment == null) return null;
  return selection(selections, comment);
}

class AskComponent implements Component, Focusable {
  private mode: "list" | "freeform" | "comment" = "list";
  private cursor: number;
  private top = 0;
  private readonly checked: Set<number>;
  private pending: string[] = [];
  private draft = "";
  private editor?: Editor;
  private cache?: { width: number; lines: string[] };
  private _focused = false;
  private readonly nav?: Navigation;

  constructor(
    private readonly q: Question,
    opts: SequenceOptions,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: (result: UIResult) => void,
  ) {
    const count = q.options.length;
    const initial = opts.initialIndex ?? 0;
    this.cursor = Number.isInteger(initial) && initial >= 0 && initial < count ? initial : 0;
    this.checked = new Set((opts.checkedIndices ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < count));
    this.nav = opts.navigation;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value && this.mode !== "list";
  }

  invalidate(): void {
    this.cache = undefined;
    this.editor?.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode === "list") this.handleListInput(data);
    else if (matchesKey(data, Key.escape)) this.closeEditor();
    else if (this.keys.matches(data, "tui.select.cancel")) this.done(cancel("user"));
    else this.editor!.handleInput(data);
    this.cache = undefined;
    this.tui.requestRender();
  }

  private handleListInput(data: string): void {
    const { options, allowMultiple, allowComment } = this.q;
    const count = options.length + (this.q.allowFreeform ? 1 : 0);
    const onFreeform = this.cursor === options.length;
    if (this.keys.matches(data, "tui.select.cancel")) return this.done(cancel("user"));
    if (this.nav && matchesKey(data, Key.alt("left"))) {
      if (this.nav.canPrev) this.done({ __navigate: "prev" });
      return;
    }
    if (this.nav && matchesKey(data, Key.alt("right"))) {
      if (this.nav.canNext) this.done({ __navigate: "next" });
      return;
    }
    if (allowComment && matchesKey(data, Key.ctrl("e"))) {
      if (!onFreeform) this.openEditor("comment", this.chosen());
      return;
    }
    // Before confirm: ctrl+j arrives as "\n", which also matches enter.
    if (this.keys.matches(data, "tui.select.up") || matchesKey(data, Key.ctrl("k"))) {
      this.cursor = (this.cursor + count - 1) % count;
      return;
    }
    if (this.keys.matches(data, "tui.select.down") || matchesKey(data, Key.ctrl("j"))) {
      this.cursor = (this.cursor + 1) % count;
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index >= options.length) return;
      this.cursor = index;
      if (allowMultiple) this.toggle(index);
      return;
    }
    if (allowMultiple && matchesKey(data, Key.space)) {
      if (onFreeform) this.openEditor("freeform");
      else this.toggle(this.cursor);
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (onFreeform) this.openEditor("freeform");
      else this.done(selection(this.chosen()));
    }
  }

  private toggle(index: number): void {
    if (!this.checked.delete(index)) this.checked.add(index);
  }

  private chosen(): string[] {
    const { options } = this.q;
    const checked = this.q.allowMultiple ? [...this.checked].sort((a, b) => a - b) : [];
    return (checked.length ? checked : [this.cursor]).map((i) => options[i]!.title);
  }

  private openEditor(mode: "freeform" | "comment", pending: string[] = []): void {
    if (!this.editor) {
      const t = this.theme;
      this.editor = new Editor(this.tui, {
        borderColor: (s) => t.fg("accent", s),
        selectList: {
          selectedPrefix: (s) => t.fg("accent", s),
          selectedText: (s) => t.fg("accent", s),
          description: (s) => t.fg("muted", s),
          scrollInfo: (s) => t.fg("dim", s),
          noMatch: (s) => t.fg("warning", s),
        },
      });
      this.editor.onSubmit = (text) => this.submitEditor(text);
    }
    this.mode = mode;
    this.pending = pending;
    this.editor.setText(mode === "freeform" ? this.draft : "");
    this.editor.focused = this._focused;
  }

  private closeEditor(): void {
    if (this.mode === "freeform") this.draft = this.editor!.getText();
    this.editor!.focused = false;
    this.mode = "list";
  }

  private submitEditor(text: string): void {
    if (this.mode === "comment") return this.done(selection(this.pending, text));
    const answer = freeform(text);
    if (answer) this.done(answer);
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    const border = (s: string) => t.fg("accent", s);
    const position = this.nav ? ` ${this.nav.index + 1}/${this.nav.total}` : "";
    const head = [
      t.fg("accent", t.bold(this.mode === "comment" ? "Optional comment" : `Question${position}`)),
      "",
      ...wrapTextWithAnsi(this.q.question, inner).map((line) => t.fg("dim", line)),
      "",
    ];
    const tail = ["", ...wrapTextWithAnsi(this.helpLine(), inner), ""];
    const body = this.mode === "list"
      ? this.listLines(inner, Math.max(4, this.tui.terminal.rows - head.length - tail.length - 3))
      : this.editorLines(inner);
    const label = " ask_user ";
    const fill = width - 3 - label.length;
    const top = fill > 0
      ? border("╭─") + t.fg("dim", t.bold(label)) + border(`${"─".repeat(fill)}╮`)
      : border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const lines = [
      top,
      ...["", ...head, ...body, ...tail].map((line) => border("│ ") + truncateToWidth(line, inner, "", true) + border(" │")),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ].map((line) => truncateToWidth(line, width, ""));
    if (this.mode === "list") this.cache = { width, lines };
    return lines;
  }

  private listLines(inner: number, maxRows: number): string[] {
    const t = this.theme;
    const { options, allowMultiple } = this.q;
    const pointer = (here: boolean) => (here ? t.fg("accent", "→") : " ");
    const blocks = options.map((option, i) => {
      const here = i === this.cursor;
      const number = `${i + 1}.`;
      const box = allowMultiple ? (this.checked.has(i) ? t.fg("success", "[✓]") : t.fg("dim", "[ ]")) + " " : "";
      const indent = 3 + number.length + (allowMultiple ? 4 : 0);
      const prefix = `${pointer(here)} ${t.fg("dim", number)} ${box}`;
      const lines = wrapTextWithAnsi(option.title, Math.max(1, inner - indent))
        .map((line, j) => (j === 0 ? prefix : " ".repeat(indent)) + t.fg(here ? "accent" : "text", t.bold(line)));
      if (option.description) {
        for (const line of wrapTextWithAnsi(option.description, Math.max(1, inner - 6))) lines.push(`      ${t.fg("muted", line)}`);
      }
      return lines;
    });
    if (this.q.allowFreeform) {
      const here = this.cursor === options.length;
      blocks.push([`${pointer(here)}   ${t.fg(here ? "accent" : "text", t.bold(FREEFORM_ROW))} ${t.fg("dim", "—")} ${t.fg("muted", "Enter a custom response")}`]);
    }
    if (blocks.reduce((n, block) => n + block.length, 0) <= maxRows) return blocks.flat();

    const room = maxRows - 1;
    const indicator = t.fg("dim", `  (${this.cursor + 1}/${blocks.length})`);
    const height = (from: number, to: number) => blocks.slice(from, to).reduce((n, block) => n + block.length, 0);
    let start = Math.min(this.top, this.cursor);
    while (start < this.cursor && height(start, this.cursor + 1) > room) start++;
    let end = start;
    let used = 0;
    while (end < blocks.length && used + blocks[end]!.length <= room) used += blocks[end++]!.length;
    if (end <= this.cursor) return [...blocks[this.cursor]!.slice(0, room), indicator];
    while (start > 0 && used + blocks[start - 1]!.length <= room) used += blocks[--start]!.length;
    this.top = start;
    return [...blocks.slice(start, end).flat(), indicator];
  }

  private editorLines(inner: number): string[] {
    const t = this.theme;
    const heading = this.mode === "freeform"
      ? [t.fg("accent", t.bold("Custom response"))]
      : [
        t.fg("accent", t.bold(this.pending.length === 1 ? "Selected option:" : "Selected options:")),
        ...wrapTextWithAnsi(this.pending.join(", "), inner).map((line) => t.fg("text", line)),
      ];
    return [...heading, "", ...this.editor!.render(inner)];
  }

  private helpLine(): string {
    const t = this.theme;
    const hint = (key: string, description: string) => `${t.fg("dim", key)}${t.fg("muted", ` ${description}`)}`;
    const keys = (id: Keybinding) => this.keys.getKeys(id).join("/");
    const otherCancel = this.keys.getKeys("tui.select.cancel").filter((key) => key !== "escape" && key !== "esc");
    const hints = this.mode === "list"
      ? [
        hint("↑↓", "navigate"),
        this.q.allowMultiple && hint("space", "toggle"),
        this.q.allowComment && hint("ctrl+e", "add context"),
        this.nav && hint("alt+←/alt+→", "prev/next question"),
        hint(keys("tui.select.confirm"), this.q.allowMultiple ? "submit" : "select"),
        hint(keys("tui.select.cancel"), "cancel"),
      ]
      : [
        hint(keys("tui.input.submit"), "submit"),
        hint(keys("tui.input.newLine"), "newline"),
        hint("esc", "back"),
        otherCancel.length > 0 && hint(otherCancel.join("/"), "cancel"),
      ];
    return hints.filter(Boolean).join(t.fg("dim", " • "));
  }
}
