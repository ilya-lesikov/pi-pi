import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bbForms } from "../bb-forms.js";
import { detectHost, fitLine } from "../host.js";
import { askUser, isCancel } from "./ui.js";

type Decision = "yes" | "no" | "dismissed" | "unanswered" | "unattended";

interface ConfirmDetails {
  question: string;
  danger: boolean;
  decision: Decision;
  comment?: string;
  note?: string;
  /** A message the user sent in the chat after deciding in bb's form. */
  alsoTyped?: string;
}

const DESCRIPTION = "Put one yes/no decision to the user and wait for it: permission before you change something, or any answer that is 'go ahead' or 'don't'. Write the question in the user's language and say exactly what you are about to do, so the answer is informed. Set danger for anything destructive or hard to undo. You get back yes, no, or that the user dismissed it, plus any comment. For anything with more than two answers use ask_user.";

const PARAMETERS = Type.Object({
  question: Type.String({ description: "One line: exactly what you are about to do, as a yes/no question" }),
  detail: Type.Optional(Type.String({ description: "One line of consequence or scope, shown under the question" })),
  danger: Type.Optional(Type.Boolean({ description: "Destructive or hard to undo: No is the default, and a run without a user never proceeds" })),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

function resultFor(details: ConfirmDetails) {
  const comment = details.comment ? ` They added: "${details.comment}".` : "";
  switch (details.decision) {
    case "yes":
      return `User confirmed: yes.${comment}`;
    case "no":
      return `User declined: no.${comment} Do not do it and do not ask again; propose a different approach or ask what to do instead.`;
    case "dismissed":
      return `User dismissed the question without deciding${details.note ? ` ("${details.note}")` : ""}. Treat it as not approved: do not do it, and do not ask again in the same form.`;
    case "unanswered":
      return `Not confirmed — bb took the question down before the user answered (${details.note}). Do not do it yet; ask in plain prose in your reply and end the turn.`;
    case "unattended":
      return details.danger
        ? "Not confirmed — no user is available (non-interactive run), and the action is marked dangerous. Do not do it; report that it needs approval."
        : "Not confirmed — no user is available (non-interactive run). Proceed only if the action is reversible, and state that assumption; otherwise stop and report.";
  }
}

const YES = /^(y|yes|yeah|yep|sure|ok|okay|go|go ahead|do it|да|ага|давай|ок|го)[.!]*$/i;
const NO = /^(n|no|nope|don'?t|stop|нет|не надо|не|стоп)[.!]*$/i;

/** Under bb with pi-pi's plugin; undefined when no form could be shown. */
async function confirmViaBbForm(ctx: any, base: { question: string; danger: boolean }, detail: string | undefined, signal: AbortSignal | undefined): Promise<ConfirmDetails | undefined> {
  const forms = detectHost(ctx.mode).id === "bb" ? bbForms() : null;
  if (!forms) return undefined;
  const outcome = await forms.ask(
    { version: 1, kind: "confirm", question: base.question, ...(detail?.trim() ? { detail: detail.trim().slice(0, 4000) } : {}), danger: base.danger },
    {
      title: fitLine(base.question, 160),
      signal,
      // A plain yes or no typed in the chat decides it; anything else is not a decision.
      onTyped: (typed) => (YES.test(typed) ? { kind: "confirm", decision: "yes" } : NO.test(typed) ? { kind: "confirm", decision: "no" } : { kind: "decline", note: typed }),
    },
  );
  if (outcome.outcome === "unavailable") return undefined;
  if (outcome.outcome === "cancelled" && outcome.reason !== "user" && outcome.reason !== "signal") {
    // Not the user's decision: bb or the connection took the form down.
    return { ...base, decision: "unanswered", note: outcome.reason };
  }
  const alsoTyped = outcome.outcome === "submitted" && outcome.alsoTyped ? { alsoTyped: outcome.alsoTyped } : {};
  if (outcome.outcome === "submitted" && outcome.value.kind === "confirm") {
    return { ...base, decision: outcome.value.decision, ...(outcome.value.comment?.trim() ? { comment: outcome.value.comment.trim() } : {}), ...alsoTyped };
  }
  const note = outcome.outcome === "submitted" && outcome.value.kind === "decline" ? outcome.value.note : undefined;
  return { ...base, decision: "dismissed", ...(note ? { note } : {}), ...alsoTyped };
}

export function registerConfirm(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "confirm",
    label: "Confirm",
    description: DESCRIPTION,
    promptSnippet: "Ask the user a single yes/no question, such as permission to go ahead",
    executionMode: "sequential",
    parameters: PARAMETERS,
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const params = raw as { question?: string; detail?: string; danger?: boolean };
      const question = params.question?.trim();
      if (!question) return { content: text("confirm requires a question"), isError: true, details: { error: "missing question" } };
      const base = { question, danger: params.danger === true };
      if (!ctx.hasUI || !ctx.ui) {
        const details: ConfirmDetails = { ...base, decision: "unattended" };
        return { content: text(resultFor(details)), details };
      }
      let details: ConfirmDetails;
      if (ctx.mode === undefined || ctx.mode === "tui") {
        const options = params.danger ? ["No", "Yes"] : ["Yes", "No"];
        const result = await askUser(ctx as any, {
          question,
          detail: params.detail,
          options,
          allowFreeform: false,
          declineNote: true,
          signal,
          label: "confirm",
          hotkeys: { y: options.indexOf("Yes"), n: options.indexOf("No") },
        });
        if (result && !isCancel(result) && result.kind === "selection") {
          details = { ...base, decision: result.selections[0] === "Yes" ? "yes" : "no", ...(result.comment ? { comment: result.comment } : {}) };
        } else {
          details = { ...base, decision: "dismissed", ...(isCancel(result) && result.note ? { note: result.note } : {}) };
        }
      } else {
        const viaForm = await confirmViaBbForm(ctx, base, params.detail, signal);
        if (viaForm) {
          details = viaForm;
        } else {
          // Hosts render confirm as their native approval: Yes and No, with a
          // dismissal that comes back as No. The question goes in the title,
          // which every host shows.
          // T3 answers a confirm it has seen approved "always" by itself; a
          // dangerous one carries the time it was asked, so it is always new.
          const detail = [params.detail?.trim().slice(0, 4000), params.danger ? `⚠ Destructive · request ${randomUUID().slice(0, 8)}` : ""].filter(Boolean).join("\n");
          const yes = await ctx.ui.confirm(fitLine(question, 160), detail, { signal });
          details = { ...base, decision: signal?.aborted ? "dismissed" : yes ? "yes" : "no" };
        }
      }
      const result = resultFor(details);
      return { content: text(details.alsoTyped ? `${result}\nAfter deciding, the user also wrote in the chat: "${details.alsoTyped}"` : result), details };
    },
    renderCall(args: any, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("confirm ")) + theme.fg("muted", fitLine(String(args.question ?? ""), 80)), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as (ConfirmDetails & { error?: string }) | undefined;
      if (!details || details.error) return new Text(theme.fg("error", `✗ ${details?.error ?? "failed"}`), 0, 0);
      const mark = details.decision === "yes" ? theme.fg("success", "✓ yes") : details.decision === "no" ? theme.fg("warning", "✗ no") : theme.fg("warning", `✗ ${details.decision === "unattended" ? "no user" : details.decision === "unanswered" ? "not answered" : "dismissed"}`);
      return new Text(`${mark}${details.comment ? theme.fg("muted", `  “${details.comment}”`) : ""}`, 0, 0);
    },
  });
}
