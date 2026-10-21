// The forms pi-pi asks bb's plugin to show, and what comes back. pi-pi keeps a
// copy (extensions/orchestrator/bb-forms.ts); its tests check the two match.
// Bump `version` on an incompatible change: a plugin that does not know it
// refuses the form, and pi-pi falls back to bb's own dialogs.

export const FORM_VERSION = 1;
export const RENDERER_ID = "pi-pi-ask";

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
  | { version: 1; kind: "worker-question"; workerId: string; workerLabel: string; questionId: string; question: string };

/** One question's answer; `selections` are option titles. */
export type FormAnswer =
  | { kind: "selection"; selections: string[]; other?: string; comment?: string }
  | { kind: "freeform"; text: string };

export type FormValue =
  | { kind: "ask"; answers: FormAnswer[] }
  | { kind: "confirm"; decision: "yes" | "no"; comment?: string }
  | { kind: "answer"; text: string }
  | { kind: "decline"; note?: string };
