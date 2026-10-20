import { randomUUID, createHash } from "node:crypto";
import { appendFile, chmod, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "../log.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DRAIN_TIMEOUT_MS = 5000;
const IGNORING_LINES = new Set(["*", "/*", "**", "workers", "workers/", "/workers", "/workers/", "workers/*", "workers/**", "/workers/*", "/workers/**"]);

interface Writer {
  file: string;
  queue: Promise<void>;
  bytes: number;
  lastId: string | null;
  /** Nothing more is appended: the size cap was reached or a write failed. */
  disabled: boolean;
  /** The file could not be created or written; queued writes are dropped. */
  failed: boolean;
}

/**
 * Writes each worker's conversation to disk as it happens, one pi session
 * line per message, so a host that follows files (Paseo) can show it live and
 * a finished worker can be read after the session ends. A failure to write
 * only turns the file off; the worker never notices.
 */
export class TranscriptStore {
  private readonly writers = new Map<string, Writer>();
  private root: string | null | undefined;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly warn: (message: string) => void,
    private readonly cacheRoot = join(homedir(), ".cache", "pi-pi", "workers"),
  ) {}

  /** The directory transcripts go to, decided on first use: under .pp when git ignores it there, else in the user's cache. */
  private directory(): string | null {
    if (this.root !== undefined) return this.root;
    const session = this.sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
    const local = join(this.cwd, ".pp", "workers", session);
    const fallback = join(this.cacheRoot, createHash("sha256").update(this.cwd).digest("hex").slice(0, 16), session);
    let chosen = local;
    if (/\s/.test(local)) chosen = fallback;
    else if (!ensureIgnored(join(this.cwd, ".pp"))) {
      chosen = fallback;
      this.warn("Worker transcripts are kept outside the project: .pp/.gitignore does not ignore .pp/workers.");
    }
    this.root = /\s/.test(chosen) ? null : chosen;
    return this.root;
  }

  /** Starts a worker's file, so its path is known before its first message. */
  open(id: string): void {
    this.writerFor(id);
  }

  /** Where this worker's transcript is, unless transcripts are off for it. */
  fileFor(id: string): string | undefined {
    const writer = this.writers.get(id);
    return writer && !writer.disabled ? writer.file : undefined;
  }

  append(id: string, message: any): void {
    if (!message || typeof message !== "object" || !message.role) return;
    const writer = this.writerFor(id);
    if (!writer || writer.disabled) return;
    const entryId = randomUUID().slice(0, 8);
    const line = `${JSON.stringify({ type: "message", id: entryId, parentId: writer.lastId, timestamp: new Date().toISOString(), message })}\n`;
    writer.lastId = entryId;
    writer.bytes += Buffer.byteLength(line);
    const overflow = writer.bytes > MAX_BYTES;
    const text = overflow ? `${JSON.stringify({ type: "custom", customType: "pi-pi-truncated", data: { reason: "size cap" } })}\n` : line;
    if (overflow) writer.disabled = true;
    writer.queue = writer.queue.then(async () => {
      // Creation failed, or an earlier write did: nothing after it may land in some other file.
      if (writer.failed) return;
      try {
        await appendFile(writer.file, text, { mode: 0o600 });
      } catch (error: any) {
        writer.failed = writer.disabled = true;
        getLogger().warn({ s: "workers", id, err: error?.message }, "writing a worker transcript failed; transcripts are off for it");
      }
    });
  }

  /** Stops writing a worker's file and forgets where it is: its writes did not finish in time. */
  abandon(id: string): void {
    const writer = this.writers.get(id);
    if (writer) writer.disabled = true;
  }

  /** Resolves once everything written so far is on disk, or after a bounded wait. */
  async drain(id: string): Promise<boolean> {
    const writer = this.writers.get(id);
    if (!writer) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS); timer.unref?.(); });
    const done = await Promise.race([writer.queue.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return done;
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.writers.keys()].map((id) => this.drain(id)));
  }

  private writerFor(id: string): Writer | undefined {
    const existing = this.writers.get(id);
    if (existing) return existing;
    const dir = this.directory();
    if (!dir) return undefined;
    // A reopened session restarts worker ids, so a file from an earlier
    // incarnation of the same id gets a fresh name instead of being appended to.
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    let file = join(dir, `${safe}.jsonl`);
    for (let n = 2; existsSync(file); n++) file = join(dir, `${safe}-${n}.jsonl`);
    const header = `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: this.cwd })}\n`;
    const writer: Writer = { file, queue: Promise.resolve(), bytes: Buffer.byteLength(header), lastId: null, disabled: false, failed: false };
    writer.queue = mkdir(dir, { recursive: true, mode: 0o700 })
      .then(async () => {
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(header); } finally { await handle.close(); }
        await chmod(file, 0o600);
      })
      .catch((error: any) => {
        writer.failed = writer.disabled = true;
        getLogger().warn({ s: "workers", id, err: error?.message }, "creating a worker transcript failed; transcripts are off for it");
      });
    this.writers.set(id, writer);
    return writer;
  }
}

/**
 * Makes sure git ignores .pp/workers. A missing .pp/.gitignore is created
 * ignoring everything; an existing one is never edited, only read.
 */
function ensureIgnored(ppDir: string): boolean {
  const file = join(ppDir, ".gitignore");
  try {
    if (!existsSync(file)) {
      if (!existsSync(ppDir)) return false;
      writeFileSync(file, "*\n", { flag: "wx" });
      return true;
    }
    // The last rule that matches wins, so a later "!workers" undoes an earlier
    // "*"; anything that could unignore the folder counts against it.
    let ignored = false;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("!")) {
        if (/^!\/?workers(\/|$)|^!\*/.test(line)) ignored = false;
        continue;
      }
      if (IGNORING_LINES.has(line)) ignored = true;
    }
    return ignored;
  } catch {
    return false;
  }
}

/** Deletes transcripts nobody has written to for a week; a live session's files are always newer than that. */
export async function pruneTranscripts(roots: string[], now = Date.now()): Promise<void> {
  for (const root of roots) {
    let sessions: string[];
    try {
      sessions = await readdir(root);
    } catch {
      continue;
    }
    for (const name of sessions) {
      const dir = join(root, name);
      try {
        const files = await readdir(dir);
        let newest = (await stat(dir)).mtimeMs;
        for (const file of files) newest = Math.max(newest, (await stat(join(dir, file))).mtimeMs);
        if (now - newest > MAX_AGE_MS) await rm(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function transcriptRoots(cwd: string, cacheRoot = join(homedir(), ".cache", "pi-pi", "workers")): string[] {
  return [join(cwd, ".pp", "workers"), join(cacheRoot, createHash("sha256").update(cwd).digest("hex").slice(0, 16))];
}
