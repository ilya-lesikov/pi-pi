// pi-pi's forms in bb's composer: ask_user's questions, confirm, and a worker's
// question. Modelled on bb's own question form, so it reads and answers the
// same way; bb draws the card around it, with the title and its own Cancel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { experimental_useQuestionFormHost, type ExperimentalQuestionShortcut, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { FORM_VERSION, type FormAnswer, type FormQuestion, type FormSpec, type FormValue } from "./forms";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const OTHER = "Other…";

export function PiPiForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const spec = interaction.payload as unknown as FormSpec;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state: a second shortcut press lands before the re-render that disables the form.
  const sending = useRef(false);
  const send = useCallback(async (value: FormValue) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await submit(value as never);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      sending.current = false;
      setBusy(false);
    }
  }, [submit]);
  const dismiss = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      await cancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      sending.current = false;
      setBusy(false);
    }
  }, [cancel]);
  if (!spec || (spec as { version?: number }).version !== FORM_VERSION) {
    return (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>This form needs a newer pi-pi bb plugin. Cancel, and the agent will ask in plain text.</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void dismiss()}>Cancel</Button>
      </div>
    );
  }
  // bb draws no Cancel around a plugin's form; each form has its own, as bb's question form does.
  return (
    <fieldset disabled={busy} className="min-w-0 text-xs">
      {spec.kind === "ask" ? <AskForm questions={spec.questions} onSubmit={send} onCancel={dismiss} /> : null}
      {spec.kind === "confirm" ? <ConfirmForm spec={spec} onSubmit={send} onCancel={dismiss} /> : null}
      {spec.kind === "worker-question" ? <WorkerQuestionForm spec={spec} onSubmit={send} onCancel={dismiss} /> : null}
      {error ? <p className="mt-2 text-destructive">{error}</p> : null}
    </fieldset>
  );
}

// --- ask_user ------------------------------------------------------------------

interface Draft {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
  comment: string;
  commentOpen: boolean;
}

const emptyDraft = (question: FormQuestion): Draft => ({
  // The recommended option is preselected for a single choice, as in the terminal, where it has the focus.
  selected: !question.allowMultiple && question.recommended ? [question.recommended] : [],
  otherSelected: question.options.length === 0,
  otherText: "",
  comment: "",
  commentOpen: false,
});

function answered(draft: Draft): boolean {
  return draft.selected.length > 0 || (draft.otherSelected && draft.otherText.trim().length > 0);
}

function toAnswer(question: FormQuestion, draft: Draft): FormAnswer {
  const other = draft.otherSelected ? draft.otherText.trim() : "";
  const comment = draft.comment.trim();
  if (!question.options.length) return { kind: "freeform", text: other };
  if (!question.allowMultiple && other) return { kind: "freeform", text: comment ? `${other}\n\nComment: ${comment}` : other };
  return { kind: "selection", selections: draft.selected, ...(other ? { other } : {}), ...(comment ? { comment } : {}) };
}

function AskForm({ questions, onSubmit, onCancel }: { questions: FormQuestion[]; onSubmit: (value: FormValue) => void; onCancel: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
  const [index, setIndex] = useState(0);
  const [declining, setDeclining] = useState(false);
  const question = questions[index]!;
  const draft = drafts[index]!;
  const last = index === questions.length - 1;
  const ready = drafts.every(answered);
  const root = useRef<HTMLDivElement>(null);
  const update = (change: (draft: Draft) => Draft) => setDrafts((all) => all.map((entry, i) => (i === index ? change(entry) : entry)));

  const toggle = useCallback((title: string) => {
    setDrafts((all) => all.map((entry, i) => {
      if (i !== index) return entry;
      if (questions[i]!.allowMultiple) {
        return { ...entry, selected: entry.selected.includes(title) ? entry.selected.filter((value) => value !== title) : [...entry.selected, title] };
      }
      return { ...entry, selected: [title], otherSelected: false };
    }));
  }, [index, questions]);
  // Focus moves into the Other box only right after the user picks Other, not when a tab is revisited.
  const [focusOther, setFocusOther] = useState(false);
  const chooseOther = useCallback(() => {
    setFocusOther(true);
    setDrafts((all) => all.map((entry, i) => {
      if (i !== index) return entry;
      return questions[i]!.allowMultiple ? { ...entry, otherSelected: !entry.otherSelected } : { ...entry, selected: [], otherSelected: true };
    }));
  }, [index, questions]);

  const finish = () => onSubmit({ kind: "ask", answers: drafts.map((entry, i) => toAnswer(questions[i]!, entry)) });
  const next = () => {
    if (!answered(draft)) return;
    setFocusOther(false);
    if (last) {
      if (ready) finish();
      else setIndex(drafts.findIndex((entry) => !answered(entry)));
    } else setIndex(index + 1);
  };

  const host = experimental_useQuestionFormHost();
  const choices = useMemo(() => [...question.options.map((option) => option.title), ...(question.allowFreeform && question.options.length ? [OTHER] : [])], [question]);
  useEffect(() => {
    if (declining) return;
    return host.registerChoiceHandler((choice) => {
      const title = choices[choice];
      if (title === undefined) return false;
      if (title === OTHER && question.allowFreeform) chooseOther();
      else toggle(title);
      root.current?.focus();
      return true;
    });
  }, [host, choices, question, toggle, chooseOther, declining]);

  if (declining) return <DeclineNote onBack={() => setDeclining(false)} onSubmit={(note) => onSubmit({ kind: "decline", ...(note ? { note } : {}) })} />;

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        next();
      }}
      className="-m-1 flex min-h-0 flex-col rounded-md p-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {questions.length > 1 ? (
        <div className="mb-2 flex items-center gap-2">
          <div role="tablist" aria-label="Questions" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {questions.map((entry, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                onClick={() => {
                  setFocusOther(false);
                  setIndex(i);
                }}
                aria-selected={i === index}
                title={entry.question}
                className={cn("h-7 shrink-0 rounded-md px-2", i === index ? "bg-muted text-foreground" : "hover:bg-state-hover")}
              >
                <span className="flex max-w-[200px] items-center gap-1">
                  {answered(drafts[i]!) ? <Icon name="Check" className="size-3 shrink-0" aria-label="answered" /> : null}
                  <span className="truncate">{entry.header || `Question ${i + 1}`}</span>
                </span>
              </button>
            ))}
          </div>
          <span className="shrink-0">{index + 1} of {questions.length}</span>
        </div>
      ) : null}
      <div className="whitespace-pre-wrap break-words font-medium text-foreground">{question.question}</div>
      {question.allowMultiple ? <div className="mt-0.5">Choose any that apply.</div> : null}
      <div role={question.allowMultiple ? "group" : "radiogroup"} aria-label={question.question} className="mt-1 space-y-0.5">
        {question.options.map((option, i) => (
          <Choice
            key={option.title}
            checked={draft.selected.includes(option.title)}
            multi={question.allowMultiple}
            label={option.title}
            description={option.description}
            recommended={option.title === question.recommended}
            shortcut={host.shortcuts.get(String(i))}
            onSelect={() => toggle(option.title)}
          />
        ))}
        {question.allowFreeform && question.options.length ? (
          <Choice checked={draft.otherSelected} multi={question.allowMultiple} label={OTHER} shortcut={host.shortcuts.get(String(question.options.length))} onSelect={chooseOther} />
        ) : null}
      </div>
      {draft.otherSelected ? (
        <TextArea autoFocus={focusOther} value={draft.otherText} placeholder={question.options.length ? "Type your own answer…" : "Type your answer…"} label="Your answer" onChange={(otherText) => update((entry) => ({ ...entry, otherText }))} onSubmit={next} />
      ) : null}
      {question.allowComment && question.options.length ? (
        draft.commentOpen ? (
          <TextArea value={draft.comment} placeholder="Optional comment for the agent…" label="Comment" onChange={(comment) => update((entry) => ({ ...entry, comment }))} onSubmit={next} />
        ) : (
          <button type="button" className="mt-2 cursor-pointer text-left hover:text-foreground" onClick={() => update((entry) => ({ ...entry, commentOpen: true }))}>
            + Add a comment
          </button>
        )
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDeclining(true)}>Cancel with a reason</Button>
        </div>
        <div className="flex items-center gap-2">
          {index > 0 ? <Button type="button" size="sm" variant="outline" onClick={() => { setFocusOther(false); setIndex(index - 1); }}>Back</Button> : null}
          <Button type="button" size="sm" disabled={!answered(draft)} onClick={next}>
            {last ? (ready ? "Submit answer" : "Next unanswered") : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- confirm -------------------------------------------------------------------

function ConfirmForm({ spec, onSubmit, onCancel }: { spec: Extract<FormSpec, { kind: "confirm" }>; onSubmit: (value: FormValue) => void; onCancel: () => void }) {
  const [comment, setComment] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  // Dangerous: No comes first, so the first shortcut declines.
  const order = useMemo<Array<"yes" | "no">>(() => (spec.danger ? ["no", "yes"] : ["yes", "no"]), [spec.danger]);
  const commentRef = useRef(comment);
  commentRef.current = comment;
  const decide = useCallback((decision: "yes" | "no") => {
    const note = commentRef.current.trim();
    onSubmit({ kind: "confirm", decision, ...(note ? { comment: note } : {}) });
  }, [onSubmit]);
  const host = experimental_useQuestionFormHost();
  useEffect(() => {
    if (declining) return;
    return host.registerChoiceHandler((choice) => {
      const decision = order[choice];
      if (!decision) return false;
      decide(decision);
      return true;
    });
  }, [host, decide, order, declining]);

  if (declining) return <DeclineNote onBack={() => setDeclining(false)} onSubmit={(note) => onSubmit({ kind: "decline", ...(note ? { note } : {}) })} />;
  return (
    <div>
      <div className="whitespace-pre-wrap break-words font-medium text-foreground">{spec.question}</div>
      {spec.detail ? <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{spec.detail}</div> : null}
      {spec.danger ? (
        <div className="mt-2 flex items-center gap-1.5 text-destructive">
          <Icon name="TriangleAlert" className="size-3.5" />
          Destructive or hard to undo.
        </div>
      ) : null}
      {commentOpen ? (
        <TextArea autoFocus value={comment} placeholder="Optional comment for the agent…" label="Comment" onChange={setComment} />
      ) : (
        <button type="button" className="mt-2 cursor-pointer text-left text-muted-foreground hover:text-foreground" onClick={() => setCommentOpen(true)}>
          + Add a comment
        </button>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDeclining(true)}>Cancel with a reason</Button>
        </div>
        <div className="flex items-center gap-2">
          {order.map((decision, i) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              aria-keyshortcuts={host.shortcuts.get(String(i))?.ariaKeyshortcuts}
              variant={decision === "yes" ? (spec.danger ? "destructive" : "default") : "outline"}
              onClick={() => decide(decision)}
            >
              {decision === "yes" ? "Yes" : "No"}
              {host.shortcuts.get(String(i)) ? <kbd className="ml-1.5 text-[10px] opacity-70">{host.shortcuts.get(String(i))!.label}</kbd> : null}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- a worker's question -------------------------------------------------------------

function WorkerQuestionForm({ spec, onSubmit, onCancel }: { spec: Extract<FormSpec, { kind: "worker-question" }>; onSubmit: (value: FormValue) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (text.trim()) onSubmit({ kind: "answer", text: text.trim() });
  };
  return (
    <div>
      <div className="text-muted-foreground">{spec.workerLabel} · {spec.workerId}</div>
      <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-foreground">{spec.question}</div>
      <TextArea value={text} placeholder="Your answer for the worker…" label="Answer" onChange={setText} onSubmit={send} />
      <div className="mt-1 text-muted-foreground">The agent sees this question too.</div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Leave it to the agent</Button>
        <Button type="button" size="sm" disabled={!text.trim()} onClick={send}>Send answer</Button>
      </div>
    </div>
  );
}

// --- shared pieces -------------------------------------------------------------------

function DeclineNote({ onBack, onSubmit }: { onBack: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div>
      <div className="font-medium text-foreground">Why? The agent gets your reason.</div>
      <TextArea autoFocus value={note} placeholder="Optional reason…" label="Reason" onChange={setNote} onSubmit={() => onSubmit(note.trim())} />
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>Back</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onSubmit(note.trim())}>Cancel the question</Button>
      </div>
    </div>
  );
}

function Choice({ checked, multi, label, description, recommended, shortcut, onSelect }: {
  checked: boolean;
  multi: boolean;
  label: string;
  description?: string;
  recommended?: boolean;
  shortcut?: ExperimentalQuestionShortcut;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn("flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors", checked ? "bg-surface-selected" : "hover:bg-state-hover")}
    >
      <span className={cn("mt-px flex size-4 shrink-0 items-center justify-center border", multi ? "rounded" : "rounded-full", checked ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
        {checked ? <Icon name="Check" className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-foreground">
          {label}
          {recommended ? <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">recommended</span> : null}
        </span>
        {description ? <span className="mt-0.5 block whitespace-pre-wrap break-words leading-snug text-muted-foreground">{description}</span> : null}
      </span>
      {shortcut ? <kbd className="shrink-0 font-normal text-subtle-foreground">{shortcut.label}</kbd> : null}
    </button>
  );
}

function TextArea({ value, placeholder, label, autoFocus, onChange, onSubmit }: {
  value: string;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}) {
  return (
    <textarea
      aria-label={label}
      value={value}
      rows={2}
      autoFocus={autoFocus}
      autoComplete="off"
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        // Cmd/Ctrl+Enter submits, as in bb's own form; Enter alone is a new line.
        if (!onSubmit || event.nativeEvent.isComposing || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        onSubmit();
      }}
      className="mt-2 block max-h-40 min-h-[60px] w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
    />
  );
}
