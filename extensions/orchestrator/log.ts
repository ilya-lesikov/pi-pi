import pino from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value);
}

interface Multistream extends pino.DestinationStream {
  add(dest: { stream: pino.DestinationStream; level: string }): void;
  remove(stream: pino.DestinationStream): void;
  flushSync(): void;
}

let sessionStream: pino.DestinationStream | null = null;
let taskStream: pino.DestinationStream | null = null;
let ms: Multistream | null = null;
let logger: pino.Logger = pino({ level: "silent" });

export function initSessionLogger(ppDir: string, level: LogLevel = "info"): void {
  const logsDir = join(ppDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  cleanOldSessionLogs(logsDir, 7);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(logsDir, `session-${ts}.jsonl`);
  sessionStream = pino.destination({ dest: logFile, sync: false });
  ms = pino.multistream([{ stream: sessionStream, level }]) as unknown as Multistream;
  logger = pino({ level }, ms as unknown as pino.DestinationStream);
}

export function addTaskDestination(taskDir: string): void {
  if (!ms) return;
  mkdirSync(taskDir, { recursive: true });
  const logFile = join(taskDir, "debug.jsonl");
  taskStream = pino.destination({ dest: logFile, sync: false });
  ms.add({ stream: taskStream, level: logger.level });
}

export function removeTaskDestination(): void {
  if (!ms || !taskStream) return;
  ms.remove(taskStream);
  try { (taskStream as any).flushSync?.(); } catch {}
  taskStream = null;
}

export function setLogLevel(level: LogLevel): void {
  if (!isValidLogLevel(level)) return;
  logger.level = level;
  if (ms && sessionStream) {
    ms.remove(sessionStream);
    ms.add({ stream: sessionStream, level });
  }
  if (ms && taskStream) {
    ms.remove(taskStream);
    ms.add({ stream: taskStream, level });
  }
}

export function flushLogs(): void {
  if (ms) {
    try { ms.flushSync(); } catch {}
  }
}

function cleanOldSessionLogs(logsDir: string, maxAgeDays: number): void {
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
}

export function getLogger(): pino.Logger {
  return logger;
}
