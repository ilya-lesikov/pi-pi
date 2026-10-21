import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { fitLine } from "../host.js";
import { currentHost, notice } from "../notices.js";

export interface QuestionOption { title: string; description?: string }
export type AskResponse =
  | { kind: "selection"; selections: string[]; other?: string; comment?: string }
  | { kind: "freeform"; text: string };
/** user: dismissed; signal: aborted; no_text: the host cannot collect typed text; incomplete: the host kept returning one answer. */
export type CancelReason = "user" | "signal" | "no_text" | "incomplete";
export interface AskCancel { __cancel: true; reason: CancelReason; note?: string }
// A step through a `questions` sequence, reported the way a cancel is: execute() owns the index.
export interface AskNavigate { __navigate: "prev" | "next" }
export interface Navigation { index: number; total: number; canPrev: boolean; canNext: boolean }

export interface AskOptions {
  question: string;
  /** Short label shown in the dialog frame. */
  header?: string;
  /** Muted lines under the question. */
  detail?: string;
  options?: Array<string | QuestionOption>;
  /** Title of the option to suggest: focused first and marked. */
  recommended?: string;
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  /** false: never. Unset: ctrl+e in the terminal only. true: also an "Add a comment…" entry elsewhere. */
  allowComment?: boolean;
  /** Esc in the terminal asks for an optional reason before cancelling. */
  declineNote?: boolean;
  signal?: AbortSignal;
}

export interface SequenceOptions {
  navigation?: Navigation;
  initialIndex?: number;
  checkedIndices?: number[];
  /** Paseo turns this select into its own form with a custom answer and a comment, and answers the follow-up inputs itself. */
  paseoCombined?: boolean;
  /** Frame label; "ask_user" by default. */
  label?: string;
  /** Keys that pick an option directly, by index. */
  hotkeys?: Record<string, number>;
}

interface Question {
  question: string;
  header?: string;
  detail?: string;
  options: QuestionOption[];
  recommended: number;
  allowMultiple: boolean;
  allowFreeform: boolean;
  commentOffered: boolean;
  commentEntry: boolean;
  declineNote: boolean;
}

type AskContext = { hasUI: boolean; ui: any; mode?: string; isIdle?: () => boolean };
type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type UIResult = AskResponse | AskCancel | AskNavigate | null;

export const OTHER = "Other…";
const ADD_COMMENT = "Add a comment…";
const ADD_OTHER = "Add your own…";
const SEVERAL = "Choose several…";
const BACK = "← Back";
const TITLE_MAX = 160;
const OPTION_MAX = 200;
// bb refuses a select with more than 64 entries; longer lists are paged.
const PAGE = 48;
const PAGED_ABOVE = 60;
// Proxies that mangle the option schema (Google function calling and the like) leave the model guessing the key.
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"];

const cancel = (reason: CancelReason, note?: string): AskCancel => (note ? { __cancel: true, reason, note } : { __cancel: true, reason });

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

export function formatOptionList(options: readonly QuestionOption[], recommended?: string): string {
  return options.map((option, i) => `${i + 1}. ${option.title}${option.title === recommended ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`).join("\n");
}

export function formatResponse(response: AskResponse): string {
  if (response.kind === "freeform") return response.text;
  const picked = [...response.selections, ...(response.other ? [`Other: ${response.other}`] : [])].join(", ");
  return response.comment ? `${picked} — ${response.comment}` : picked;
}

function selection(selections: string[], comment?: string | null, other?: string): AskResponse | null {
  const picked = selections.map((s) => s.trim()).filter(Boolean);
  const custom = other?.trim();
  if (!picked.length && !custom) return null;
  const note = comment?.trim();
  return { kind: "selection", selections: picked, ...(custom ? { other: custom } : {}), ...(note ? { comment: note } : {}) };
}

function freeform(text: string | null | undefined): AskResponse | null {
  const trimmed = text?.trim();
  return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function toQuestion(opts: AskOptions): Question {
  const options = normalizeOptions(opts.options ?? []);
  return {
    question: opts.question,
    header: opts.header?.trim() || undefined,
    detail: opts.detail?.trim() || undefined,
    options,
    recommended: opts.recommended ? options.findIndex((option) => option.title === opts.recommended) : -1,
    allowMultiple: opts.allowMultiple ?? false,
    allowFreeform: opts.allowFreeform ?? true,
    commentOffered: opts.allowComment !== false,
    commentEntry: opts.allowComment === true,
    declineNote: opts.declineNote ?? false,
  };
}

export async function askUser(ctx: AskContext, opts: AskOptions & Pick<SequenceOptions, "label" | "hotkeys">): Promise<AskResponse | AskCancel | null> {
  // Without `navigation` the component never reports a step.
  return (await askQuestion(ctx, opts)) as AskResponse | AskCancel | null;
}

export async function askQuestion(ctx: AskContext, opts: AskOptions & SequenceOptions): Promise<UIResult> {
  if (!ctx.hasUI || !ctx.ui) return null;
  const { signal } = opts;
  if (signal?.aborted) return cancel("signal");
  const q = toQuestion(opts);
  if (ctx.mode === undefined || ctx.mode === "tui") {
    const result = await showComponent(ctx.ui, q, opts);
    if (signal?.aborted) return cancel("signal");
    if (result !== undefined) return result;
  }
  return await askViaDialogs(ctx, q, opts);
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

interface Dialogs {
  ui: any;
  signal?: AbortSignal;
  runLive: () => boolean;
}

function dialogsFor(ctx: AskContext, signal: AbortSignal | undefined): Dialogs {
  return { ui: ctx.ui, signal, runLive: () => typeof ctx.isIdle === "function" && !ctx.isIdle() };
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${fitLine(label, OPTION_MAX - 6)} (${count})`;
  });
}

/**
 * One select, bounded the way the strictest host requires. Resolves the index
 * of the chosen label, the raw value when the host answered with something not
 * on the list, or undefined when it was dismissed.
 */
async function pick(d: Dialogs, title: string, labels: string[], fixed: string[] = []): Promise<number | string | undefined> {
  const fitted = uniqueLabels([...labels, ...fixed].map((label) => fitLine(label, OPTION_MAX)));
  const items = fitted.slice(0, labels.length);
  const tail = fitted.slice(labels.length);
  const paged = fitted.length > PAGED_ABOVE;
  let start = 0;
  for (;;) {
    const page = paged ? items.slice(start, start + PAGE) : items;
    const remaining = items.length - start - PAGE;
    const more = paged ? (remaining > 0 ? `More… (${remaining} more)` : "Back to the first page") : undefined;
    const shown = [...page, ...tail, ...(more ? [more] : [])];
    const raw = await d.ui.select(fitLine(title, TITLE_MAX), shown, { signal: d.signal });
    if (raw == null) return undefined;
    if (more && raw === more) {
      start = remaining > 0 ? start + PAGE : 0;
      continue;
    }
    const inPage = page.indexOf(String(raw));
    if (inPage >= 0) return start + inPage;
    const inTail = tail.indexOf(String(raw));
    return inTail >= 0 ? items.length + inTail : String(raw);
  }
}

/** One text dialog; teaches the host profile whether typed text reaches the user at all. */
async function typed(d: Dialogs, title: string, placeholder: string): Promise<{ text?: string; unavailable: boolean }> {
  const started = Date.now();
  const live = d.runLive();
  const raw = await d.ui.input(fitLine(title, TITLE_MAX), placeholder, { signal: d.signal });
  const host = currentHost();
  host.observeTextDialog(raw != null, Date.now() - started, live && !d.signal?.aborted);
  return raw != null ? { text: String(raw), unavailable: false } : { unavailable: !host.offersText };
}

function optionLabel(option: QuestionOption, recommended: boolean): string {
  return `${option.title}${recommended ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`;
}

function quoted(text: string, max = 40): string {
  return `“${fitLine(text, max)}”`;
}

// RPC and other non-TUI hosts: custom() is unavailable, so walk the stock dialogs.
async function askViaDialogs(ctx: AskContext, q: Question, opts: SequenceOptions & { signal?: AbortSignal }): Promise<UIResult> {
  const { signal, navigation: nav } = opts;
  const d = dialogsFor(ctx, signal);
  const host = currentHost();
  const prefix = nav ? `(${nav.index + 1}/${nav.total}) ` : "";
  if (prefix.length + q.question.length > TITLE_MAX) notice(ctx, q.question, "info");
  if (!q.options.length) {
    const answer = await typed(d, `${prefix}${q.question}`, "Type your answer");
    if (signal?.aborted) return cancel("signal");
    if (answer.text !== undefined) return freeform(answer.text);
    return answer.unavailable ? cancel("no_text") : null;
  }
  const textEntries = () => !opts.paseoCombined && host.offersText;
  let typingNote = "";
  let comment: string | undefined;
  let other: string | undefined;
  const checked = new Set(q.allowMultiple ? opts.checkedIndices ?? [] : []);
  // Hosts show each select as a form with its own Submit, so a pick must be an
  // answer: a multi-select starts as a plain list, and toggling is a mode the
  // user asks for, in which a pick only adds or removes and Done answers.
  let several = checked.size > 0;
  let last = -1;
  let repeats = 0;
  const steps = 2 * q.options.length + 8;
  for (let step = 0; step < steps; step++) {
    const count = checked.size + (other ? 1 : 0);
    const labels = q.options.map((option, i) => {
      const label = optionLabel(option, i === q.recommended);
      return several ? `${checked.has(i) ? "☑" : "☐"} ${label}` : label;
    });
    const chosenNames = [...[...checked].sort((a, b) => a - b).map((i) => q.options[i]!.title), ...(other ? [other] : [])];
    const done = `Done — use ${count} selected`;
    const extras: string[] = [];
    if (q.allowMultiple && !several) extras.push(SEVERAL);
    if (q.allowFreeform && textEntries()) extras.push(several ? (other ? `Change your own… ${quoted(other)}` : ADD_OTHER) : OTHER);
    if (q.commentEntry && textEntries()) extras.push(comment ? `Change comment… ${quoted(comment)}` : ADD_COMMENT);
    if (nav?.canPrev) extras.push(BACK);
    const state = several ? `(${count} selected${count ? `: ${chosenNames.join(", ")}` : ""}; pick to add or remove) ` : comment ? "(comment added) " : "";
    // Done goes first, where it is seen, and a host that answers with the first entry can still finish.
    const head = several && count > 0 ? [done] : [];
    let picked = await pick(d, `${prefix}${typingNote}${state}${q.question}`, [...head, ...labels], extras);
    if (typeof picked === "number") {
      if (picked < head.length) return selection(chosenNames.slice(0, checked.size), comment, other);
      picked -= head.length;
    }
    if (signal?.aborted) return cancel("signal");
    if (picked === undefined) return null;
    // A host that answers with the bare title rather than the label it was shown.
    if (typeof picked === "string") {
      const byTitle = q.options.findIndex((option) => option.title === picked);
      if (byTitle >= 0) picked = byTitle;
      else if (!q.allowFreeform) continue;
    }
    if (typeof picked === "number" && picked < labels.length) {
      if (!several) {
        const title = q.options[picked]!.title;
        if (!opts.paseoCombined) return selection([title], comment);
        const note = await typed(d, `Comment on ${quoted(title)}`, "Optional comment — leave empty to skip");
        if (signal?.aborted) return cancel("signal");
        return selection([title], note.text);
      }
      repeats = picked === last ? repeats + 1 : 1;
      last = picked;
      if (repeats >= 6) return cancel("incomplete", chosenNames.join(", "));
      if (!checked.delete(picked)) checked.add(picked);
      continue;
    }
    const extra = typeof picked === "number" ? extras[picked - labels.length]! : undefined;
    if (extra === BACK) return { __navigate: "prev" };
    if (extra === SEVERAL) {
      several = true;
      continue;
    }
    if (extra === ADD_COMMENT || extra?.startsWith("Change comment")) {
      const note = await typed(d, `Comment — ${q.question}`, "Your comment; then pick an option");
      if (signal?.aborted) return cancel("signal");
      if (note.text !== undefined) comment = note.text.trim() || undefined;
      else if (note.unavailable) typingNote = "(typing is unavailable here) ";
      continue;
    }
    // "Other…", or a value the host made up: Paseo answers its own custom
    // entry with a marker and fills the next text dialog with what was typed.
    const answer = await typed(d, `Your answer — ${q.question}`, "Type your answer");
    if (signal?.aborted) return cancel("signal");
    const text = answer.text?.trim() || (extra === undefined && typeof picked === "string" ? picked.trim() : "");
    if (text) {
      if (!q.allowMultiple && opts.paseoCombined) {
        // Paseo's form took a comment with the custom answer and hands it to
        // the next optional input; asking keeps it from being dropped.
        const note = await typed(d, "Comment on your answer", "Optional comment — leave empty to skip");
        if (signal?.aborted) return cancel("signal");
        return freeform(note.text?.trim() ? `${text}\n\nComment: ${note.text.trim()}` : text);
      }
      if (!several) return q.allowMultiple ? selection([], comment, text) : freeform(text);
      other = text;
    } else if (answer.unavailable) {
      typingNote = "(typing is unavailable here) ";
    }
  }
  return cancel("incomplete");
}

/** The last step of a sequence of questions outside the terminal: submit, or go back to one. */
export async function reviewAnswers(ctx: AskContext, lines: string[], signal?: AbortSignal): Promise<"submit" | number | undefined> {
  const d = dialogsFor(ctx, signal);
  // Submit first: a host that answers a select with its first entry (MonoCode's Allow) must still be able to submit.
  const picked = await pick(d, "Submit these answers?", ["Submit", ...lines.map((line, i) => `Change ${i + 1}: ${line}`)]);
  if (typeof picked !== "number") return undefined;
  return picked === 0 ? "submit" : picked - 1;
}

class AskComponent implements Component, Focusable {
  private mode: "list" | "freeform" | "comment" | "decline" = "list";
  private cursor: number;
  private top = 0;
  private readonly checked: Set<number>;
  private other: string | undefined;
  private pending: string[] = [];
  private draft = "";
  private editor?: Editor;
  private cache?: { width: number; lines: string[] };
  private _focused = false;
  private readonly nav?: Navigation;
  private readonly label: string;
  private readonly hotkeys: Record<string, number>;

  constructor(
    private readonly q: Question,
    opts: SequenceOptions,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: (result: UIResult) => void,
  ) {
    const count = q.options.length;
    const initial = opts.initialIndex ?? (q.recommended >= 0 ? q.recommended : 0);
    this.cursor = Number.isInteger(initial) && initial >= 0 && initial < count ? initial : 0;
    this.checked = new Set((opts.checkedIndices ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < count));
    this.nav = opts.navigation;
    this.label = opts.label ?? "ask_user";
    this.hotkeys = opts.hotkeys ?? {};
    if (!count) this.openEditor("freeform");
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
    else this.handleEditorInput(data);
    this.cache = undefined;
    this.tui.requestRender();
  }

  // ctrl+c never cancels a question: it is too easy to hit while meaning to
  // clear or quit, and a question dismissed by accident costs a turn.
  private isCancelKey(data: string): boolean {
    if (matchesKey(data, Key.ctrl("c"))) return false;
    return matchesKey(data, Key.escape) || this.keys.matches(data, "tui.select.cancel");
  }

  private handleEditorInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) return;
    if (!matchesKey(data, Key.escape)) return this.editor!.handleInput(data);
    if (this.mode === "decline") return this.done(cancel("user"));
    if (!this.q.options.length) return this.decline();
    this.closeEditor();
  }

  private handleListInput(data: string): void {
    const { options, allowMultiple } = this.q;
    const total = options.length + (this.q.allowFreeform ? 1 : 0);
    const onOther = this.cursor === options.length;
    if (this.isCancelKey(data)) return this.decline();
    if (this.nav && (matchesKey(data, Key.alt("left")) || matchesKey(data, Key.left))) {
      if (this.nav.canPrev) this.done({ __navigate: "prev" });
      return;
    }
    if (this.nav && (matchesKey(data, Key.alt("right")) || matchesKey(data, Key.right))) {
      if (this.nav.canNext) this.done({ __navigate: "next" });
      return;
    }
    if (this.q.commentOffered && matchesKey(data, Key.ctrl("e"))) {
      if (onOther && !allowMultiple) return;
      if (allowMultiple && !this.checked.size && !this.other && !onOther) this.checked.add(this.cursor);
      const chosen = this.chosen();
      if (chosen.length || this.other) this.openEditor("comment", chosen);
      return;
    }
    const hotkey = this.hotkeys[data.toLowerCase()];
    if (hotkey !== undefined && hotkey < options.length) return this.done(selection([options[hotkey]!.title]));
    // Before confirm: ctrl+j arrives as "\n", which also matches enter.
    if (this.keys.matches(data, "tui.select.up") || matchesKey(data, Key.ctrl("k"))) {
      this.cursor = (this.cursor + total - 1) % total;
      return;
    }
    if (this.keys.matches(data, "tui.select.down") || matchesKey(data, Key.ctrl("j"))) {
      this.cursor = (this.cursor + 1) % total;
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index >= total) return;
      this.cursor = index;
      if (index === options.length) return this.openEditor("freeform");
      if (allowMultiple) this.toggle(index);
      else this.done(selection([options[index]!.title]));
      return;
    }
    if (allowMultiple && matchesKey(data, Key.space)) {
      if (onOther) this.openEditor("freeform");
      else this.toggle(this.cursor);
      return;
    }
    if (!this.keys.matches(data, "tui.select.confirm")) return;
    if (onOther && !(allowMultiple && (this.other || this.checked.size))) return this.openEditor("freeform");
    if (!allowMultiple) return this.done(selection([options[this.cursor]!.title]));
    // Enter with nothing checked checks the item under the cursor rather than
    // submitting something the user never picked.
    if (!this.checked.size && !this.other) return this.toggle(this.cursor);
    this.done(selection(this.chosen(), undefined, this.other));
  }

  private decline(): void {
    if (this.q.declineNote) this.openEditor("decline");
    else this.done(cancel("user"));
  }

  private toggle(index: number): void {
    if (!this.checked.delete(index)) this.checked.add(index);
  }

  private chosen(): string[] {
    const { options } = this.q;
    if (!this.q.allowMultiple) return [options[this.cursor]!.title];
    return [...this.checked].sort((a, b) => a - b).map((i) => options[i]!.title);
  }

  private openEditor(mode: "freeform" | "comment" | "decline", pending: string[] = []): void {
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
    this.editor.setText(mode === "freeform" ? this.other ?? this.draft : "");
    this.editor.focused = this._focused;
  }

  private closeEditor(): void {
    if (this.mode === "freeform") this.draft = this.editor!.getText();
    this.editor!.focused = false;
    this.mode = "list";
  }

  private submitEditor(text: string): void {
    if (this.mode === "decline") return this.done(cancel("user", text.trim() || undefined));
    if (this.mode === "comment") return this.done(selection(this.pending, text, this.other));
    if (this.q.allowMultiple) {
      this.other = text.trim() || undefined;
      this.draft = "";
      this.closeEditor();
      this.cache = undefined;
      return;
    }
    const answer = freeform(text);
    if (answer) this.done(answer);
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    const border = (s: string) => t.fg("accent", s);
    const head = [
      "",
      ...wrapTextWithAnsi(this.q.question, inner).map((line) => t.fg("text", t.bold(line))),
      ...(this.q.detail ? wrapTextWithAnsi(this.q.detail, inner).map((line) => t.fg("muted", line)) : []),
      "",
    ];
    const tail = ["", ...wrapTextWithAnsi(this.helpLine(), inner), ""];
    const body = this.mode === "list"
      ? this.listLines(inner, Math.max(4, this.tui.terminal.rows - head.length - tail.length - 3))
      : this.editorLines(inner);
    const label = ` ${[this.label, this.nav && `${this.nav.index + 1}/${this.nav.total}`, this.q.header].filter(Boolean).join(" · ")} `;
    const fill = width - 3 - label.length;
    const top = fill > 0
      ? border("╭─") + t.fg("dim", t.bold(label)) + border(`${"─".repeat(fill)}╮`)
      : border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const lines = [
      top,
      ...[...head, ...body, ...tail].map((line) => border("│ ") + truncateToWidth(line, inner, "", true) + border(" │")),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ].map((line) => truncateToWidth(line, width, ""));
    if (this.mode === "list") this.cache = { width, lines };
    return lines;
  }

  private listLines(inner: number, maxRows: number): string[] {
    const t = this.theme;
    const { options, allowMultiple } = this.q;
    const total = options.length + (this.q.allowFreeform ? 1 : 0);
    const digits = String(Math.min(total, 9)).length;
    const pointer = (here: boolean) => (here ? t.fg("accent", "❯") : " ");
    const number = (i: number) => t.fg("dim", (i < 9 ? String(i + 1) : "").padStart(digits));
    const box = (on: boolean) => (allowMultiple ? (on ? t.fg("success", "☑") : t.fg("dim", "☐")) + " " : "");
    const indent = 3 + digits + (allowMultiple ? 2 : 0);
    const blocks = options.map((option, i) => {
      const here = i === this.cursor;
      const prefix = `${pointer(here)} ${number(i)} ${box(this.checked.has(i))}`;
      const mark = i === this.q.recommended ? `  ${t.fg("success", "★ recommended")}` : "";
      const lines = wrapTextWithAnsi(option.title, Math.max(1, inner - indent))
        .map((line, j) => (j === 0 ? prefix : " ".repeat(indent)) + t.fg(here ? "accent" : "text", t.bold(line)) + (j === 0 ? mark : ""));
      if (option.description) {
        for (const line of wrapTextWithAnsi(option.description, Math.max(1, inner - indent))) lines.push(" ".repeat(indent) + t.fg("muted", line));
      }
      return lines;
    });
    if (this.q.allowFreeform) {
      const here = this.cursor === options.length;
      const rule = " ".repeat(indent) + t.fg("dim", "─".repeat(Math.max(1, Math.min(32, inner - indent))));
      const label = this.other ? `${t.fg(here ? "accent" : "text", t.bold(OTHER))} ${t.fg("text", this.other)}` : `${t.fg(here ? "accent" : "text", t.bold(OTHER))} ${t.fg("muted", "type your own answer")}`;
      blocks.push([rule, `${pointer(here)} ${number(options.length)} ${box(!!this.other)}${label}`]);
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
    const subject = [...this.pending, ...(this.other ? [this.other] : [])].join(", ");
    const heading = this.mode === "freeform" ? "Your answer" : this.mode === "decline" ? "Why cancel? (optional)" : `Comment on ${subject}`;
    return [...wrapTextWithAnsi(heading, inner).map((line) => t.fg("accent", t.bold(line))), "", ...this.editor!.render(inner)];
  }

  private helpLine(): string {
    const t = this.theme;
    const hint = (key: string, description: string) => `${t.fg("dim", key)}${t.fg("muted", ` ${description}`)}`;
    const total = this.q.options.length + (this.q.allowFreeform ? 1 : 0);
    if (this.mode === "decline") return [hint("enter", "cancel with this reason"), hint("esc", "cancel now")].join(t.fg("dim", " · "));
    if (this.mode !== "list") {
      return [
        hint("enter", "send"),
        hint(this.keys.getKeys("tui.input.newLine").join("/"), "newline"),
        hint("esc", this.q.options.length ? "back" : "cancel"),
      ].join(t.fg("dim", " · "));
    }
    const hotkeys = Object.keys(this.hotkeys);
    return [
      hotkeys.length ? hint(hotkeys.join("/"), "answer") : hint(`1–${Math.min(total, 9)}`, this.q.allowMultiple ? "toggle" : "choose"),
      hint("↑↓", "move"),
      this.q.allowMultiple && hint("space", "toggle"),
      hint("enter", this.q.allowMultiple ? "submit" : "select"),
      this.q.commentOffered && hint("ctrl+e", "comment"),
      this.nav && hint("←/→", "question"),
      hint("esc", "cancel"),
    ].filter(Boolean).join(t.fg("dim", " · "));
  }
}
