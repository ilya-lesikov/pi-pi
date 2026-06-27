import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

const TRACER_KEY = Symbol.for("pi-pi:tracer");

export interface SubagentMeta {
  subagentId: string;
  type?: string;
  description?: string;
  parentToolCallId?: string;
  parentSubagentId?: string;
  depth: number;
  systemPrompt?: string;
  effectivePrompt?: string;
}

interface Tracer {
  sessionId: string;
  dir: string;
  turnIndex: number;
  traceMain(kind: string, payload: Record<string, unknown>): void;
  openSubagent(meta: SubagentMeta): void;
  traceSubagent(subagentId: string, kind: string, payload: Record<string, unknown>): void;
  finalize(): void;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_") || `session-${Date.now()}`;
}

function appendLine(file: string, obj: Record<string, unknown>): void {
  try {
    appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch {}
}

function cleanOldTraceDirs(tracesRoot: string, maxAgeDays: number): void {
  try {
    if (!existsSync(tracesRoot)) return;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(tracesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(tracesRoot, entry.name);
      try {
        if (statSync(dirPath).mtimeMs < cutoff) {
          rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

export function initTracer(ppDir: string, sessionId: string): void {
  try {
    const tracesRoot = join(ppDir, "logs", "traces");
    mkdirSync(tracesRoot, { recursive: true });
    cleanOldTraceDirs(tracesRoot, 7);

    const safeId = sanitizeSessionId(sessionId);
    const dir = join(tracesRoot, safeId);
    mkdirSync(dir, { recursive: true });

    const mainFile = join(dir, "main.jsonl");

    const tracer: Tracer = {
      sessionId,
      dir,
      turnIndex: -1,
      traceMain(kind, payload) {
        appendLine(mainFile, { ts: Date.now(), scope: "main", sessionId, kind, ...payload });
      },
      openSubagent(meta) {
        const subFile = join(dir, `${sanitizeSessionId(meta.subagentId)}.jsonl`);
        appendLine(subFile, {
          ts: Date.now(),
          scope: "subagent",
          sessionId,
          subagentId: meta.subagentId,
          parentSubagentId: meta.parentSubagentId,
          parentToolCallId: meta.parentToolCallId,
          depth: meta.depth,
          kind: "subagent_open",
          type: meta.type,
          description: meta.description,
          systemPrompt: meta.systemPrompt,
          effectivePrompt: meta.effectivePrompt,
        });
        appendLine(mainFile, {
          ts: Date.now(),
          scope: "main",
          sessionId,
          kind: "subagent_spawned",
          subagentId: meta.subagentId,
          parentSubagentId: meta.parentSubagentId,
          parentToolCallId: meta.parentToolCallId,
          depth: meta.depth,
          type: meta.type,
          description: meta.description,
        });
      },
      traceSubagent(subagentId, kind, payload) {
        const subFile = join(dir, `${sanitizeSessionId(subagentId)}.jsonl`);
        appendLine(subFile, { ts: Date.now(), scope: "subagent", sessionId, subagentId, kind, ...payload });
      },
      finalize() {
        appendLine(mainFile, { ts: Date.now(), scope: "main", sessionId, kind: "session_finalized" });
      },
    };

    (globalThis as any)[TRACER_KEY] = tracer;
  } catch {
    (globalThis as any)[TRACER_KEY] = undefined;
  }
}

export function getTracer(): Tracer | undefined {
  return (globalThis as any)[TRACER_KEY];
}

export function finalizeTracer(): void {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    tracer.finalize();
  } catch {}
  (globalThis as any)[TRACER_KEY] = undefined;
}
