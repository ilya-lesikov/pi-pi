import { getLogger } from "./log.js";

/**
 * Keeps unmanaged console output off the interactive screen.
 *
 * pi-tui renders differentially: every frame moves the physical cursor by a
 * delta computed from where the renderer believes it left it. Anything that
 * writes to the terminal behind its back invalidates that belief, and every
 * frame after lands on the wrong rows — spinner fragments printed over each
 * other, widget content repeated, and the prompt and footer scrolled out of the
 * working area while the renderer still thinks they are on screen.
 *
 * The host guards nothing in interactive mode: `takeOverStdout()` runs only for
 * the non-interactive modes, so both `stdout` and `stderr` reach the screen
 * directly. Extensions and their dependencies write to both — the original
 * instance of this file existed for one such write, a duplicate-theme
 * `console.error` from `@pierre/diffs` re-registering itself under jiti's
 * disabled module cache, which visibly corrupted the UI on every /pp open.
 *
 * Nothing is dropped: each call is written to the session log instead, where a
 * message that mattered can still be read. The one exception is noise with no
 * reader at all — the pierre re-registration above, which the narrower
 * always-on filter also drops but which reaches this wrapper first.
 */

const DUP_THEME_PREFIX = "SharedHighlight.registerCustomTheme: theme name already registered";
const PIERRE_THEME_NAMES = new Set(["pierre-dark", "pierre-dark-soft", "pierre-light", "pierre-light-soft"]);

// Marked on globalThis rather than a module-local flag: pi loads extensions via
// jiti with `moduleCache: false`, so this module can be re-evaluated (resetting
// module scope) — without a process-wide marker we'd stack console wrappers.
const INSTALLED_KEY = Symbol.for("pi-pi:console-guard-installed");

type Level = "debug" | "info" | "warn" | "error";

const METHODS: Array<{ name: "log" | "info" | "warn" | "error" | "debug" | "trace"; level: Level }> = [
  { name: "log", level: "info" },
  { name: "info", level: "info" },
  { name: "warn", level: "warn" },
  { name: "error", level: "error" },
  { name: "debug", level: "debug" },
  { name: "trace", level: "debug" },
];

function isPierreThemeSpam(args: unknown[]): boolean {
  return args.length >= 2
    && args[0] === DUP_THEME_PREFIX
    && typeof args[1] === "string"
    && PIERRE_THEME_NAMES.has(args[1]);
}

function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Route console output to the session log for the rest of the process.
 *
 * Only call this when a TUI owns the terminal. In print and RPC mode the host
 * has already rerouted stdout and console output is the interface.
 */
export function installConsoleGuard(): void {
  if ((globalThis as any)[INSTALLED_KEY]) return;
  (globalThis as any)[INSTALLED_KEY] = true;

  for (const { name, level } of METHODS) {
    const original = (console as any)[name]?.bind(console);
    if (!original) continue;
    (console as any)[name] = (...args: unknown[]) => {
      if (isPierreThemeSpam(args)) return;
      try {
        getLogger()[level]({ s: "console", m: name }, render(args));
      } catch {
        // A logger that cannot write is not a reason to write to the screen:
        // that is the corruption this exists to prevent.
      }
    };
  }
}
