// pi-pi's bb plugin frontend: the task card above the composer, the worker
// chip in its action row, and the worker list the chip opens.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  formatTokens,
  isActive,
  orderWorkers,
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

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const POLL_MS = 1000;

// --- one poll per thread, shared by every surface showing it -----------------

interface Feed {
  view: View | null;
  listeners: Set<() => void>;
  polling: boolean;
  heartbeat: number | null;
  heartbeatSeenAt: number;
}

interface View {
  state: BbState;
  stale: Staleness;
  workers: BbWorker[];
}

const feeds = new Map<string, Feed>();

function feedFor(threadId: string): Feed {
  let feed = feeds.get(threadId);
  if (!feed) {
    feed = { view: null, listeners: new Set(), polling: false, heartbeat: null, heartbeatSeenAt: 0 };
    feeds.set(threadId, feed);
  }
  return feed;
}

function startPolling(rpc: Rpc, threadId: string, feed: Feed): void {
  feed.polling = true;
  const tick = async () => {
    try {
      const { state } = await rpc.call("state_get", { threadId });
      const now = Date.now();
      if (state && state.heartbeatAt !== feed.heartbeat) {
        feed.heartbeat = state.heartbeatAt;
        feed.heartbeatSeenAt = now;
      }
      const stale = state ? staleness(state, now - feed.heartbeatSeenAt) : null;
      feed.view = state ? { state, stale, workers: shownWorkers(state, stale) } : null;
      for (const listener of feed.listeners) listener();
    } catch {
      // Keep the last snapshot: a reload of the plugin or a dropped connection should not blank the UI.
    }
    if (feed.listeners.size) setTimeout(tick, POLL_MS);
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

// --- the worker list's open/closed state, shared by the chip and the banner ---

let openThread: string | null = null;
const openListeners = new Set<() => void>();

function setOpenThread(next: string | null): void {
  openThread = next;
  for (const listener of openListeners) listener();
}

function useOpenThread(): string | null {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => openThread,
    () => openThread,
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
  const state = usePiPiState(threadId)?.state;
  const [expanded, setExpanded] = useState(true);
  const summary = state ? taskSummary(state.tasks) : null;
  if (!state || !summary) return null;
  const headline = `${summary.done}/${summary.total} complete${summary.current ? ` · ${summary.current}` : ""}`;
  return (
    <div className="min-h-8 overflow-hidden">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs text-foreground hover:bg-background/80"
      >
        <Icon name="ListTodo" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{headline}</span>
        <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2 pt-1">
          {state.tasks.map((task) => {
            const icon = TASK_ICON[task.status] ?? TASK_ICON.pending!;
            const active = task.status === "in_progress";
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

// --- worker chip ---------------------------------------------------------------

function WorkerChip() {
  const threadId = useThreadId();
  const workers = usePiPiState(threadId)?.workers;
  const open = useOpenThread();
  if (!threadId || !workers || workers.length === 0) return null;
  const running = workers.filter(isActive).length;
  const asking = workers.some((worker) => worker.question);
  const isOpen = open === threadId;
  const label = running ? `${running}/${workers.length}` : String(workers.length);
  return (
    <button
      type="button"
      onClick={() => setOpenThread(isOpen ? null : threadId)}
      aria-expanded={isOpen}
      aria-label="pi-pi workers"
      title={`${running} of ${workers.length} workers running${asking ? ", one is asking you something" : ""} — click for detail`}
      className={cn(
        "inline-flex h-[22px] cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] tabular-nums",
        asking ? "border-amber-500/60 bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : running ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border text-muted-foreground",
        isOpen && "bg-state-active",
      )}
    >
      <Icon name={asking ? "CircleHelp" : "Bot"} className="size-3.5" />
      {label}
    </button>
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

function WorkerPanel() {
  const threadId = useThreadId();
  const open = useOpenThread();
  const view = usePiPiState(open !== null && open === threadId ? threadId : null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = useNow(open !== null && open === threadId);

  if (!threadId || open !== threadId || !view) return null;
  const { state, stale } = view;
  const workers = orderWorkers(view.workers);
  return (
    <div
      className="max-h-80 overflow-y-auto text-xs"
      onKeyDown={(event) => {
        // Escape in a half-written message keeps it; anywhere else in the list it closes the list.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (event.target instanceof HTMLInputElement && event.target.value) return;
        setOpenThread(null);
      }}
    >
      <div className="sticky top-0 flex items-center gap-2 bg-popover px-3 py-1.5 text-muted-foreground">
        <span className="font-medium text-foreground">Workers</span>
        <span>{workers.filter(isActive).length} running · {workers.length} total</span>
        {stale ? <span className="text-destructive">{stale === "ended" ? "pi's session has ended" : "pi is not responding"}</span> : null}
        <span className="flex-1" />
        <button type="button" className="cursor-pointer hover:text-foreground" aria-label="Close" onClick={() => setOpenThread(null)}>
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      {workers.length === 0 ? <div className="px-3 pb-2 text-muted-foreground">No workers in this session.</div> : null}
      <ul>
        {workers.map((worker) => (
          <WorkerRow
            key={worker.id}
            threadId={threadId}
            worker={worker}
            state={state}
            now={now}
            readOnly={stale !== null}
            expanded={expanded === worker.id}
            onToggle={() => setExpanded((current) => (current === worker.id ? null : worker.id))}
          />
        ))}
      </ul>
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
  app.composer.customize({
    id: "pi-pi",
    scopes: ["thread"],
    banners: [
      { id: "pi-pi-tasks", chrome: "card", component: TaskCard },
      { id: "pi-pi-workers", chrome: "card", component: WorkerPanel },
    ],
    actions: [{ id: "pi-pi-workers", component: WorkerChip }],
  });
});
