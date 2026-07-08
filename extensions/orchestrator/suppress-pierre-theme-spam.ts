/**
 * Silences a benign, TUI-corrupting `console.error` from `@pierre/diffs`.
 *
 * `@pierre/diffs/dist/highlighter/shared_highlighter.js` registers four custom
 * themes (`pierre-dark`, `pierre-dark-soft`, `pierre-light`, `pierre-light-soft`)
 * as an import-time side effect, against a module-singleton Map. When that module
 * graph is evaluated more than once — which it is here, because pi loads
 * extensions through jiti with `moduleCache: false` and the /pp menu is pulled in
 * via a dynamic `import()` — each re-registration trips a
 * `console.error("SharedHighlight.registerCustomTheme: theme name already registered", name)`.
 *
 * pi takes over stdout during the interactive TUI (its output-guard reroutes
 * stdout→stderr) but does not guard stderr, so that stray error visibly corrupts
 * the rendered UI (seen when opening/closing /pp).
 *
 * We can't dedupe the registration (jiti's cache is off) and there's no
 * patch-package infra in this repo, so we drop exactly this one third-party
 * message and delegate everything else untouched. Installed once, process-wide.
 */

const DUP_THEME_PREFIX = "SharedHighlight.registerCustomTheme: theme name already registered";
const PIERRE_THEME_NAMES = new Set(["pierre-dark", "pierre-dark-soft", "pierre-light", "pierre-light-soft"]);

// Marked on globalThis rather than a module-local flag: pi loads extensions via
// jiti with `moduleCache: false`, so this module can be re-evaluated (resetting
// module scope) — without a process-wide marker we'd stack console.error wrappers.
const INSTALLED_KEY = Symbol.for("pi-pi:pierre-theme-spam-suppressed");

export function suppressPierreThemeSpam(): void {
  if ((globalThis as any)[INSTALLED_KEY]) return;
  (globalThis as any)[INSTALLED_KEY] = true;

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (
      args.length >= 2 &&
      args[0] === DUP_THEME_PREFIX &&
      typeof args[1] === "string" &&
      PIERRE_THEME_NAMES.has(args[1])
    ) {
      return;
    }
    original(...args);
  };
}
