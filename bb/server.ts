// pi-pi's bb plugin backend: reads the state file pi-pi writes into a thread's
// storage directory and drops worker commands next to it. Both go through
// bb's file API on the machine that owns the thread, so remote machines work too.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { FORM_VERSION, RENDERER_ID, type FormSpec, type FormValue } from "./forms";
import type { BbCommand, BbState } from "./state";

const threadInput = z.object({ threadId: z.string().min(1) });
const formInput = threadInput.extend({ formId: z.string().uuid() });

// Mirrors pi's lease (extensions/orchestrator/bb-forms.ts): a form nobody polls is an orphan.
const LEASE_MS = 20_000;
// An answer pi has not collected yet is kept this long: longer than pi keeps
// retrying through an outage, so an answer given before one is not asked again.
const SETTLED_KEPT_MS = 240_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
// bb's limit on a form's payload, in bytes.
const MAX_PAYLOAD_BYTES = 64 * 1024;
// How long an open waits to hear whether bb refused the form outright.
const REFUSAL_WAIT_MS = 1000;

const text = (max: number) => z.string().max(max);
const optionSchema = z.object({ title: text(500).min(1), description: text(2000).optional() });
const formSchema: z.ZodType<FormSpec> = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(FORM_VERSION),
    kind: z.literal("ask"),
    questions: z.array(z.object({
      question: text(4000).min(1),
      header: text(200).optional(),
      options: z.array(optionSchema).max(200),
      recommended: text(500).optional(),
      allowMultiple: z.boolean(),
      allowFreeform: z.boolean(),
      allowComment: z.boolean(),
    })).min(1).max(20),
  }),
  z.object({ version: z.literal(FORM_VERSION), kind: z.literal("confirm"), question: text(4000).min(1), detail: text(4000).optional(), danger: z.boolean() }),
  z.object({ version: z.literal(FORM_VERSION), kind: z.literal("worker-question"), workerId: text(200).min(1), workerLabel: text(500).min(1), questionId: text(300).min(1), question: text(20_000).min(1) }),
  z.object({ version: z.literal(FORM_VERSION), kind: z.literal("input"), question: text(4000).min(1), placeholder: text(500).optional(), prefill: text(50_000).optional(), multiline: z.boolean() }),
  z.object({ version: z.literal(FORM_VERSION), kind: z.literal("report"), text: text(55_000) }),
]);

// The form kinds this plugin shows; pi asks before relying on the newer ones.
const FORM_KINDS = ["ask", "confirm", "worker-question", "input", "report"] as const;

type Settled = { state: "submitted"; value: FormValue } | { state: "cancelled"; reason: string };

interface LiveForm {
  threadId: string;
  session: string;
  controller: AbortController;
  polledAt: number;
  settled?: Settled;
  settledAt?: number;
}

export const rpcContract = defineRpcContract({
  state_get: {
    input: threadInput,
    // Validated by pi-pi's writer; the plugin only checks the version it understands.
    // `failed`: the file could not be read this time; the last state read still stands.
    output: z.object({ state: z.custom<BbState>().nullable(), failed: z.boolean().optional() }),
  },
  form_open: {
    input: formInput.extend({ session: z.string().uuid(), title: text(160).min(1), form: z.unknown(), timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional() }),
    output: z.object({ ok: z.literal(true) }),
  },
  form_poll: {
    input: formInput,
    output: z.object({ state: z.enum(["pending", "submitted", "cancelled", "unknown"]), value: z.custom<FormValue>().optional(), reason: z.string().optional() }),
  },
  form_cancel: { input: formInput, output: z.object({ ok: z.literal(true) }) },
  form_cancel_session: { input: threadInput.extend({ exceptSession: z.string().uuid() }), output: z.object({ cancelled: z.number() }) },
  capabilities: { input: threadInput, output: z.object({ kinds: z.array(z.string()) }) },
  menu_open: { input: threadInput, output: z.object({ id: z.string() }) },
  command_send: {
    input: threadInput.extend({
      workerId: z.string().min(1).max(200),
      action: z.enum(["stop", "kill", "message"]),
      text: z.string().max(20_000).optional(),
    }),
    output: z.object({ id: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // A thread's storage directory never moves while the thread exists.
  const locations = new Map<string, { hostId: string; dir: string }>();
  const locate = async (threadId: string) => {
    const known = locations.get(threadId);
    if (known) return known;
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    const location = { hostId, dir: `${storageRootPath.replace(/\/+$/, "")}/pi-pi` };
    locations.set(threadId, location);
    return location;
  };

  // A read that fails (a busy daemon, a machine briefly offline) must not read
  // as "no state", which takes the cards down until the next poll; counted, so
  // the log says how often it happens.
  let readFailures = 0;
  let loggedAt = 0;
  const readFailed = (error: unknown) => {
    readFailures++;
    // At most every few seconds: a machine that stays offline fails every poll.
    if (Date.now() - loggedAt > 10_000) {
      loggedAt = Date.now();
      bb.log.warn(`reading pi-pi's state failed (${readFailures} so far): ${error instanceof Error ? error.message : String(error)}`);
    }
    return { state: null, failed: true };
  };

  const sendCommand = async (threadId: string, command: BbCommand) => {
    const { hostId, dir } = await locate(threadId);
    const name = `${Date.now()}-${command.id}.json`;
    // Written aside and moved in, so pi never reads half a command.
    const temp = `${dir}/commands/${name}.tmp`;
    await bb.sdk.files.write({ hostId, path: temp, content: JSON.stringify(command), createParents: true });
    try {
      await bb.sdk.files.move({ hostId, sourcePath: temp, destinationPath: `${dir}/commands/${name}` });
    } catch (error) {
      // pi never picks up a .tmp, so nothing else would ever remove it.
      await bb.sdk.files.remove({ hostId, path: temp }).catch(() => {});
      throw error;
    }
    return { id: command.id };
  };

  const forms = new Map<string, LiveForm>();
  const settle = (form: LiveForm, settled: Settled) => {
    if (form.settled) return;
    form.settled = settled;
    form.settledAt = Date.now();
    form.controller.abort();
  };
  // A background service, so bb stops it with the plugin.
  bb.background.service("forms-sweep", {
    // Resolves only when bb stops it; a start that returns reads as a stopped service.
    start: (signal) => new Promise<void>((resolve) => {
      const sweep = setInterval(() => {
        const now = Date.now();
        for (const [formId, form] of forms) {
          if (!form.settled && now - form.polledAt > LEASE_MS) settle(form, { state: "cancelled", reason: "lease-expired" });
          if (form.settled && now - form.settledAt! > SETTLED_KEPT_MS) forms.delete(formId);
        }
      }, 5000);
      signal.addEventListener("abort", () => {
        clearInterval(sweep);
        resolve();
      }, { once: true });
    }),
  });

  // Like command_send, these are open to any local process of the same user, as
  // all of bb's local API is; form ids are random, so only open and the
  // per-thread cancel can touch forms a caller did not open.
  bb.rpc.register(rpcContract, {
    form_open: async ({ threadId, formId, session, title, form, timeoutMs }) => {
      // Idempotent: pi reopens a form bb took down, under the same id.
      const existing = forms.get(formId);
      if (existing && existing.threadId !== threadId) throw new Error("Unsupported form: the form belongs to another thread");
      if (existing && !existing.settled) return { ok: true as const };
      const parsed = formSchema.safeParse(form);
      if (!parsed.success) throw new Error(`Unsupported form: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      const spec = parsed.data;
      // bb counts the payload in bytes; the schema's limits are in characters.
      if (Buffer.byteLength(JSON.stringify(spec)) > MAX_PAYLOAD_BYTES) throw new Error("Unsupported form: too large for bb");
      if (!title.trim()) throw new Error("Unsupported form: empty title");
      const live: LiveForm = { threadId, session, controller: new AbortController(), polledAt: Date.now() };
      forms.set(formId, live);
      const shown = bb.ui
        .requestInput(
          {
            threadId,
            rendererId: RENDERER_ID,
            title,
            payload: spec as never,
            ...(timeoutMs !== undefined ? { timeoutMs } : { timeoutMs: MAX_TIMEOUT_MS }),
            presentation: { label: labels(spec), suppress: spec.kind !== "worker-question" },
            describeSubmission: (value) => describe(spec, value as FormValue),
          },
          { signal: live.controller.signal },
        )
        .then(
          (result) => {
            settle(live, result.outcome === "submitted" ? { state: "submitted", value: result.value as FormValue } : { state: "cancelled", reason: result.reason });
            return true;
          },
          (error) => {
            const reason = error instanceof Error ? error.message : String(error);
            bb.log.warn(`bb could not show pi-pi's form ${formId} in thread ${threadId}: ${reason}`);
            settle(live, { state: "cancelled", reason: `failed: ${reason}` });
            return false;
          },
        );
      // bb refuses a form it cannot show at once; failing the open lets pi ask with bb's own dialogs instead.
      const refused = await Promise.race([shown.then((ok) => !ok), new Promise<false>((resolve) => setTimeout(resolve, REFUSAL_WAIT_MS, false))]);
      if (refused) {
        forms.delete(formId);
        throw new Error(`Unsupported form: bb could not show it (${live.settled?.state === "cancelled" ? live.settled.reason : "failed"})`);
      }
      return { ok: true as const };
    },
    form_poll: async ({ threadId, formId }) => {
      const form = forms.get(formId);
      if (!form || form.threadId !== threadId) return { state: "unknown" as const };
      form.polledAt = Date.now();
      if (!form.settled) return { state: "pending" as const };
      return form.settled.state === "submitted" ? { state: "submitted" as const, value: form.settled.value } : { state: "cancelled" as const, reason: form.settled.reason };
    },
    form_cancel: async ({ threadId, formId }) => {
      const form = forms.get(formId);
      if (form?.threadId === threadId) settle(form, { state: "cancelled", reason: "request-aborted-by-pi" });
      return { ok: true as const };
    },
    form_cancel_session: async ({ threadId, exceptSession }) => {
      let cancelled = 0;
      for (const form of forms.values()) {
        if (form.threadId !== threadId || form.session === exceptSession || form.settled) continue;
        settle(form, { state: "cancelled", reason: "pi-restarted" });
        cancelled++;
      }
      return { cancelled };
    },
    state_get: async ({ threadId }) => {
      let location: { hostId: string; dir: string };
      try {
        location = await locate(threadId);
      } catch (error) {
        return readFailed(error);
      }
      try {
        const file = await bb.sdk.files.read({ hostId: location.hostId, path: `${location.dir}/state.json` });
        if (file.contentEncoding !== "utf8") return { state: null };
        const state = JSON.parse(file.content) as BbState;
        return { state: state?.version === 1 ? state : null };
      } catch (error) {
        // No file: not a pi-pi thread, or nothing written yet. bb's daemon says "Path does not exist" with code ENOENT.
        if ((error as { code?: unknown })?.code === "ENOENT" || /does not exist|not[ _-]?found|ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))) return { state: null };
        return readFailed(error);
      }
    },
    command_send: async ({ threadId, workerId, action, text }) => sendCommand(threadId, { id: randomUUID(), workerId, action, ...(text !== undefined ? { text } : {}) }),
    capabilities: async () => ({ kinds: [...FORM_KINDS] }),
    menu_open: async ({ threadId }) => sendCommand(threadId, { id: randomUUID(), action: "menu" }),
  });
}

// bb refuses a row label longer than this.
const LABEL_CHARS = 80;

function labels(spec: FormSpec): { pending: string; completed: string } {
  if (spec.kind === "report") return { pending: "Report", completed: "Closed" };
  if (spec.kind === "input") return { pending: "Waiting for your input", completed: "Entered" };
  if (spec.kind === "worker-question") return { pending: clip(`${spec.workerLabel} asks you`, LABEL_CHARS), completed: clip(`Answered ${spec.workerLabel}`, LABEL_CHARS) };
  if (spec.kind === "confirm") return { pending: "Waiting for your decision", completed: "Decided" };
  return { pending: "Waiting for your answer", completed: "Answered" };
}

function describe(spec: FormSpec, value: FormValue): { title: string; detail?: string } {
  if (value.kind === "decline") return { title: "Declined", ...(value.note ? { detail: value.note } : {}) };
  if (value.kind === "confirm") return { title: value.decision === "yes" ? "Yes" : "No", ...(value.comment ? { detail: value.comment } : {}) };
  if (value.kind === "closed") return { title: "Closed" };
  if (value.kind === "input") return { title: "Entered" };
  if (value.kind === "answer") return { title: clip(`Answered ${spec.kind === "worker-question" ? spec.workerLabel : ""}`.trim(), LABEL_CHARS), detail: value.text };
  const questions = spec.kind === "ask" ? spec.questions : [];
  const lines = value.answers.map((answer, i) => {
    const shown = answer.kind === "freeform" ? answer.text : [...answer.selections, ...(answer.other ? [answer.other] : [])].join(", ") + (answer.comment ? ` — ${answer.comment}` : "");
    return questions.length > 1 ? `${questions[i]?.header || questions[i]?.question || `Question ${i + 1}`}: ${shown}` : shown;
  });
  return { title: lines.length === 1 ? clip(lines[0]!, LABEL_CHARS) : `${lines.length} answers`, detail: lines.join("\n") };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
