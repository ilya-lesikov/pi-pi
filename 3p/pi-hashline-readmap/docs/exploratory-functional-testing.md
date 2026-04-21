# Exploratory Functional Testing Note

Current repo snapshot note for `pi-hashline-readmap`.

- Date: 2026-03-24
- Repo: `pi-hashline-readmap`
- Scope: current expected behavior of the package, based on the present codebase and passing automated suite

## Current baseline

Validation at the time of this note:

```bash
npm run typecheck
npm test
```

Observed result:

- `npm run typecheck` — passes
- `npm test` — passes
- Vitest suite: **107 test files / 524 tests** passing

This document is not a bug diary. It is the current testing reference for what the package is expected to do.

## Expected functionality

### `read`

Expected behavior:

- returns `LINE:HASH|content` hashlines for text files
- supports targeted reads via `offset` and `limit`
- appends a structural map automatically when a file is truncated
- supports `map: true` to request a structural map explicitly
- supports `symbol` lookup for mapped file types
- supports `bundle: "local"` for same-file support context around a symbol read
- warns and falls back sensibly for unmappable files or missing symbols
- handles binary-ish / control-character-heavy input defensively enough to avoid unsafe raw rendering in normal output

Practical expectation:

- a user should be able to inspect a large file, jump to a symbol, and obtain stable anchors for later edits without rereading the whole file unnecessarily

### `edit`

Expected behavior:

- applies anchor-verified edits using anchors from `read`, `grep`, or `ast_search`
- supports `set_line`, `replace_lines`, `insert_after`, and `replace`
- rejects stale anchors with useful mismatch diagnostics
- returns diff-oriented result metadata in structured output
- emits additive semantic edit summaries without changing the core success text contract
- preserves line-ending behavior correctly enough for normal text editing workflows, including prior regressions around CRLF handling

Practical expectation:

- a user should be able to read a line, edit exactly that line, and get safe failure if the file drifted

### `grep`

Expected behavior:

- returns anchored matches suitable for direct use with `edit`
- supports regex and literal search
- supports `ignoreCase`, `context`, `limit`, and `summary`
- supports `scope: "symbol"` to group results by enclosing mapped symbol when available
- truncates large result sets with explicit indicators instead of failing silently
- handles problematic file content defensively enough to avoid misleading raw output where possible

Practical expectation:

- a user should be able to search, understand the enclosing code region, and edit from the search result directly

### `ast_search`

Expected behavior:

- wraps `ast-grep` for structural search
- returns merged anchored match blocks grouped by file
- supports no-match cases cleanly rather than surfacing them as execution failures
- integrates cleanly into search → edit workflows

Prerequisite:

- `ast-grep` must be installed locally for real execution

### `bash` output filtering

Expected behavior:

- reduces noisy output while preserving useful signal for common command classes
- includes targeted compression for tests, build tools, git, linters, docker, package managers, HTTP clients, transfer tools, and file-listing commands
- strips ANSI noise
- leaves truly useful output intact enough that the command result remains actionable

Practical expectation:

- common local development commands should consume less context than raw terminal output

## Areas covered by the current automated suite

The present test suite covers, at minimum:

- entry-point registration
- hashline generation
- `read` output shape, truncation, maps, symbol lookup, local bundles, and rendering helpers
- `edit` output, diff generation, semantic classification, difftastic integration/fallbacks, and anchor safety
- `grep` output, summary mode, symbol-scoped grouping, truncation indicators, and rendering helpers
- `ast_search` formatting, schema handling, execution behavior, no-match behavior, and path handling
- binary / control-character handling regressions
- map cache behavior
- RTK / bash filter routing and compressor-specific behavior
- public PTC policy/value contracts
- README / prompts / scripts file integrity checks

## Manual spot-check guidance

When doing manual validation beyond the automated suite, the highest-value checks are:

1. `read` on a large source file with `map: true`
2. `read(symbol=...)` on an ambiguous and an unambiguous symbol
3. `grep(..., scope: "symbol")` on a mapped TypeScript or Python file
4. `ast_search(...)` with both a match and a deliberate no-match query
5. `edit` using a fresh anchor, then repeating with a stale anchor to confirm mismatch handling
6. representative `bash` commands such as `npm test`, `tsc --noEmit`, `git diff`, `docker build`, `curl`, and `find`

## Non-goals of this note

This file should stay short and current.

It should not become:

- a historical session log
- a list of already-fixed bugs
- a scratchpad for temporary repro steps
- a substitute for the automated test suite

If a new issue is found, capture it in issue tracking or a focused repro test rather than expanding this note indefinitely.
