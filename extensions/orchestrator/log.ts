import pino from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value);
}

interface MsStream {
  id: number;
  stream: pino.DestinationStream;
  level: number;
}

interface Multistream extends pino.DestinationStream {
  add(dest: { stream: pino.DestinationStream; level: string }): void;
  remove(id: number): void;
  flushSync(): void;
  lastId: number;
  streams: MsStream[];
}

let sessionStreamId = -1;
let taskStreamId = -1;
let taskStreamRef: pino.DestinationStream | null = null;
let sessionStreamRef: pino.DestinationStream | null = null;
let ms: Multistream | null = null;
let logger: pino.Logger = pino({ level: "silent" });

function safeEndStream(stream: pino.DestinationStream | null): void {
  if (!stream) return;
  try { (stream as any).flushSync?.(); } catch {}
  try { (stream as any).end?.(); } catch {}
}

export function initSessionLogger(ppDir: string, level: LogLevel = "info"): void {
  try {
    if (ms && sessionStreamId >= 0) {
      ms.remove(sessionStreamId);
      safeEndStream(sessionStreamRef);
    }
    if (ms && taskStreamId >= 0) {
      ms.remove(taskStreamId);
      safeEndStream(taskStreamRef);
      taskStreamId = -1;
      taskStreamRef = null;
    }

    const logsDir = join(ppDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    cleanOldSessionLogs(logsDir, 7);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = join(logsDir, `session-${ts}.jsonl`);
    sessionStreamRef = pino.destination({ dest: logFile, sync: false });
    ms = pino.multistream([{ stream: sessionStreamRef, level }]) as unknown as Multistream;
    sessionStreamId = ms.lastId;
    logger = pino({ level }, ms as unknown as pino.DestinationStream);
  } catch {
    sessionStreamId = -1;
    sessionStreamRef = null;
    ms = null;
    logger = pino({ level: "silent" });
  }
}

export function addTaskDestination(taskDir: string): void {
  if (!ms) return;
  try {
    mkdirSync(taskDir, { recursive: true });
    const logFile = join(taskDir, "debug.jsonl");
    taskStreamRef = pino.destination({ dest: logFile, sync: false });
    ms.add({ stream: taskStreamRef, level: logger.level });
    taskStreamId = ms.lastId;
  } catch {
    taskStreamRef = null;
    taskStreamId = -1;
  }
}

export function removeTaskDestination(): void {
  if (!ms || taskStreamId < 0) return;
  ms.remove(taskStreamId);
  safeEndStream(taskStreamRef);
  taskStreamId = -1;
  taskStreamRef = null;
}

export function setLogLevel(level: LogLevel): void {
  if (!isValidLogLevel(level)) return;
  logger.level = level;
  if (ms && sessionStreamId >= 0 && sessionStreamRef) {
    ms.remove(sessionStreamId);
    ms.add({ stream: sessionStreamRef, level });
    sessionStreamId = ms.lastId;
  }
  if (ms && taskStreamId >= 0 && taskStreamRef) {
    ms.remove(taskStreamId);
    ms.add({ stream: taskStreamRef, level });
    taskStreamId = ms.lastId;
  }
}

export function flushLogs(): void {
  if (ms) {
    try { ms.flushSync(); } catch {}
  }
}

function cleanOldSessionLogs(logsDir: string, maxAgeDays: number): void {
  try {
    if (!existsSync(logsDir)) return;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(logsDir)) {
      if (!file.startsWith("session-") || !file.endsWith(".jsonl")) continue;
      const filePath = join(logsDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}

export function getLogger(): pino.Logger {
  return logger;
}
