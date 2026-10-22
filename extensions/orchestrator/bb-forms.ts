import { randomUUID } from "node:crypto";
import { getLogger } from "./log.js";

/**
 * Rich ask_user/confirm forms under bb, drawn by pi-pi's bb plugin. bb's own
 * Pi integration offers only four bare dialogs (one select, a yes/no, two text
 * boxes), so the plugin shows a form instead; without the plugin, or when bb
 * cannot reach it, callers fall back to those dialogs.
 */

// A copy of bb/forms.ts, so the extension builds on its own; bb-forms.test.ts checks the two match.
export interface FormOption {
  title: string;
  description?: string;
}

export interface FormQuestion {
  question: string;
  header?: string;
  options: FormOption[];
  recommended?: string;
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
}

export type FormSpec =
  | { version: 1; kind: "ask"; questions: FormQuestion[] }
  | { version: 1; kind: "confirm"; question: string; detail?: string; danger: boolean }
  | { version: 1; kind: "worker-question"; workerId: string; workerLabel: string; questionId: string; question: string }
  | { version: 1; kind: "input"; question: string; placeholder?: string; prefill?: string; multiline: boolean }
  | { version: 1; kind: "report"; text: string };

export type FormAnswer =
  | { kind: "selection"; selections: string[]; other?: string; comment?: string }
  | { kind: "freeform"; text: string };

export type FormValue =
  | { kind: "ask"; answers: FormAnswer[] }
  | { kind: "confirm"; decision: "yes" | "no"; comment?: string }
  | { kind: "answer"; text: string }
  | { kind: "decline"; note?: string }
  | { kind: "input"; text: string }
  | { kind: "closed" };

/** submitted: the user answered; cancelled: dismissed (by them or bb); unavailable: nothing was shown, use the dialogs. */
export type FormOutcome =
  | { outcome: "submitted"; value: FormValue }
  | { outcome: "cancelled"; reason: string }
  | { outcome: "unavailable" };

type PollResult =
  | { state: "pending" }
  | { state: "submitted"; value: FormValue }
  | { state: "cancelled"; reason: string }
  | { state: "unknown" };

const POLL_MS = 700;
// The plugin drops a form nobody polls for this long, so a pi that crashed leaves no card behind.
export const LEASE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5000;
// A plugin reload or a bb restart takes the card down with it; it is shown again this many times.
const REOPENS = 3;
// A transport failure while a form is up is retried for this long; the plugin
// keeps an uncollected answer longer (bb/server.ts), so none is asked twice.
const OUTAGE_MS = 120_000;
const UNAVAILABLE_FOR_MS = 60_000;
const MAX_FORM_BYTES = 60_000;
/** bb's reasons for taking a card down that are not the user's decision: show it again. */
const REOPEN_REASONS = new Set(["plugin-disposed", "server-restarted", "request-aborted", "lease-expired"]);

export interface BbFormsEnv {
  serverUrl: string;
  threadId: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

class Unavailable extends Error {
  constructor(message: string, readonly notInstalled = false) {
    super(message);
  }
}
/** The plugin refused this form; the next one may be fine. */
class Rejected extends Error {}
// The plugin's error for a form it cannot show (bb/server.ts).
const UNSUPPORTED_FORM = "Unsupported form:";

/** One pi process's forms in one bb thread. */
export class BbForms {
  private readonly session = randomUUID();
  private unavailableUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Forms waiting for an answer, so a reply typed in the chat can answer the newest. */
  private readonly open = new Map<string, (text: string) => void>();
  private asking = 0;
  private askEndedAt = 0;
  private kinds: Set<string> | null = null;
  private kindsRetryAt = 0;

  constructor(private readonly env: BbFormsEnv) {
    this.fetch = env.fetch ?? fetch;
    this.now = env.now ?? Date.now;
    this.sleep = env.sleep ?? sleep;
  }

  /**
   * Shows a form and waits for it. `onTyped` turns a message the user typed
   * in the chat meanwhile into the form's value; without it the message
   * reaches the agent as usual.
   */
  async ask(spec: FormSpec, options: { title: string; signal?: AbortSignal; timeoutMs?: number; onTyped?: (text: string) => FormValue; fromMenu?: boolean }): Promise<FormOutcome> {
    const { signal } = options;
    if (signal?.aborted) return { outcome: "cancelled", reason: "signal" };
    if (this.now() < this.unavailableUntil) return { outcome: "unavailable" };
    if (JSON.stringify(spec).length > MAX_FORM_BYTES) return { outcome: "unavailable" };
    const formId = randomUUID();
    const open = { threadId: this.env.threadId, session: this.session, formId, title: options.title, form: spec, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
    const cancel = () => void this.call("form_cancel", { threadId: this.env.threadId, formId }).catch(() => {});
    // Counted from before the open, so no worker form slips in while this one is on its way.
    // The user's own menu is not the agent asking: workers' questions are not held back for it.
    const agentAsks = spec.kind !== "worker-question" && !options.fromMenu;
    if (agentAsks) this.asking++;
    const done = () => {
      if (!agentAsks) return;
      this.asking--;
      this.askEndedAt = this.now();
    };
    // Listening from before the open: the plugin shows the form before the open returns.
    let typed: FormValue | undefined;
    if (options.onTyped) {
      const onTyped = options.onTyped;
      // Taken by the first reply only: a later one is the agent's.
      this.open.set(formId, (text) => {
        this.open.delete(formId);
        typed = onTyped(text);
      });
    }
    try {
      await this.call("form_open", open);
    } catch (error) {
      this.open.delete(formId);
      done();
      if (!(error instanceof Unavailable)) getLogger().warn({ s: "bb-forms", err: (error as Error).message }, "opening a bb form failed");
      if (!(error instanceof Rejected)) this.unavailableUntil = this.now() + UNAVAILABLE_FOR_MS;
      // The plugin may have shown it before the response was lost.
      if (!(error instanceof Rejected) && !(error instanceof Unavailable && error.notInstalled)) cancel();
      // A reply already taken from the chat is the answer; the dialogs would ask again for nothing.
      if (typed) return { outcome: "submitted", value: typed };
      return { outcome: "unavailable" };
    }
    try {
      let reopens = 0;
      let failingSince: number | null = null;
      for (;;) {
        if (signal?.aborted) {
          cancel();
          return { outcome: "cancelled", reason: "signal" };
        }
        if (typed) {
          cancel();
          return { outcome: "submitted", value: typed };
        }
        let result: PollResult;
        try {
          result = await this.call("form_poll", { threadId: this.env.threadId, formId });
          failingSince = null;
        } catch {
          failingSince ??= this.now();
          if (this.now() - failingSince > OUTAGE_MS) return { outcome: "cancelled", reason: "unreachable" };
          await this.sleep(POLL_MS * 3, signal);
          continue;
        }
        // A reply typed while this poll was out was already taken from the chat: it wins, or it would be lost.
        if (typed) {
          cancel();
          return { outcome: "submitted", value: typed };
        }
        if (result.state === "submitted") return { outcome: "submitted", value: result.value };
        if (result.state === "cancelled" && !REOPEN_REASONS.has(result.reason)) return { outcome: "cancelled", reason: result.reason };
        if (result.state === "unknown" || result.state === "cancelled") {
          if (++reopens > REOPENS) return { outcome: "cancelled", reason: "unreachable" };
          try {
            await this.call("form_open", open);
          } catch {}
        }
        await this.sleep(POLL_MS, signal);
      }
    } finally {
      this.open.delete(formId);
      done();
    }
  }

  /**
   * Whether the plugin can show every one of `kinds`; null when it could not
   * be asked. An answer is remembered, since the plugin changes only with an
   * upgrade; a plugin too old to answer is asked again a little later.
   */
  async supports(kinds: ReadonlyArray<FormSpec["kind"]>): Promise<boolean | null> {
    if (!this.kinds || (this.kinds.size === 0 && this.now() >= this.kindsRetryAt)) {
      try {
        const { kinds: known } = await this.call<{ kinds: string[] }>("capabilities", { threadId: this.env.threadId });
        this.kinds = new Set(known);
      } catch (error) {
        // A plugin without the method is too old; anything else is an outage, asked again next time.
        if (!(error instanceof Unavailable && error.notInstalled) && !/unknown_method|unknown method/i.test((error as Error).message)) return null;
        this.kinds = new Set();
        this.kindsRetryAt = this.now() + UNAVAILABLE_FOR_MS;
      }
    }
    return kinds.every((kind) => this.kinds!.has(kind));
  }

  /** True while an ask_user or confirm form is up: the agent is asking the user something itself. */
  get busy(): boolean {
    return this.asking > 0;
  }

  /** When the agent's last ask_user or confirm form closed; 0 if none has. */
  get lastAskEndedAt(): number {
    return this.askEndedAt;
  }

  /** Hands a message the user typed to the newest open form that takes one; true when one did. */
  takeTyped(text: string): boolean {
    const newest = [...this.open.values()].at(-1);
    if (!newest || !text.trim()) return false;
    newest(text.trim());
    return true;
  }

  /** Takes down forms an earlier pi left in this thread: their tool calls no longer exist. */
  async cancelStale(): Promise<void> {
    try {
      await this.call("form_cancel_session", { threadId: this.env.threadId, exceptSession: this.session });
    } catch {}
  }

  /** Takes one form down without waiting; for forms whose question went away elsewhere. */
  cancel(formId: string): void {
    void this.call("form_cancel", { threadId: this.env.threadId, formId }).catch(() => {});
  }

  private async call<T = any>(method: string, body: object): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let response: Response;
    let payload: { ok?: boolean; result?: T; error?: { code?: string; message?: string } } | null;
    try {
      try {
        response = await this.fetch(`${this.env.serverUrl.replace(/\/+$/, "")}/api/v1/plugins/pi-pi/rpc/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new Unavailable((error as Error).message);
      }
      // No such plugin, or one too old to have the method.
      if (response.status === 404) throw new Unavailable("pi-pi's bb plugin is not installed", true);
      // Under the same deadline: a body that never finishes would hold the form's loop.
      payload = (await response.json().catch(() => null)) as typeof payload;
    } finally {
      clearTimeout(timer);
    }
    // Input the plugin's contract or its form check refused: this form, not the plugin, is the problem.
    if (payload?.error?.code === "invalid_input" || payload?.error?.message?.startsWith(UNSUPPORTED_FORM)) throw new Rejected(payload.error.message ?? "the plugin refused the form");
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    return payload.result as T;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// The plugin's limits (bb/server.ts), with room to spare for a marker.
const LIMITS = { title: 300, description: 1500, question: 3800, header: 190 };

/**
 * Fits questions to what the plugin accepts without losing which option was
 * picked: answers come back as the titles shown, so a title cut to fit, or
 * two that come out the same once cut, are mapped back to the originals.
 */
export function encodeQuestions(questions: FormQuestion[]): { questions: FormQuestion[]; decode(answers: FormAnswer[]): FormAnswer[] } {
  const originals: Array<Map<string, string>> = [];
  const encoded = questions.map((question) => {
    const byLabel = new Map<string, string>();
    originals.push(byLabel);
    const label = (title: string): string => {
      const base = clip(title, LIMITS.title);
      let shown = base;
      for (let n = 2; byLabel.has(shown) && byLabel.get(shown) !== title; n++) shown = `${clip(title, LIMITS.title - String(n).length - 3)} (${n})`;
      byLabel.set(shown, title);
      return shown;
    };
    const options = question.options.map((option) => ({ title: label(option.title), ...(option.description ? { description: clip(option.description, LIMITS.description) } : {}) }));
    const { recommended: _recommended, ...rest } = question;
    const recommended = [...byLabel].find(([, title]) => title === question.recommended)?.[0];
    return {
      ...rest,
      question: clip(question.question, LIMITS.question),
      ...(question.header ? { header: clip(question.header, LIMITS.header) } : {}),
      options,
      ...(recommended !== undefined ? { recommended } : {}),
    };
  });
  return {
    questions: encoded,
    decode: (answers) => answers.map((answer, i) => answer.kind === "selection" ? { ...answer, selections: answer.selections.map((shown) => originals[i]?.get(shown) ?? shown) } : answer),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

let forms: BbForms | null | undefined;

/** The forms of this pi's bb thread; null outside bb. */
export function bbForms(env: NodeJS.ProcessEnv = process.env): BbForms | null {
  if (forms === undefined) forms = env.BB_THREAD_ID && env.BB_SERVER_URL ? new BbForms({ serverUrl: env.BB_SERVER_URL, threadId: env.BB_THREAD_ID }) : null;
  return forms;
}

/** Tests only. */
export function resetBbForms(next?: BbForms | null): void {
  forms = next;
}
