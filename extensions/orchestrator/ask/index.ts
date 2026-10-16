import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askQuestion, formatOptionList, formatResponse, isCancel, isNavigate, normalizeOptions, type AskResponse, type CancelReason, type QuestionOption } from "./ui.js";

export { askUser, isCancel, type AskCancel, type AskResponse, type CancelReason, type QuestionOption } from "./ui.js";

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
  cancelReason?: CancelReason;
  // With `questions`: per-question outcomes in order; the top-level fields then describe the last one asked.
  answers?: AskToolDetails[];
}

interface AskItem {
  question: string;
  context?: string;
  options?: QuestionOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
}

interface AskParams extends Partial<AskItem> {
  questions?: AskItem[];
}

const DESCRIPTION = "Ask the user one focused question with optional multiple-choice answers — or several related questions via `questions`, presented one by one. NEVER bundle multiple decisions into a single question's text or options; use `questions` for a sequence instead. ALWAYS write the substantive context, reasoning, and findings as a message BEFORE the call — never call ask_user with nothing written above it, and never move that substance into `question` or `context` instead of writing it. Keep each `question` SHORT — one scannable line. Do NOT add an option like 'I'll answer in a comment' — the built-in freeform 'Type something' path already covers custom answers.";

const PROMPT_SNIPPET = "Ask the user one short, focused question with optional multiple-choice answers to gather information interactively";

const PROMPT_GUIDELINES = [
  "Keep the `question` field SHORT — a single scannable line (ideally under ~100 chars). The dialogue de-emphasizes it; the user reads your detail from the message rendered above the dialogue.",
  "ALWAYS write the substantive context as an assistant message BEFORE the ask: the question and options are intentionally terse, so the surrounding message must make them interpretable. `context` supplements that message, it does not replace it — a call with nothing written above it reaches the user as a bare demand for approval.",
  "If the user answers with a question or an objection instead of picking an option, that is not a vote: answer it in a message and end the turn there. Do not re-ask, do not reword the options, and never put the answer in the next `question` field.",
  "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
  "Each question must carry exactly one decision. For several related decisions, pass them as the `questions` array (asked one by one) instead of merging them into one prompt or spawning separate calls.",
  "NEVER add an option that just says the user will answer in a comment / free text (e.g. 'I'll type my own answer') — the built-in 'Type something' freeform path already covers custom answers.",
];

const PARAMETERS = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask the user. Keep it SHORT — one scannable line. Put detail/reasoning in your message above the dialogue, not here. Omit when using `questions`." })),
  questions: Type.Optional(Type.Array(
    Type.Object({
      question: Type.String({ description: "One short, focused question — exactly one decision." }),
      context: Type.Optional(Type.String({ description: "Context shown before this question" })),
      options: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ title: Type.String(), description: Type.Optional(Type.String()) })]))),
      allowMultiple: Type.Optional(Type.Boolean()),
      allowFreeform: Type.Optional(Type.Boolean()),
      allowComment: Type.Optional(Type.Boolean()),
    }),
    { description: "Several related questions asked one by one, each with its own options. The user answers them in order; a cancel stops the remaining questions. Use INSTEAD of `question` for multi-decision asks." },
  )),
  context: Type.Optional(Type.String({ description: "Relevant context to show before the question (summary of findings)" })),
  options: Type.Optional(Type.Array(
    Type.Union([
      Type.String({ description: "Short title for this option" }),
      Type.Object({
        title: Type.String({ description: "Short title for this option" }),
        description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
      }),
    ]),
    { description: "List of options for the user to choose from" },
  )),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
  allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
  allowComment: Type.Optional(Type.Boolean({ description: "Collect an optional comment to append after selecting one or more options. Default: true" })),
});

// Runs before schema validation, so salvaged options and the `multiSelect` alias pass it.
function prepareItem(raw: Record<string, any>): Record<string, any> {
  const { multiSelect, ...item } = raw;
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

const text = (value: string) => [{ type: "text" as const, text: value }];

function describe(item: AskItem): Pick<AskToolDetails, "question" | "context" | "options"> {
  return { question: item.question, context: item.context?.trim() || undefined, options: normalizeOptions(item.options ?? []) };
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
      if (signal?.aborted) {
        return { content: text("Cancelled"), details: { ...describe(items[0]!), response: null, cancelled: true, cancelReason: "signal" } satisfies AskToolDetails };
      }
      if (!ctx.hasUI || !ctx.ui) return noUI(items[0]!, multi);

      const answers: AskToolDetails[] = [];
      let index = 0;
      while (index < items.length) {
        const item = items[index]!;
        const shown = describe(item);
        const previous = answers[index]?.response;
        const picked = previous?.kind === "selection" ? previous.selections.map((title) => shown.options.findIndex((o) => o.title === title)).filter((i) => i >= 0) : [];
        if (multi || shown.options.length) {
          onUpdate?.({
            content: text(multi ? `Waiting for user input (${index + 1}/${items.length})...` : "Waiting for user input..."),
            details: { ...shown, response: null, cancelled: false, ...(multi && { answers }) },
          });
        }
        const result = await askQuestion(ctx, {
          ...item,
          options: shown.options,
          context: shown.context,
          signal,
          ...(multi && {
            // Forward only from an answered question, so none can be skipped.
            navigation: { index, total: items.length, canPrev: index > 0, canNext: index < items.length - 1 && previous != null },
            initialIndex: picked[0] ?? 0,
            checkedIndices: picked,
          }),
        });
        if (isNavigate(result)) {
          index += result.__navigate === "prev" ? -1 : 1;
          continue;
        }
        if (result === null || isCancel(result)) {
          const cancelled: AskToolDetails = { ...shown, response: null, cancelled: true, ...(isCancel(result) ? { cancelReason: result.reason } : {}) };
          if (!multi) return { content: text("User cancelled the question"), details: cancelled };
          answers[index] = cancelled;
          return { content: text(`User cancelled question ${index + 1}/${items.length}`), details: { ...cancelled, answers } };
        }
        answers[index] = { ...shown, response: result, cancelled: false };
        index++;
      }
      if (!multi) return { content: text(`User answered: ${formatResponse(answers[0]!.response!)}`), details: answers[0]! };
      const summary = answers.map((answer, i) => `${i + 1}. ${answer.question}: ${formatResponse(answer.response!)}`).join("\n");
      return { content: text(`User answered:\n${summary}`), details: { ...answers[answers.length - 1]!, answers } };
    },
    renderCall(args: any, theme) {
      const questions: any[] = Array.isArray(args.questions) ? args.questions : [];
      const question = args.question || questions[0]?.question || "";
      const options: unknown[] = Array.isArray(args.options) ? args.options : [];
      let line = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", questions.length ? `${questions.length} questions · ${question}` : question);
      if (options.length) {
        const labels = options.map((o: any) => (typeof o === "string" ? o : o?.title ?? ""));
        line += "\n" + theme.fg("dim", `  ${options.length} option(s): ${labels.join(", ")}`);
      }
      if (args.allowMultiple) line += theme.fg("dim", " [multi-select]");
      if (args.allowComment) line += theme.fg("dim", " [optional comment]");
      return new Text(line, 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as (AskToolDetails & { error?: string }) | undefined;
      if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      if (options.isPartial) {
        const waiting = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
        return new Text(theme.fg("muted", waiting || "Waiting for user input..."), 0, 0);
      }
      if (!details || details.cancelled || !details.response) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      if (details.answers && details.answers.length > 1) {
        const lines = details.answers.map((answer, i) => `${i + 1}. ${answer.question}: ${answer.response ? formatResponse(answer.response) : "cancelled"}`);
        return new Text(theme.fg("success", `✓ ${details.answers.length} answers`) + (options.expanded ? `\n${lines.join("\n")}` : ""), 0, 0);
      }
      const response = details.response;
      let out = theme.fg("success", "✓ ") + (response.kind === "freeform" ? theme.fg("muted", "(wrote) ") : "") + theme.fg("accent", formatResponse(response));
      if (options.expanded) {
        out += "\n" + theme.fg("dim", `Q: ${details.question}`);
        if (details.context) out += "\n" + theme.fg("dim", details.context);
        if (response.kind === "selection" && details.options.length) {
          const chosen = new Set(response.selections);
          out += "\n" + theme.fg("dim", "Options:");
          for (const option of details.options) {
            const marker = chosen.has(option.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
            out += `\n  ${marker} ${theme.fg("dim", option.title)}${theme.fg("dim", option.description ? ` — ${option.description}` : "")}`;
          }
          if (response.comment) out += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
        }
      }
      return new Text(out, 0, 0);
    },
  });
}

function noUI(item: AskItem, multi: AskItem[] | undefined) {
  if (multi) {
    const details: AskToolDetails = { question: item.question, options: [], response: null, cancelled: true };
    return { content: text(`Ask requires interactive mode. ${multi.length} questions could not be presented.`), isError: true, details };
  }
  const shown = describe(item);
  const details: AskToolDetails = { ...shown, response: null, cancelled: true };
  const message = [
    `Ask requires interactive mode. Please answer:\n\n${shown.question}`,
    shown.context && `Context:\n${shown.context}`,
    shown.options.length > 0 && `Options:\n${formatOptionList(shown.options)}`,
    item.allowFreeform !== false && "You can also answer freely.",
    item.allowComment !== false && "After choosing an option, you may add an optional comment.",
  ].filter(Boolean).join("\n\n");
  return { content: text(message), isError: true, details };
}
