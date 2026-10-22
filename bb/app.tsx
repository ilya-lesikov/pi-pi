// pi-pi's bb plugin frontend: above the composer, a status line, the task
// card and the worker card.
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  formatDuration,
  formatTokens,
  isActive,
  orderWorkers,
  piNow,
  shownWorkers,
  staleness,
  taskSummary,
  workerActivity,
  workerElapsed,
  workerState,
  type BbState,
  type BbWorker,
  type Staleness,
  type WorkerState,
} from "./state";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RENDERER_ID } from "./forms";
import { PiPiForm } from "./form";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const POLL_MS = 1000;
// A thread with no state to read (not pi-pi's, or its machine unreachable) is asked less and less often, up to this.
const MAX_POLL_MS = 10_000;

// --- one poll per thread, shared by every surface showing it -----------------

interface Feed {
  view: View | null;
  listeners: Set<() => void>;
  polling: boolean;
  /** Polls in a row that read no state. */
  misses: number;
  heartbeat: number | null;
  heartbeatSeenAt: number;
}

interface View {
  state: BbState;
  stale: Staleness;
  workers: BbWorker[];
  /** When this reader last saw `heartbeatAt` change, on its own clock. */
  heartbeatSeenAt: number;
}

const feeds = new Map<string, Feed>();

function feedFor(threadId: string): Feed {
  let feed = feeds.get(threadId);
  if (!feed) {
    feed = { view: null, listeners: new Set(), polling: false, misses: 0, heartbeat: null, heartbeatSeenAt: 0 };
    feeds.set(threadId, feed);
  }
  return feed;
}

function startPolling(rpc: Rpc, threadId: string, feed: Feed): void {
  feed.polling = true;
  const tick = async () => {
    try {
      const { state: read, failed } = await rpc.call("state_get", { threadId });
      feed.misses = read ? 0 : feed.misses + 1;
      // A failed read keeps the last state, aging toward "not responding" as a silent pi would.
      const state = failed ? feed.view?.state ?? null : read;
      const now = Date.now();
      if (state && state.heartbeatAt !== feed.heartbeat) {
        feed.heartbeat = state.heartbeatAt;
        feed.heartbeatSeenAt = now;
      }
      const stale = state ? staleness(state, now - feed.heartbeatSeenAt) : null;
      feed.view = state ? { state, stale, workers: shownWorkers(state, stale), heartbeatSeenAt: feed.heartbeatSeenAt } : null;
      for (const listener of feed.listeners) listener();
    } catch {
      feed.misses++;
      // Keep the last snapshot: a reload of the plugin or a dropped connection should not blank the UI.
      // It still ages toward "not responding", as a failed read does.
      const view = feed.view;
      if (view) {
        const stale = staleness(view.state, Date.now() - feed.heartbeatSeenAt);
        if (stale !== view.stale) {
          feed.view = { ...view, stale, workers: shownWorkers(view.state, stale) };
          for (const listener of feed.listeners) listener();
        }
      }
    }
    // A state still taken as live keeps the full rate, so a pi that stops answering is shown as such on time.
    const live = feed.view !== null && feed.view.stale === null;
    if (feed.listeners.size) setTimeout(tick, live ? POLL_MS : Math.min(POLL_MS * 2 ** feed.misses, MAX_POLL_MS));
    else feed.polling = false;
  };
  void tick();
}

function usePiPiState(threadId: string | null): View | null {
  const rpc = useRpc<typeof rpcContract>();
  const subscribe = useCallback((listener: () => void) => {
    if (!threadId) return () => {};
    const feed = feedFor(threadId);
    feed.listeners.add(listener);
    if (!feed.polling) startPolling(rpc, threadId, feed);
    return () => {
      feed.listeners.delete(listener);
    };
  }, [rpc, threadId]);
  const snapshot = useCallback(() => (threadId ? feedFor(threadId).view : null), [threadId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function useThreadId(): string | null {
  const scope = useComposer().scope;
  return scope.kind === "thread" ? scope.threadId : null;
}

/** Re-renders every second so elapsed times move between polls that change nothing. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

// --- status line -------------------------------------------------------------

const STATUS_ICON: Record<NonNullable<BbState["status"]>["level"], { name: string; className: string } | null> = {
  normal: { name: "LoaderCircle", className: "animate-spin text-foreground" },
  attention: { name: "CircleHelp", className: "text-amber-500" },
  alarm: { name: "TriangleAlert", className: "text-destructive" },
  idle: null,
};

// How long a notice from pi-pi's menu, or the answer to opening it, stays on the line.
const NOTICE_MS = 8000;

function StatusLine() {
  const threadId = useThreadId();
  const view = usePiPiState(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const [opening, setOpening] = useState<{ id: string; sentAt: number } | { error: string; sentAt: number } | null>(null);
  const now = useNow(!!view);
  if (!threadId || !view) return null;
  const { state, stale } = view;
  // Older pi-pi writes no status; the line waits for one that does.
  if (!state.status) return null;
  const status = state.status;
  const age = (at: number) => piNow(state, view.heartbeatSeenAt, now) - at;
  const notice = (state.notices ?? []).filter((entry) => age(entry.at) < NOTICE_MS).at(-1);
  // Only a refusal is worth showing; an opened menu shows itself.
  const refusal = !opening || now - opening.sentAt >= NOTICE_MS ? undefined
    : "error" in opening ? opening.error
      : state.commandResults.find((result) => result.id === opening.id && !result.ok)?.message;
  const icon = stale ? null : STATUS_ICON[status.level];
  const elapsed = status.level === "idle" ? "" : formatDuration(age(status.since));
  // bb stops pi on Stop and a while after a run ends, and starts it again with the next message: not an error.
  const text = stale ? (stale === "ended" ? "pi isn't running; it starts with your next message" : "pi is not responding") : [status.text, elapsed, status.suffix].filter(Boolean).join(" • ");
  const openMenu = async () => {
    const sentAt = Date.now();
    // Nobody would read the request: pi-pi's menu lives in pi.
    if (stale) {
      setOpening({ error: stale === "ended" ? "pi-pi's menu needs pi running: send a message, then open it." : "pi is not responding; try again in a moment.", sentAt });
      return;
    }
    try {
      const { id } = await rpc.call("menu_open", { threadId });
      setOpening({ id, sentAt });
    } catch (cause) {
      setOpening({ error: cause instanceof Error ? cause.message : String(cause), sentAt });
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-xs">
      {icon ? <Icon name={icon.name} className={cn("size-3.5 shrink-0", icon.className)} /> : null}
      <span className={cn("min-w-0 flex-1 truncate", stale === "unresponsive" || (!stale && status.level === "alarm") ? "text-destructive" : stale || status.level === "idle" ? "text-muted-foreground" : "text-foreground")}>{text}</span>
      {refusal ? <span className="min-w-0 truncate text-destructive" title={refusal}>{refusal}</span> : null}
      {notice ? (
        <span className={cn("min-w-0 truncate", notice.level === "error" ? "text-destructive" : notice.level === "warning" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} title={notice.text}>
          {notice.text}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void openMenu()}
        title={`pi-pi${state.piPiVersion ? ` ${state.piPiVersion}` : ""} menu: status, workers, models, usage, settings`}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium text-foreground hover:bg-state-hover"
      >
        <Icon name="SlidersHorizontal" fallback="Settings" className="size-3.5" />
        pi-pi menu
      </button>
    </div>
  );
}

// --- card header, shared by the task and worker cards ---------------------------

function CardHeader({ title, summary, expanded, onToggle, children }: { title: string; summary: string; expanded: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover"
    >
      <span className="shrink-0 font-medium text-foreground">{title}</span>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {children}
      <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")} />
    </button>
  );
}

// --- task card ---------------------------------------------------------------

const TASK_ICON: Record<string, { name: string; className: string }> = {
  completed: { name: "Check", className: "text-muted-foreground" },
  in_progress: { name: "LoaderCircle", className: "animate-spin text-foreground" },
  pending: { name: "Square", className: "text-muted-foreground" },
};

function TaskCard() {
  const threadId = useThreadId();
  const view = usePiPiState(threadId);
  const state = view?.state;
  const [expanded, setExpanded] = useState(true);
  const summary = state ? taskSummary(state.tasks) : null;
  if (!view || !state || !summary) return null;
  // The list as pi left it: nothing on it is being worked on while pi is not running.
  const stale = view.stale !== null;
  const headline = `${summary.done}/${summary.total} complete${summary.current && !stale ? ` · ${summary.current}` : ""}`;
  return (
    <div className="min-h-8 overflow-hidden">
      <CardHeader title="Tasks" summary={headline} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
      {expanded ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2 pt-1">
          {state.tasks.map((task) => {
            const active = task.status === "in_progress" && !stale;
            const icon = (task.status === "in_progress" && stale ? TASK_ICON.pending : TASK_ICON[task.status]) ?? TASK_ICON.pending!;
            return (
              <li key={task.id} className={cn("flex min-w-0 items-start gap-2 text-xs", active ? "text-foreground" : "text-muted-foreground", task.status === "completed" && "line-through")}>
                <Icon name={icon.name} className={cn("mt-0.5 size-3.5 shrink-0", icon.className)} />
                <span className="min-w-0 flex-1 truncate" title={task.subject}>
                  #{task.id} {task.subject}
                  {active && task.activeForm ? <span className="text-muted-foreground"> — {task.activeForm}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// --- worker list -----------------------------------------------------------------

const STATE_ICON: Record<WorkerState, { name: string; className: string }> = {
  asking: { name: "CircleHelp", className: "text-amber-500" },
  silent: { name: "TriangleAlert", className: "text-destructive" },
  failed: { name: "CircleX", className: "text-destructive" },
  running: { name: "LoaderCircle", className: "animate-spin text-emerald-500" },
  pending: { name: "Circle", className: "text-muted-foreground" },
  stopped: { name: "Square", className: "text-muted-foreground" },
  done: { name: "Check", className: "text-emerald-500" },
};

function WorkerCard() {
  const threadId = useThreadId();
  const view = usePiPiState(threadId);
  const [selected, setSelected] = useState<string | null>(null);
  // Unset until the user folds or unfolds it: open while any worker is at work.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const workers = view ? orderWorkers(view.workers) : [];
  const running = workers.filter(isActive).length;
  const expanded = chosen ?? running > 0;
  const tick = useNow(expanded && running > 0);

  if (!threadId || !view || workers.length === 0) return null;
  const { state, stale } = view;
  const now = piNow(state, view.heartbeatSeenAt, tick);
  const asking = workers.filter((worker) => worker.question).length;
  const summary = [`${running} running`, `${workers.length} total`, ...(asking ? [`${asking} asking`] : [])].join(" · ");
  return (
    <div className="min-h-8 overflow-hidden">
      <CardHeader title="Workers" summary={summary} expanded={expanded} onToggle={() => setChosen(!expanded)}>
        {stale ? <span className={cn("shrink-0", stale === "ended" ? "text-muted-foreground" : "text-destructive")}>{stale === "ended" ? "pi isn't running" : "pi is not responding"}</span> : null}
      </CardHeader>
      {expanded ? (
        <ul className="max-h-80 overflow-y-auto text-xs">
          {workers.map((worker) => (
            <WorkerRow
              key={worker.id}
              threadId={threadId}
              worker={worker}
              state={state}
              now={now}
              readOnly={stale !== null}
              expanded={selected === worker.id}
              onToggle={() => setSelected((current) => (current === worker.id ? null : worker.id))}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WorkerRow({ threadId, worker, state, now, readOnly, expanded, onToggle }: {
  threadId: string;
  worker: BbWorker;
  state: BbState;
  now: number;
  readOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const kind = workerState(worker);
  const icon = STATE_ICON[kind];
  const stats = [workerElapsed(worker, now), ...(worker.tokens ? [formatTokens(worker.tokens)] : []), `${worker.toolUses} tools`].join(" · ");
  return (
    <li className="border-t border-border/60">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-3 py-1.5 text-left hover:bg-state-hover">
        <Icon name={icon.name} className={cn("mt-0.5 size-3.5 shrink-0", icon.className)} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 gap-2">
            <span className="truncate text-foreground">
              <span className="font-medium">{worker.type}</span>: {worker.description}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{stats}</span>
          </span>
          <span className={cn("block truncate", kind === "asking" ? "text-amber-600 dark:text-amber-400" : kind === "failed" || kind === "silent" ? "text-destructive" : "text-muted-foreground")}>
            {workerActivity(worker, now)}
          </span>
        </span>
      </button>
      {expanded ? <WorkerDetail threadId={threadId} worker={worker} state={state} readOnly={readOnly} /> : null}
    </li>
  );
}

function WorkerDetail({ threadId, worker, state, readOnly }: { threadId: string; worker: BbWorker; state: BbState; readOnly: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState("");
  const [armedKill, setArmedKill] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = isActive(worker);
  const outcome = sent ? state.commandResults.find((result) => result.id === sent) : undefined;

  const send = async (action: "stop" | "kill" | "message", message?: string) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await rpc.call("command_send", { threadId, workerId: worker.id, action, ...(message !== undefined ? { text: message } : {}) });
      setSent(id);
      if (action === "message") setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setArmedKill(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message && !busy) void send("message", message);
  };

  return (
    <div className="space-y-2 px-3 pb-3 pl-8">
      <Section title="Task" body={worker.prompt} />
      {worker.question ? <Section title="Asks you" body={worker.question} tone="text-amber-600 dark:text-amber-400" /> : null}
      {active && worker.outputTail.trim() ? <Section title="Latest output" body={worker.outputTail.trim()} /> : null}
      {worker.result ? <Section title={`Result (${worker.result.status})`} body={worker.result.body || worker.result.summary} /> : null}
      {worker.error ? <Section title="Error" body={worker.error} tone="text-destructive" /> : null}
      <div className="text-muted-foreground">{worker.id} · {worker.model}</div>
      {readOnly ? null : (
        <>
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={worker.question ? "Answer the question" : active ? "Steer it" : "Give it more work"}
              aria-label={`Message ${worker.type}`}
              className="h-8 text-xs"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !text.trim()}>
              <Icon name="Send" className="size-3.5" />
              {worker.question ? "Answer" : "Send"}
            </Button>
            {active ? (
              <>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void send("stop")} aria-label="Stop: ask it to wrap up; killed in a minute if it does not">
                  Stop
                </Button>
                <Button type="button" size="sm" variant={armedKill ? "destructive" : "outline"} disabled={busy} onClick={() => (armedKill ? void send("kill") : setArmedKill(true))} onBlur={() => setArmedKill(false)}>
                  {armedKill ? "Confirm kill" : "Kill"}
                </Button>
              </>
            ) : null}
          </form>
          {error ? <div className="text-destructive">{error}</div> : null}
          {sent && !error ? <div className={outcome && !outcome.ok ? "text-destructive" : "text-muted-foreground"}>{outcome ? outcome.message : "Sent; waiting for pi…"}</div> : null}
        </>
      )}
    </div>
  );
}

function Section({ title, body, tone }: { title: string; body: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <pre className={cn("max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans", tone ?? "text-foreground")}>{body}</pre>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: RENDERER_ID, component: PiPiForm });
  app.composer.customize({
    id: "pi-pi",
    scopes: ["thread"],
    banners: [
      { id: "pi-pi-status", chrome: "bare", component: StatusLine },
      { id: "pi-pi-tasks", chrome: "card", component: TaskCard },
      { id: "pi-pi-workers", chrome: "card", component: WorkerCard },
    ],
  });
});
