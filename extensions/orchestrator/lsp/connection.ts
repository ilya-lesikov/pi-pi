import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type RequestHandler = (method: string, params: any) => unknown;
type NotificationHandler = (method: string, params: any) => void;

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResponseError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const METHOD_NOT_FOUND = -32601;
const REQUEST_CANCELLED = -32800;
const STDERR_LINES = 20;

const children = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

// A language server outlives a host that exits without shutting it down: it is
// not in the host's process group on every platform, and nothing else reaps it.
function trackChild(child: ChildProcessWithoutNullStreams): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const proc of children) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  });
}

export interface ConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onRequest: RequestHandler;
  onNotification: NotificationHandler;
  onExit: (code: number | null, signal: string | null) => void;
}

/** JSON-RPC 2.0 over a child process's stdio, framed with Content-Length headers. */
export class Connection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private stderrTail: string[] = [];
  private partialStderr = "";
  private closed = false;
  exitCode: number | null = null;

  constructor(private readonly options: ConnectionOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // npm installs servers on Windows as .cmd shims, which only a shell runs.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(options.command),
      windowsHide: true,
    });
    trackChild(this.child);
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk.toString("utf8")));
    // A write to a server that just died raises EPIPE here; unhandled, it would take the host down.
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.close(`failed to start: ${error.message}`, null, null));
    // "close", not "exit": stderr can still be draining when the process exits, and it carries the reason.
    this.child.on("close", (code, signal) => this.close(`exited${code !== null ? ` with code ${code}` : ""}${signal ? ` on ${signal}` : ""}`, code, signal));
  }

  get alive(): boolean {
    return !this.closed;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  stderr(): string[] {
    return this.partialStderr ? [...this.stderrTail, this.partialStderr].slice(-STDERR_LINES) : [...this.stderrTail];
  }

  request<T = any>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`language server is not running (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.notify("$/cancelRequest", { id });
        reject(error);
      };
      const onAbort = () => cancel(new Error(`${method} was cancelled`));
      const timer = setTimeout(() => cancel(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const direct = () => { try { this.child.kill(signal); } catch {} };
    // A .cmd server runs under a shell, and killing the shell leaves the server.
    if (process.platform === "win32" && this.child.pid) {
      try {
        const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", direct);
        killer.on("exit", (code) => { if (code !== 0) direct(); });
        return;
      } catch {}
    }
    direct();
  }

  /** Resolves once the process has exited, or after `timeoutMs`. */
  waitForExit(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private write(message: object): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    try {
      this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.child.stdin.write(body);
    } catch {}
  }

  private onStderr(text: string): void {
    const lines = (this.partialStderr + text).split(/\r?\n/);
    this.partialStderr = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_LINES);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number(match[1]);
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(start, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      let message: any;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (typeof message?.method === "string") {
      if (message.id === undefined || message.id === null) {
        try { this.options.onNotification(message.method, message.params); } catch {}
        return;
      }
      void this.answer(message.id, message.method, message.params);
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = message.error;
      // Servers put whole stack traces in the message; the first lines say what went wrong.
      const text = String(error.message ?? "unknown error").split("\n").slice(0, 3).join("\n").slice(0, 500);
      pending.reject(new ResponseError(error.code, error.code === REQUEST_CANCELLED ? `${pending.method} was cancelled by the server` : `${pending.method} failed: ${text}`));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error: any) {
      const code = error instanceof ResponseError ? error.code : METHOD_NOT_FOUND;
      this.write({ jsonrpc: "2.0", id, error: { code, message: error?.message ?? String(error) } });
    }
  }

  private close(reason: string, code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(`language server ${reason} during ${pending.method}`));
    }
    this.options.onExit(code, signal);
  }
}

export function methodNotFound(method: string): ResponseError {
  return new ResponseError(METHOD_NOT_FOUND, `Unhandled method ${method}`);
}
