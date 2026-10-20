import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fitLine } from "../host.js";
import { askQuestion, formatOptionList, formatResponse, isCancel, isNavigate, normalizeOptions, reviewAnswers, type AskResponse, type CancelReason, type QuestionOption } from "./ui.js";

export { askUser, isCancel, type AskCancel, type AskResponse, type CancelReason, type QuestionOption } from "./ui.js";

type AskStatus = "answered" | "cancelled" | "unattended" | "typing_unavailable" | "incomplete";

interface AskToolDetails {
  question: string;
  header?: string;
  options: QuestionOption[];
  recommended?: string;
  response: AskResponse | null;
  cancelled: boolean;
  cancelReason?: CancelReason;
  cancelNote?: string;
  status?: AskStatus;
  // With `questions`: per-question outcomes in order; the top-level fields then describe the last one asked.
  answers?: AskToolDetails[];
}

interface AskItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  recommended?: string;
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
}

interface AskParams extends Partial<AskItem> {
  questions?: AskItem[];
}

const DESCRIPTION = "Ask the user one focused question with optional multiple-choice answers — or several related questions via `questions`, presented one by one. NEVER bundle multiple decisions into a single question's text or options; use `questions` for a sequence instead. ALWAYS write the substantive context, reasoning, and findings as a message BEFORE the call — never call ask_user with nothing written above it. Keep each `question` SHORT — one scannable line. A question offers no options at all (a free-text answer) or at least two distinct ones. Never add an option that only declines (\"cancel\", \"no\", \"skip\") — every dialog has its own Cancel — nor one that says the user will type their own answer: the built-in \"Other…\" entry covers that. For a single yes/no decision, or to ask permission to go ahead, use confirm instead.";

const PROMPT_SNIPPET = "Ask the user one short, focused question with optional multiple-choice answers to gather information interactively";

const PROMPT_GUIDELINES = [
  "Keep the `question` field SHORT — a single scannable line (ideally under ~100 chars). The user reads your detail from the message rendered above the dialogue.",
  "ALWAYS write the substantive context as an assistant message BEFORE the ask: the question and options are intentionally terse, so the surrounding message must make them interpretable. A call with nothing written above it reaches the user as a bare demand for approval.",
  "Give each question a `header` of one to three words, and mark the option you would pick yourself as `recommended` when you have a reasoned preference.",
  "If the user answers with a question or an objection instead of picking an option, that is not a vote: answer it in a message and end the turn there. Do not re-ask, do not reword the options, and never put the answer in the next `question` field.",
  "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist. Use confirm for a plain yes/no or go-ahead decision.",
  "Each question must carry exactly one decision. For several related decisions, pass them as the `questions` array (asked one by one) instead of merging them into one prompt or spawning separate calls.",
];

const optionSchema = Type.Union([
  Type.String({ description: "Short title for this option" }),
  Type.Object({
    title: Type.String({ description: "Short title for this option" }),
    description: Type.Optional(Type.String({ description: "One line explaining this option" })),
  }),
]);

const itemFields = {
  header: Type.Optional(Type.String({ description: "One to three words naming the decision, shown as the dialog's label" })),
  options: Type.Optional(Type.Array(optionSchema, { description: "Choices for the user; none for a free-text answer, otherwise at least two" })),
  recommended: Type.Optional(Type.String({ description: "Title of the option you recommend; focused first and marked" })),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
  allowFreeform: Type.Optional(Type.Boolean({ description: "Offer an \"Other…\" entry for a typed answer. Default: true" })),
  allowComment: Type.Optional(Type.Boolean({ description: "Invite an optional comment on the chosen option. Default: the user can add one in the terminal only" })),
};

const PARAMETERS = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask the user. Keep it SHORT — one scannable line. Put detail/reasoning in your message above the dialogue, not here. Omit when using `questions`." })),
  questions: Type.Optional(Type.Array(
    Type.Object({ question: Type.String({ description: "One short, focused question — exactly one decision." }), ...itemFields }),
    { description: "Several related questions asked one by one, each with its own options. Use INSTEAD of `question` for multi-decision asks." },
  )),
  ...itemFields,
});

const DECLINE_ONLY = /^(no|nope|cancel|skip|none|abort|stop|decline|nothing|не надо|нет|отмена|отменить|пропустить)\.?$/i;

// Runs before schema validation, so salvaged options and the `multiSelect` alias pass it.
function prepareItem(raw: Record<string, any>): Record<string, any> {
  const { multiSelect, context: _context, ...item } = raw;
  if (Array.isArray(item.options)) item.options = normalizeOptions(item.options);
  if (item.allowMultiple === undefined && typeof multiSelect === "boolean") item.allowMultiple = multiSelect;
  return item;
}

function prepareArguments(args: unknown): any {
  if (!args || typeof args !== "object") return args;
  const prepared = prepareItem(args as Record<string, any>);
  if (Array.isArray(prepared.questions)) {
    prepared.questions = prepared.questions.map((item: unknown) => (item && typeof item === "object" ? prepareItem(item as Record<string, any>) : item));
  }
  return prepared;
}

/** Why a question cannot be put to the user as written, phrased for the model to fix it. */
function problemWith(item: AskItem, label: string): string | undefined {
  if (!item.question?.trim()) return `${label} has no text.`;
  const options = normalizeOptions(item.options ?? []);
  if (options.length === 1) return `${label} offers one option; one option is not a choice. Offer at least two, or none for a free-text answer.`;
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.title.trim().toLowerCase();
    if (seen.has(key)) return `${label} offers "${option.title}" twice; make every option distinct.`;
    seen.add(key);
  }
  const declines = options.filter((option) => DECLINE_ONLY.test(option.title.trim()));
  if (declines.length && options.length - declines.length < 2) {
    return `${label} offers "${declines[0]!.title}", which only declines; every dialog has its own Cancel. For a yes/no decision use confirm.`;
  }
  if (item.recommended && !options.some((option) => option.title === item.recommended)) return `${label}'s recommended "${item.recommended}" is not one of its options.`;
  return undefined;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

function describe(item: AskItem): Pick<AskToolDetails, "question" | "header" | "options" | "recommended"> {
  return { question: item.question, header: item.header?.trim() || undefined, options: normalizeOptions(item.options ?? []), ...(item.recommended ? { recommended: item.recommended } : {}) };
}

function outcomeText(details: AskToolDetails, prefix = ""): string {
  if (details.response) return `${prefix}${formatResponse(details.response)}`;
  if (details.status === "typing_unavailable") return `${prefix}(not answered: this host cannot collect typed text)`;
  if (details.status === "incomplete") return `${prefix}(not answered: the dialog kept returning the same choice${details.cancelNote ? `; unconfirmed: ${details.cancelNote}` : ""})`;
  return `${prefix}(cancelled${details.cancelNote ? `: "${details.cancelNote}"` : ""})`;
}

const CANCELLED_GUIDANCE = "Do not ask it again; propose a different approach in prose or ask what they want instead.";
const NO_TEXT_GUIDANCE = "This host cannot collect typed answers. Ask the question in plain prose in your reply and end the turn; do not call ask_user for it again.";
const INCOMPLETE_GUIDANCE = "The host could not complete the selection. Ask the question in plain prose in your reply and end the turn.";

function cancelledResult(shown: AskToolDetails, multi: boolean, answers: AskToolDetails[], index: number, total: number) {
  const status = shown.status!;
  const guidance = status === "typing_unavailable" ? NO_TEXT_GUIDANCE : status === "incomplete" ? INCOMPLETE_GUIDANCE : CANCELLED_GUIDANCE;
  const reason = shown.cancelNote ? ` Their reason: "${shown.cancelNote}".` : "";
  const headline = status === "cancelled" ? "User cancelled the question." : `Not answered ${outcomeText(shown).slice("(not answered".length).replace(/\)$/, "").replace(/^: /, "— ")}.`;
  if (!multi) return { content: text(`${headline}${reason} ${guidance}`), details: shown };
  const done = answers.slice(0, index).filter((answer) => answer.response);
  const summary = done.map((answer, i) => `${i + 1}. ${answer.question}: ${outcomeText(answer)}`).join("\n");
  return {
    content: text(`Stopped at question ${index + 1}/${total}: ${outcomeText(shown)}.${reason} ${guidance}${summary ? `\nAnswered before stopping (not submitted as a batch):\n${summary}` : ""}`),
    details: { ...shown, answers },
  };
}

export function registerAskUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    // Holds back the other calls of the turn, so none with side effects runs before the user has answered.
    executionMode: "sequential",
    parameters: PARAMETERS,
    prepareArguments,
    async execute(_id, raw, signal, onUpdate, ctx) {
      const params = raw as AskParams;
      const multi = params.questions?.length ? params.questions : undefined;
      if (!params.question && !multi) {
        return { content: text("ask_user requires `question` or a non-empty `questions` array"), isError: true, details: { error: "missing question" } };
      }
      if (params.question && multi) {
        return { content: text("Use either `question` or `questions`, not both"), isError: true, details: { error: "ambiguous question input" } };
      }
      const items: AskItem[] = multi ?? [params as AskItem];
      const problem = items.map((item, i) => problemWith(item, multi ? `Question ${i + 1}` : "The question")).find(Boolean);
      if (problem) return { content: text(`${problem} Nothing was shown to the user; fix the call and ask again.`), isError: true, details: { error: problem } };
      if (signal?.aborted) {
        return { content: text("Cancelled"), details: { ...describe(items[0]!), response: null, cancelled: true, cancelReason: "signal", status: "cancelled" } satisfies AskToolDetails };
      }
      if (!ctx.hasUI || !ctx.ui) return unattended(items, !!multi);
      const terminal = ctx.mode === undefined || ctx.mode === "tui";

      const answers: AskToolDetails[] = [];
      let index = 0;
      while (index <= items.length) {
        if (index === items.length) {
          if (!multi || terminal) break;
          const verdict = await reviewAnswers(ctx as any, answers.map((answer) => `${fitLine(answer.question, 60)}: ${outcomeText(answer)}`), signal);
          if (signal?.aborted || verdict === undefined) {
            const last = answers[answers.length - 1]!;
            return cancelledResult({ ...last, response: null, cancelled: true, cancelReason: signal?.aborted ? "signal" : "user", status: "cancelled" }, true, answers, items.length - 1, items.length);
          }
          if (verdict === "submit") break;
          index = verdict;
          continue;
        }
        const item = items[index]!;
        const shown = describe(item);
        const previous = answers[index]?.response;
        const picked = previous?.kind === "selection" ? previous.selections.map((title) => shown.options.findIndex((o) => o.title === title)).filter((i) => i >= 0) : [];
        onUpdate?.({
          content: text(multi ? `Waiting for user input (${index + 1}/${items.length})...` : "Waiting for user input..."),
          details: { ...shown, response: null, cancelled: false, ...(multi && { answers }) },
        });
        const result = await askQuestion(ctx as any, {
          ...item,
          options: shown.options,
          signal,
          declineNote: true,
          paseoCombined: paseoCombines(params, item, multi),
          ...(multi && {
            // Forward only from an answered question, so none can be skipped.
            navigation: { index, total: items.length, canPrev: index > 0, canNext: index < items.length - 1 && previous != null },
            ...(picked.length ? { initialIndex: picked[0], checkedIndices: picked } : {}),
          }),
        });
        if (isNavigate(result)) {
          index += result.__navigate === "prev" ? -1 : 1;
          continue;
        }
        if (result === null || isCancel(result)) {
          const reason = isCancel(result) ? result.reason : "user";
          const status: AskStatus = reason === "no_text" ? "typing_unavailable" : reason === "incomplete" ? "incomplete" : "cancelled";
          const cancelled: AskToolDetails = { ...shown, response: null, cancelled: true, cancelReason: reason, status, ...(isCancel(result) && result.note ? { cancelNote: result.note } : {}) };
          answers[index] = cancelled;
          return cancelledResult(cancelled, !!multi, answers, index, items.length);
        }
        answers[index] = { ...shown, response: result, cancelled: false, status: "answered" };
        index++;
      }
      if (!multi) return { content: text(`User answered: ${formatResponse(answers[0]!.response!)}`), details: answers[0]! };
      const summary = answers.map((answer, i) => `${i + 1}. ${answer.question}: ${formatResponse(answer.response!)}`).join("\n");
      return { content: text(`User answered:\n${summary}`), details: { ...answers[answers.length - 1]!, answers } };
    },
    renderCall(args: any, theme) {
      const questions: any[] = Array.isArray(args.questions) ? args.questions : [];
      const label = questions.length ? `${questions.length} questions` : args.header || args.question || "";
      return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", label), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as (AskToolDetails & { error?: string }) | undefined;
      if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      if (options.isPartial) {
        const waiting = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
        return new Text(theme.fg("muted", waiting || "Waiting for user input..."), 0, 0);
      }
      if (!details) return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      const line = (answer: AskToolDetails) => {
        const subject = theme.fg("muted", fitLine(answer.header || answer.question, 60));
        if (!answer.response) return `${theme.fg("warning", "✗")} ${subject}  ${theme.fg("warning", outcomeText(answer).replace(/^\(|\)$/g, ""))}`;
        const r = answer.response;
        const value = r.kind === "freeform" ? `“${r.text}”` : [...r.selections, ...(r.other ? [`“${r.other}”`] : [])].join(", ");
        const comment = r.kind === "selection" && r.comment ? theme.fg("muted", `  “${r.comment}”`) : "";
        return `${theme.fg("success", "✓")} ${subject}  ${theme.fg("dim", "→")}  ${theme.fg("accent", value)}${comment}`;
      };
      const all = details.answers?.length ? details.answers : [details];
      let out = all.map(line).join("\n");
      if (options.expanded && all.length === 1 && details.options.length) {
        const chosen = new Set(details.response?.kind === "selection" ? details.response.selections : []);
        for (const option of details.options) {
          const marker = chosen.has(option.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
          out += `\n  ${marker} ${theme.fg("dim", option.title)}${theme.fg("dim", option.description ? ` — ${option.description}` : "")}`;
        }
      }
      return new Text(out, 0, 0);
    },
  });
}

/**
 * Paseo answers a plain ask_user select with its own form, holding a custom
 * answer and a comment, when the call's own top-level arguments ask for a
 * comment and not for several answers; it reads nothing nested in questions.
 */
function paseoCombines(params: AskParams, item: AskItem, multi: AskItem[] | undefined): boolean {
  if (!process.env.PASEO_AGENT_ID) return false;
  return params.allowComment === true && params.allowMultiple !== true && !multi && item.allowMultiple !== true;
}

function unattended(items: AskItem[], multi: boolean) {
  const blocks = items.map((item, i) => {
    const shown = describe(item);
    const lines = [`${multi ? `${i + 1}) ` : ""}${shown.question}${item.allowMultiple ? " (several answers allowed)" : ""}`];
    if (shown.options.length) lines.push(formatOptionList(shown.options, shown.recommended));
    return lines.join("\n");
  });
  const recommended = items.map((item) => item.recommended).filter(Boolean);
  const advice = recommended.length === items.length
    ? "Take the recommended option for each, state that as your assumption, and continue."
    : "Choose the most reasonable answer for each, state it as your assumption, and continue.";
  const details: AskToolDetails = { ...describe(items[0]!), response: null, cancelled: true, status: "unattended", ...(multi ? { answers: items.map((item) => ({ ...describe(item), response: null, cancelled: true, status: "unattended" as const })) } : {}) };
  return { content: text(`No user is available to answer (non-interactive run).\n\n${blocks.join("\n\n")}\n\n${advice}`), details };
}

export { registerConfirm } from "./confirm.js";
