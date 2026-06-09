# @dreki-gg/pi-lsp

## 0.4.0

### Minor Changes

- a5e800f: refactor(lsp): adopt Effect and stop enabling TypeScript by default

  - **Effect-based architecture** — config loading, scaffolding, and the unified `lsp` tool now run as Effect programs against injectable services (`FileSystem`, `CommandResolver`, `ServerManager`). Failures are modeled as `Data.TaggedError` types (`ConfigReadError`, `ConfigWriteError`, `LspValidationError`, `NoCapableServerError`, `NoServerAvailableError`, `LspOperationError`), mirroring the firestore package's conventions. Promise-returning wrappers keep the public API stable.
  - **TypeScript is no longer a default server** — the scaffolded starter config now ships TypeScript, Python, Rust, and Go as `disabled` examples. No language server is spawned until the user explicitly opts in, so the extension never auto-starts `typescript-language-server` on a fresh setup.
  - New service-injection tests cover config resolution (global/npx/unavailable command paths) and scaffolding without touching disk or the shell.

## 0.3.0

### Minor Changes

- [#43](https://github.com/dreki-gg/pi-extensions/pull/43) [`c8dc964`](https://github.com/dreki-gg/pi-extensions/commit/c8dc96448bd8cf1a594daf42a1ab0d56f932d629) Thanks [@jalbarrang](https://github.com/jalbarrang)! - feat(lsp): improve reliability and LLM guidance based on real-world usage feedback

  - **documentSymbol now includes column positions** — output shows `line:col` instead of just `line`, eliminating the need for a follow-up `rg --column` to get positions for other LSP operations.
  - **Retry with backoff during server indexing** — `hover`, `definition`, `references`, `implementation`, `documentSymbol`, and `workspaceSymbol` automatically retry (up to 2 times, 2s delay) when the server was recently initialized and returns empty results.
  - **Send `didSave` notification** — the client now sends `textDocument/didSave` after opening or updating documents, fixing diagnostics for servers like `rust-analyzer` that require save events.
  - **Improved diagnostics wait logic** — stale cached diagnostics are cleared on document re-sync, and the arbitrary 500ms delay is removed in favor of resolving immediately when fresh diagnostics arrive.
  - **Rewritten `promptGuidelines`** — 9 targeted guidelines that teach LLMs (especially smaller models) how to use LSP tools effectively: prefer `hover` for quick inspection, position cursor in the middle of symbols, use compiler tools for diagnostics in compiled languages, and more.
  - **Enhanced tool description** — includes tips section and notes that `incomingCalls`/`outgoingCalls` auto-prepare the call hierarchy.
  - **Removed unused code** — `pathToUri` export, `capabilities` getter, and `closeDocument` method removed.

### Patch Changes

- [`87baca4`](https://github.com/dreki-gg/pi-extensions/commit/87baca402f6afa0bba627a3c179bacf0bbbeacba) Thanks [@jalbarrang](https://github.com/jalbarrang)! - fix(lsp): Windows URI normalization and diagnostic waiter race conditions

  - Add `normalizeUri()` to decode percent-encoded URIs (`%3A` → `:`) and uppercase Windows drive letters, fixing key mismatches between `pathToUri` and server responses.
  - `pathToUri()` now always uppercases the drive letter for consistency.
  - `uriToPath()` now applies `decodeURIComponent` so encoded URIs from the server produce valid file paths.
  - Replace per-URI waiter arrays with a single `PendingDiagnostic` promise per URI, eliminating manual timer/splice management.
  - Track `invalidatedUris` to distinguish first-open (empty diagnostics = clean file → resolve immediately) from re-open (empty diagnostics = server clearing stale state → wait for real results).

## 0.2.1

### Patch Changes

- [`32797ff`](https://github.com/dreki-gg/pi-extensions/commit/32797ff18d968e22c6c44e95c46e3393d8928cef) Thanks [@jalbarrang](https://github.com/jalbarrang)! - feat(plan-mode): add Windows compatibility — replace Unix shell commands with cross-platform Bun/Node APIs

  Plan-mode no longer shells out to `cat`, `bash`, or `mkdir` via `pi.exec()`. File I/O now uses `Bun.file()` / `Bun.write()` and `node:fs/promises` `mkdir`, making the extension fully cross-platform. Destructive and safe command pattern lists now include Windows equivalents (`del`, `rd`, `copy`, `move`, `powershell`, `dir`, `where`, `tasklist`, etc.).

  Also fixes Windows compatibility in three other packages:

  - **browser-tools**: `spawn` now uses `shell: true` on Windows so `.cmd` wrappers resolve correctly; `shellEscape` uses double-quote style on Windows; install guidance is platform-aware (Homebrew shown only on macOS).
  - **subagent**: `spawn` uses `shell: true` on Windows when the command is bare `pi`, allowing `pi.cmd` resolution.
  - **lsp**: `globalConfigPath()` now uses `os.homedir()` on Windows instead of the unreliable `process.env.HOME`.

## 0.2.0

### Minor Changes

- [`d1c6d0b`](https://github.com/dreki-gg/pi-extensions/commit/d1c6d0b7da843700a7381790d9323f78dd26b152) Thanks [@jalbarrang](https://github.com/jalbarrang)! - Add Windows support for the LSP extension: spawn with `shell: true` on win32 for `.cmd` wrappers, use `where` instead of `which` for command lookup, normalize file URIs with `file:///` and forward slashes for drive-letter paths per RFC 8089, and fix `uriToPath` to correctly round-trip Windows URIs.

## 0.1.3

### Patch Changes

- [`d133c3d`](https://github.com/dreki-gg/pi-extensions/commit/d133c3da917e7e5def568d27d6cde8ae8a6c00d2) Thanks [@jalbarrang](https://github.com/jalbarrang)! - Mark pi peer dependencies as optional so npm does not auto-install pi internals when installing extension packages.

## 0.1.2

### Patch Changes

- [`0be7b68`](https://github.com/dreki-gg/pi-extensions/commit/0be7b6877e9874b46c756b58c99d599db623ef11) Thanks [@jalbarrang](https://github.com/jalbarrang)! - Migrate TypeBox usage and session replacement flows for Pi 0.69 compatibility.

  - switch extension imports from `@sinclair/typebox` to `typebox`
  - update package peer dependencies to require `typebox`
  - move subagent `/run-agent` fork-at follow-up work into `withSession` so post-fork operations use the replacement session safely
  - add command argument completions for `/run-agent`, `/delegate-agents`, `/preset`, `/mode`, and `/plan`
  - align local development dependencies with Pi 0.69 for typechecking and compatibility checks

## 0.1.1

### Patch Changes

- [`2a5bccb`](https://github.com/dreki-gg/pi-extensions/commit/2a5bccb2d2d663574d03e6e72bf6fcb2cdabc051) Thanks [@jalbarrang](https://github.com/jalbarrang)! - Fix stale LSP footer status so it stays in sync with detected/configured servers.

  - refresh footer status on session start from the resolved config
  - refresh footer status when running `/lsp`
  - refresh footer status after `/lsp-restart`
  - refresh footer status after `lsp` tool execution so running servers are reflected in the UI
