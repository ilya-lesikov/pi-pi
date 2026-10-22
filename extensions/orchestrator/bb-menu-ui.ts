import { encodeQuestions, type BbForms, type FormQuestion, type FormSpec, type FormValue } from "./bb-forms.js";
import { fitLine } from "./host.js";

/**
 * /pp's dialogs under bb, drawn by pi-pi's plugin. pi's own dialogs cannot
 * reach the user there outside a model run, and /pp starts none; so while the
 * menu is open its every question, text box, report and notice goes through
 * the plugin's forms instead. The menus themselves are unchanged: they ask
 * through the same few calls in the terminal and here.
 */
export interface MenuSession {
  forms: BbForms;
  signal: AbortSignal;
}

/**
 * The menu was taken down from outside (a run started, the session changed,
 * bb lost the form): every screen unwinds rather than going back a level.
 */
export class MenuAborted extends Error {
  constructor(readonly reason: string) {
    super(`pi-pi's menu closed: ${reason}`);
  }
}

/** The reason a menu closed because pi-pi itself took it down: nothing to tell the user. */
export const CLOSED_BY_PI = "closed";

export type MenuNotice = { id: string; text: string; level: "info" | "warning" | "error"; at: number };

const TITLE_MAX = 160;
// The plugin takes this many options; longer lists are paged, as the stock dialogs are.
const PAGE = 150;
// What pi sends of one form, serialized, below BbForms' own limit.
const FORM_BUDGET = 55_000;
const NOTICES_KEPT = 5;

let active: MenuSession | null = null;
let notices: MenuNotice[] = [];
let noticeId = 0;

/** The open menu, if any: notices and reports go to it while it is. */
export function activeMenu(): MenuSession | null {
  return active;
}

export function setActiveMenu(session: MenuSession | null): void {
  active = session;
}

export function menuNotify(text: string, level: MenuNotice["level"]): void {
  notices = [...notices, { id: String(++noticeId), text: fitLine(text, 300), level, at: Date.now() }].slice(-NOTICES_KEPT);
}

/** Notices for the plugin's status line, which shows only recent ones. */
export function menuNotices(): MenuNotice[] {
  return notices;
}

async function show(session: MenuSession, spec: FormSpec, title: string): Promise<FormValue | null> {
  if (session.signal.aborted) throw new MenuAborted(CLOSED_BY_PI);
  const outcome = await session.forms.ask(spec, { title: fitLine(title, TITLE_MAX), signal: session.signal, fromMenu: true });
  if (session.signal.aborted) throw new MenuAborted(CLOSED_BY_PI);
  if (outcome.outcome === "unavailable") throw new MenuAborted("pi-pi's bb plugin did not respond; try again in a minute");
  if (outcome.outcome === "cancelled") {
    if (outcome.reason === "user") return null;
    throw new MenuAborted(outcome.reason);
  }
  return outcome.value;
}

export interface MenuQuestion {
  question: string;
  header?: string;
  detail?: string;
  options: Array<{ title: string; description?: string }>;
  recommended?: string;
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
}

export type MenuAnswer =
  | { kind: "selection"; selections: string[]; other?: string; comment?: string }
  | { kind: "freeform"; text: string };

/** One question; null when the user dismissed it. */
export async function menuAsk(session: MenuSession, q: MenuQuestion): Promise<MenuAnswer | null> {
  const question = q.detail ? `${q.question}\n\n${q.detail}` : q.question;
  let start = 0;
  for (;;) {
    // A page is as many options as fit the form, long descriptions and all.
    let size = PAGE;
    let built = buildPage(q, question, start, size);
    while (built.bytes > FORM_BUDGET && size > 1) {
      size = Math.max(1, Math.floor(size * 0.6));
      built = buildPage(q, question, start, size);
    }
    const { more, remaining, encoded } = built;
    const value = await show(session, { version: 1, kind: "ask", questions: encoded.questions }, q.header || q.question);
    if (!value) return null;
    if (value.kind === "decline") return null;
    if (value.kind !== "ask") throw new MenuAborted(`unexpected answer ${value.kind}`);
    const answer = encoded.decode(value.answers)[0];
    if (!answer) return null;
    if (more && answer.kind === "selection" && answer.selections.includes(more)) {
      start = remaining > 0 ? start + size : 0;
      continue;
    }
    return answer;
  }
}

function buildPage(q: MenuQuestion, question: string, start: number, size: number) {
  const paged = start > 0 || q.options.length > size;
  const page = paged ? q.options.slice(start, start + size) : q.options;
  const remaining = q.options.length - start - size;
  const more = paged ? (remaining > 0 ? `More… (${remaining} more)` : "Back to the first page") : undefined;
  const wire: FormQuestion = {
    question,
    ...(q.header ? { header: q.header } : {}),
    options: more ? [...page, { title: more }] : page,
    ...(q.recommended && page.some((option) => option.title === q.recommended) ? { recommended: q.recommended } : {}),
    allowMultiple: q.allowMultiple,
    allowFreeform: q.allowFreeform,
    allowComment: q.allowComment,
  };
  const encoded = encodeQuestions([wire]);
  return { more, remaining, encoded, bytes: Buffer.byteLength(JSON.stringify(encoded.questions)) };
}

/** Typed text; null when the user dismissed it. */
export async function menuInput(session: MenuSession, question: string, options: { placeholder?: string; prefill?: string; multiline?: boolean } = {}): Promise<string | null> {
  const value = await show(session, {
    version: 1,
    kind: "input",
    question: fitLine(question, 3800),
    ...(options.placeholder ? { placeholder: fitLine(options.placeholder, 480) } : {}),
    ...(options.prefill ? { prefill: options.prefill } : {}),
    multiline: options.multiline === true,
  }, question);
  if (!value) return null;
  return value.kind === "input" ? value.text : null;
}

export async function menuConfirm(session: MenuSession, question: string, detail?: string): Promise<boolean> {
  const value = await show(session, { version: 1, kind: "confirm", question: fitLine(question, 3800), ...(detail ? { detail: detail.slice(0, 3800) } : {}), danger: false }, question);
  return value?.kind === "confirm" && value.decision === "yes";
}

export async function menuReport(session: MenuSession, title: string, text: string): Promise<void> {
  await show(session, { version: 1, kind: "report", text: fitReport(text) }, title);
}

/** The report cut, visibly, to what fits a form once serialized: quotes and line breaks count twice there, and bb counts bytes. */
function fitReport(text: string): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= FORM_BUDGET) return text;
  let keep = text.length;
  for (;;) {
    keep = Math.floor(keep * 0.9);
    const shown = `${text.slice(0, keep)}\n\n… ${text.length - keep} more characters not shown.`;
    if (Buffer.byteLength(JSON.stringify(shown)) <= FORM_BUDGET) return shown;
  }
}

/**
 * The session's context with its dialogs drawn by the plugin. A proxy rather
 * than a copy: pi's context reads its model, mode and session through getters
 * that must stay live.
 */
export function menuContext(ctx: any, session: MenuSession): any {
  const ui = new Proxy(ctx.ui ?? {}, {
    get(target, key) {
      if (key === "select") {
        return async (title: string, options: string[]) => {
          const answer = await menuAsk(session, { question: title, options: options.map((option) => ({ title: option })), allowMultiple: false, allowFreeform: false, allowComment: false });
          return answer?.kind === "selection" ? answer.selections[0] : undefined;
        };
      }
      if (key === "input") return async (title: string, placeholder?: string) => (await menuInput(session, title, { placeholder })) ?? undefined;
      if (key === "editor") return async (title: string, prefill?: string) => (await menuInput(session, title, { prefill, multiline: true })) ?? undefined;
      if (key === "confirm") return (title: string, message?: string) => menuConfirm(session, title, message);
      if (key === "notify") return (message: string, level?: MenuNotice["level"]) => menuNotify(message, level ?? "info");
      // Drawn only in the terminal; nothing here can show it.
      if (key === "custom") return async () => undefined;
      return passThrough(target, key);
    },
  });
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "ui") return ui;
      if (key === "bbMenu") return session;
      return passThrough(target, key);
    },
  });
}

// Read and called on the real object, so its getters and methods see themselves, not the proxy.
function passThrough(target: any, key: string | symbol): unknown {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

/** The menu session a context carries, if it is the menu's. */
export function menuOf(ctx: any): MenuSession | null {
  return ctx?.bbMenu ?? null;
}
