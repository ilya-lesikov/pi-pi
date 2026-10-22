import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, DEFAULT_MAX_BYTES, formatSize, getAgentDir, parseArgs, SettingsManager, type BashToolDetails, type BashToolInput, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * pi's bash waits on a command forever unless the call sets a timeout, so a
 * server left in the foreground, a prompt waiting on stdin or a script that
 * never exits holds the turn until someone notices. This replaces the bash
 * tool with pi's own, built the same way, plus two limits for a call that sets
 * no timeout of its own: a default timeout, and a stop after a stretch with no
 * output. A call with an explicit timeout opts out of both.
 *
 * The guidance on commands that do not exit lives in the prompts' tool
 * routing (agents/tool-routing.ts): pi-pi writes both prompts itself, so a
 * tool's promptGuidelines never reach them.
 */
export interface BashGuardLimits {
  /** Seconds; 0 for none. */
  timeoutSec(): number;
  /** Milliseconds; 0 for none. */
  silenceMs(): number;
}

export interface BashGuardOptions {
  /** The session's settings, when the caller has them; otherwise read per call like pi does. */
  settings?: SettingsManager;
  agentDir?: string;
}

// pi throttles bash's output updates to 100ms; a shorter limit would stop a command that is printing.
const MIN_SILENCE_MS = 1000;
const SETTLE_GRACE_MS = 3000;

/**
 * Registered when the extension loads, not at session start: pi keeps the
 * first extension's tool of a name, and another extension that also replaces
 * bash once a session starts would otherwise win.
 */
export function registerBashGuard(pi: ExtensionAPI, cwd: string, limits: BashGuardLimits, options: BashGuardOptions = {}): void {
  const template = createBashToolDefinition(cwd);
  // pi builds its bash from the user's shell and command prefix, reading a
  // project's settings only when the project is trusted; ours must do the same,
  // for the directory and trust of the session the call runs in. Read once per
  // session, as pi does: reading takes a lock on the settings files.
  let cached: { key: string; base: ReturnType<typeof createBashToolDefinition> } | undefined;
  const baseFor = (ctx: any) => {
    const where = ctx?.cwd || cwd;
    // Unknown trust is no trust, as in pi.
    const trusted = ctx?.isProjectTrusted?.() ?? false;
    const key = `${where}\0${trusted}`;
    if (cached?.key !== key) {
      const settings = options.settings ?? SettingsManager.create(where, options.agentDir ?? getAgentDir(), { projectTrusted: trusted });
      cached = { key, base: createBashToolDefinition(where, { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() }) };
    }
    return cached.base;
  };
  // A new session may have changed the settings: read them again on its first call.
  pi.on("session_start", async () => {
    cached = undefined;
  });
  pi.registerTool({
    ...template,
    async execute(toolCallId: string, params: BashToolInput, signal: AbortSignal | undefined, onUpdate: Parameters<typeof template.execute>[3], ctx: Parameters<typeof template.execute>[4]) {
      const base = baseFor(ctx);
      // Any timeout the agent set is its own, an invalid one included: pi rejects that itself.
      const explicit = params.timeout !== undefined && params.timeout !== null;
      if (explicit) return base.execute(toolCallId, params, signal, onUpdate, ctx);
      const timeoutSec = limits.timeoutSec();
      const configured = limits.silenceMs();
      const silenceMs = configured > 0 ? Math.max(configured, MIN_SILENCE_MS) : 0;
      if (timeoutSec <= 0 && silenceMs <= 0) return base.execute(toolCallId, params, signal, onUpdate, ctx);
      const guarded = timeoutSec > 0 ? { ...params, timeout: timeoutSec } : params;

      const stop = new AbortController();
      const onAbort = () => stop.abort();
      if (signal?.aborted) stop.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      let silent = false;
      let settled = false;
      let output = "";
      let details: BashToolDetails | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let giveUp!: (error: Error) => void;
      // pi kills only the command's process group and then waits for its output
      // to end: a process that moved to a session of its own and keeps printing
      // holds that wait open, so a stopped command returns after a grace anyway.
      // pi goes on writing that process's output to its full-output file until
      // it exits; nothing outside pi can stop that.
      const giveUpAfterGrace = (status: string) => {
        grace ??= setTimeout(() => {
          const text = output + truncationNotice(details);
          giveUp(new Error(`${text ? `${text}\n\n` : ""}${status}`));
        }, SETTLE_GRACE_MS);
      };
      const onStop = () => giveUpAfterGrace("Command aborted");
      if (stop.signal.aborted) onStop();
      else stop.signal.addEventListener("abort", onStop, { once: true });
      if (timeoutSec > 0) deadline = setTimeout(() => giveUpAfterGrace(`Command timed out after ${timeoutSec} seconds`), timeoutSec * 1000);
      const arm = () => {
        if (silenceMs <= 0) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          silent = true;
          stop.abort();
        }, silenceMs);
        timer.unref?.();
      };
      arm();
      try {
        return await new Promise((resolve, reject) => {
          giveUp = reject;
          base.execute(toolCallId, guarded, stop.signal, (update: any) => {
            if (settled) return;
            // Each update carries output; the first, empty one only says it started.
            if (update.content.length) {
              output = update.content.map((part: any) => part.text ?? "").join("");
              details = update.details;
              arm();
            }
            onUpdate?.(update);
          }, ctx).then(resolve, reject);
        });
      } catch (error) {
        // Only the abort the silence caused: a timeout or another failure keeps pi's own wording.
        if (!silent || signal?.aborted || !(error instanceof Error) || !/(^|\n)Command aborted$/.test(error.message)) throw error;
        const text = error.message.replace(/\n*Command aborted$/, "");
        throw new Error(
          `${text ? `${text}\n\n` : ""}Command stopped: it printed nothing for ${seconds(silenceMs)}, and its process group was killed; ` +
            "anything it started in a session of its own may still be running. " +
            "Check for partial results it may have left before rerunning. If it should run that long, rerun it with an explicit `timeout`; " +
            "if it is a server or watcher, start it in a bash call of its own, in the background with its output in a file.",
        );
      } finally {
        settled = true;
        if (timer) clearTimeout(timer);
        if (deadline) clearTimeout(deadline);
        if (grace) clearTimeout(grace);
        signal?.removeEventListener("abort", onAbort);
        stop.signal.removeEventListener("abort", onStop);
      }
    },
  } as ToolDefinition<any, any, any>);
}

/**
 * pi turns on every extension tool whenever it builds a session, so the
 * replacement would turn bash on where pi would leave its own off. A new
 * session follows pi's start-up rules: off for `--no-builtin-tools` or
 * `--no-tools`, or default tools without it, unless `--tools` names it, which
 * wins over both. A reload keeps whatever the session had, as pi does for its
 * own tools.
 */
export function keepBashOffWhereItWas(pi: ExtensionAPI, argv: string[], defaultTools: string[] | undefined, beforeReload?: boolean): void {
  let on: boolean;
  if (beforeReload !== undefined) on = beforeReload;
  else {
    const args = parseArgs(argv);
    const initial = args.tools ?? (args.noTools || args.noBuiltinTools ? [] : (defaultTools ?? ["read", "bash", "edit", "write"]));
    on = initial.includes("bash") && !args.excludeTools?.includes("bash");
  }
  if (on) return;
  const active = pi.getActiveTools();
  if (active.includes("bash")) pi.setActiveTools(active.filter((name) => name !== "bash"));
}

/**
 * pi keeps the first extension's tool of a name, so another extension loaded
 * before pi-pi that also replaces bash leaves these limits off. Returns where
 * that bash comes from, or null when pi-pi's own is in place.
 */
export function bashOwnedElsewhere(pi: ExtensionAPI): string | null {
  const info = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo;
  if (!info || info.source === "builtin" || !info.path) return null;
  return isInside(info.path, PACKAGE_ROOT) ? null : info.path;
}

// pi-pi's package directory: a bash registered from inside it is this one.
const PACKAGE_ROOT = real(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

function isInside(path: string, root: string): boolean {
  // pi keeps the path it was given, a symlink included; the module's own is the target.
  const target = real(resolve(path));
  return target === root || target.startsWith(root + sep);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// pi's own notice for truncated output, as far as an update's details tell it:
// they lack the size of a partly shown last line.
function truncationNotice(details: BashToolDetails | undefined): string {
  const truncation = details?.truncation;
  if (!truncation?.truncated) return "";
  const path = details?.fullOutputPath;
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) return `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${path}]`;
  if (truncation.truncatedBy === "lines") return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${path}]`;
  return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${path}]`;
}

function seconds(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  return total % 60 === 0 ? `${total / 60} min` : `${total} s`;
}
