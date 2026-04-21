# pi-hashline-readmap

![pi-hashline-readmap banner](https://raw.githubusercontent.com/coctostan/pi-hashline-readmap/main/banner.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-hashline-readmap)](https://www.npmjs.com/package/pi-hashline-readmap)

Upgrade pi's local coding workflow with hash-anchored reads and edits, structural file maps, symbol-aware navigation, structural search, agent-friendly file exploration, and compressed `bash` output.

`pi-hashline-readmap` is a drop-in pi extension. It replaces the stock `read`, `edit`, `grep`, `ls`, and `find` tools, provides an enhanced `ast_search` tool, registers `write`, adds an optional `nu` tool for structured exploration via Nushell, and post-processes `bash` output so more context budget goes to signal instead of noise.

## Why this exists

If you use pi for real code changes, the stock local-tool workflow has a few recurring failure modes:

- search and read output is easy for a model to paraphrase incorrectly
- follow-up edits can drift to the wrong line when the file changes
- large files cost too many tokens to navigate
- search results often need an extra read before they are useful
- noisy test, build, Git, Docker, and package-manager output burns context
- multiple extensions trying to own `read`, `grep`, or `edit` can create conflict

This package consolidates those improvements into one extension instead of stacking overlapping packages.

## Key features

- Hash-anchored `read`, `grep`, and `ast_search` output plus hashlined `write` results for immediate follow-up edits
- Hash-verified `edit` operations (`set_line`, `replace_lines`, `insert_after`, `replace`)
- Structural maps and direct symbol reads for large or complex files
- Symbol-scoped grep and local same-file support bundles for symbol reads
- Agent-optimized `ls` and `find` tools for file exploration
- Optional `nu` tool for structured exploration with Nushell
- Route-aware `bash` compression for tests, builds, Git, Docker, linters, package managers, and more

## Quick Start

### Install from npm

```bash
pi install npm:pi-hashline-readmap
```

Start a new pi session after installation. The extension registers its tools automatically for new sessions.

### Install from a local clone

```bash
git clone https://github.com/coctostan/pi-hashline-readmap.git
cd pi-hashline-readmap
npm install
pi install .
```

## Installation

### Requirements

- [pi](https://github.com/mariozechner/pi-coding-agent) with extension support
- Node.js **>= 20** for local development in this repository

### Install methods

#### 1. npm package

```bash
pi install npm:pi-hashline-readmap
```

Use this if you want the published package.

#### 2. Git install

```bash
pi install git:github.com/coctostan/pi-hashline-readmap
```

Use this if you want to install directly from the repository.

#### 3. Local workspace install

```bash
git clone https://github.com/coctostan/pi-hashline-readmap.git
cd pi-hashline-readmap
npm install
pi install .
```

Use this when developing locally or testing unreleased changes.

### Optional local tools

These tools are not required for the package to load, but they unlock more capability or better output quality:

```bash
brew install nushell           # required for nu tool
brew install ast-grep          # required for ast_search
brew install fd                # optional, speeds up find
brew install difftastic        # optional, improves semantic edit summaries
brew install shellcheck yq scc # optional, improves some bash-output compression paths
```

## Usage

After installation, open a new pi session. The extension wires in upgraded local tools automatically.

### Read with stable `LINE:HASH` anchors
```text
read({ path: "tests/fixtures/small.ts" })
```

Example output from this repository:

```text
45:4bf|export function createDemoDirectory(): UserDirectory {
```

The hash portion is currently a 3-character lowercase hex digest of the normalized line content.

### Edit using the anchor you just read

```text
edit({
  path: "tests/fixtures/small.ts",
  edits: [
    {
      set_line: {
        anchor: "45:4bf",
        new_text: "export function buildDemoDirectory(): UserDirectory {"
      }
    }
  ]
})
```

### Create a new file with `write`

```text
write({ path: "src/new-module.ts", content: "export const demo = 1;\n" })
```

`write` returns hashlined output you can feed straight into a follow-up `edit` call.

### Read a symbol directly

```text
read({ path: "tests/fixtures/small.ts", symbol: "createDemoDirectory" })
read({ path: "tests/fixtures/small.ts", symbol: "UserDirectory.addUser" })
```

### Read a large file with a structural map

```text
read({ path: "src/hashline.ts", map: true })
```

Use this when you need the shape of a file before choosing a symbol or line range.

### Read a symbol with local same-file support

```text
read({ path: "tests/fixtures/small.ts", symbol: "createDemoDirectory", bundle: "local" })
```

### Search and edit directly with grep

```text
grep({ pattern: "createDemoDirectory", path: "tests/fixtures", literal: true })
```

### Search within enclosing symbols

```text
grep({ pattern: "createDemoDirectory", path: "tests/fixtures", literal: true, scope: "symbol" })
grep({ pattern: "createDemoDirectory", path: "tests/fixtures", literal: true, scope: "symbol", scopeContext: 3 })
```
Use `scopeContext: 0` for only the matching lines inside the resolved symbol block.

### Structural code search with `ast_search`

```text
ast_search({ pattern: "console.log($$$ARGS)", lang: "typescript", path: "src" })
```

`ast_search` requires `ast-grep` installed locally.

### Explore files with `ls` and `find`

```text
ls({ path: "src" })
find({ pattern: "*.ts", path: "src", maxDepth: 2 })
```

### Use Nushell for structured exploration

```text
nu({ command: "open package.json | get scripts" })
```

When [Nushell](https://www.nushell.sh/) is installed, the extension registers `nu` for structured exploration and data inspection.

### Bypass `bash` compression when you need raw output

```bash
PI_RTK_BYPASS=1 npm test
PI_RTK_BYPASS=1 git log --stat
```

Use the bypass when the filtered output hides information you need.

## Tool reference

### `read`
- returns `LINE:HASH|content` output
- anchor examples currently look like `45:4bf|...` (3-character lowercase hex hashes)
- supports targeted reads via `offset` and `limit`
- appends a structural map automatically when a file is truncated
- supports `map: true` for an explicit structural map
- supports direct symbol lookup via `symbol`
- supports `bundle: "local"` for same-file local support around a symbol read
- supports structural maps across **18 mapped language/file kinds**
- uses in-memory caching plus optional persistent caching across sessions for structural maps

### `edit`
- consumes anchors from `read`, `grep`, and `ast_search`
- supports `set_line`, `replace_lines`, `insert_after`, and `replace`
- verifies anchors before writing
- reports mismatch diagnostics when the file changed since the read
- adds semantic edit classification in structured output
### `write`

- creates parent directories automatically
- returns hashlined output suitable for immediate follow-up `edit` calls
- supports `map: true` to append a structural map to the visible output
- warns and skips hashline generation for binary-looking content

### `grep`
- returns anchored matches ready for direct use with `edit`
- supports literal or regex search
- supports `summary: true` for per-file match counts
- supports `scope: "symbol"` and `scopeContext` for symbol-local results
### `ast_search`
- wraps `ast-grep` for structure-aware code search
- returns merged, anchored match blocks grouped by file
- is best for syntax-shaped queries rather than raw text matching
- returns install guidance when the local `sg` binary is missing

### `ls` and `find`
- `ls` shows a single directory, dirs first, with dotfiles included
- `find` performs recursive discovery, respects `.gitignore`, includes hidden files, and supports depth, regex, sort, mtime, and size filters

### `nu`

- registers only when Nushell is installed
- useful for structured inspection of JSON, CSV, TOML, YAML, filesystem state, and other machine-readable data
- supports pi-specific config lookup via `PI_NUSHELL_CONFIG`
- points agents at optional plugins such as `gstat`, `query`, `formats`, `semver`, and `file`

### `bash` output compression

The extension post-processes `bash` tool results to reduce noise while preserving the useful parts. Specialized compressors currently cover:

- test runners
- build tools
- compiler and bundler noise
- Git output
- linter output
- Docker output
- package manager output
- HTTP client output
- transfer tools
- file-listing output
- oversized generic output via smart truncation

## Configuration

This package is configured with environment variables rather than a project-local config file.

| Variable | Purpose | Default / behavior |
|---|---|---|
| `PI_HASHLINE_MAP_CACHE_DIR` | Override the persistent structural-map cache directory | Uses the provided path verbatim |
| `XDG_CACHE_HOME` | Base directory for the persistent map cache when no explicit cache dir is set | Cache lives under `$XDG_CACHE_HOME/pi-hashline-readmap/maps` |
| `PI_HASHLINE_NO_PERSIST_MAPS=1` | Disable the on-disk structural-map cache | Keeps caching in-memory only |
| `PI_NUSHELL_CONFIG` | Override the Nushell config path used by `nu` | Otherwise prefers `~/.config/pi/nushell/config.nu`, then `--no-config-file` |
| `PI_RTK_BYPASS=1` | Disable route-specific `bash` compression for one command invocation | ANSI is still stripped; anti-pattern hints still apply |

## Structured output (`details.ptcValue`)

All tools provide machine-facing structured data alongside human-facing text output.

### `read`

Includes path, selected range, warnings, truncation info, symbol metadata, map status, and per-line anchors.

### `grep`

Includes total matches, per-record anchors, and additive symbol-scope metadata when `scope: "symbol"` is used.

### `ast_search`

Includes grouped match ranges and anchored lines.

### `edit`

Includes summary, diff, changed lines, warnings, no-op metadata, and semantic edit classification.

### `ptcValue.error`

When a tool fails, its result includes a structured `error` envelope inside `ptcValue` so downstream consumers can dispatch programmatically without parsing free text.

```ts
interface PtcError {
  code: string;       // stable, kebab-case, drawn from src/ptc-error-codes.ts
  message: string;    // matches (or is a clean superset of) content[0].text
  hint?: string;      // concrete next-step recovery suggestion, when one exists
  details?: unknown;  // tool-specific structured data
}
```

```ts
{
  isError: true,
  content: [{ type: "text", text: ... }],
  details: {
    ptcValue: {
      tool: "<toolName>",
      ok: false,
      path?: string,
      error: PtcError,
    },
  },
}
```

### PTC tool policy contract

The package exports a machine-readable tool policy contract. The primary export is `HASHLINE_TOOL_PTC_POLICY`, and the package also exports `getHashlineToolPtcPolicy()`.

```ts
import { HASHLINE_TOOL_PTC_POLICY } from "pi-hashline-readmap";
```

Policy summary:
- `read`, `grep`, `ls`, and `find` are safe-by-default and read-only
- `ast_search` and `nu` are opt-in and read-only
- `edit` is not safe-by-default and is mutating
- `pi-prompt-assembler` may optionally consume this contract

## EventBus integration

On load, the extension emits tool executor references for downstream consumers.

The emitted/stashed executor surface always includes `read`, `edit`, `grep`, `ast_search`, `write`, `ls`, and `find`, plus `nu` when Nushell is available at runtime.

```ts
pi.events.emit("hashline:tool-executors", {
  read,
  edit,
  grep,
  ast_search,
  write,
  ls,
  find,
  ...(nu ? { nu } : {}),
});
```

The same executors are also exposed at `globalThis.__hashlineToolExecutors`.

## Project Structure

```text
index.ts                  # extension entry point
src/
  read.ts                 # read tool implementation
  edit.ts                 # edit tool implementation
  grep.ts                 # grep tool implementation
  sg.ts                   # ast-grep wrapper
  write.ts                # write tool implementation
  ls.ts                   # single-directory listing
  find.ts                 # recursive discovery
  nu.ts                   # Nushell integration
  readmap/                # structural mapping and symbol lookup engine
  rtk/                    # bash output compression pipeline
prompts/                  # tool prompt/schema docs
tests/                    # Vitest suite
docs/                     # project notes and testing docs
scripts/                  # helper scripts used by readmap internals
```

## Development

### Install dependencies

```bash
npm install
```

### Validate the workspace

```bash
npm test
npm run typecheck
```

Before publishing or opening a PR, run the workspace checks above from a clean checkout and add any focused tests needed for the specific files or tools you changed.

### Local development notes

This repository is intended to be used as a pi extension workspace. New agent sessions pick up local extension edits from the checkout, but running sessions do not hot-reload the module graph. Restart the agent session after changing extension code.

For project-specific development workflow details, see [AGENTS.md](https://github.com/coctostan/pi-hashline-readmap/blob/main/AGENTS.md).

## Documentation

- [CHANGELOG.md](CHANGELOG.md)
- [docs/exploratory-functional-testing.md](https://github.com/coctostan/pi-hashline-readmap/blob/main/docs/exploratory-functional-testing.md)
- [prompts/](prompts/)

## Contributing

PRs are welcome. If you change tool behavior or output contracts:

- update the relevant tests in `tests/`
- update prompt docs in `prompts/` when user-visible contracts change
- update `README.md` when installation, usage, or output semantics change materially
- follow repository workflow notes in [AGENTS.md](https://github.com/coctostan/pi-hashline-readmap/blob/main/AGENTS.md)

## Credits

Combines and adapts ideas from:

- [pi-hashline-edit](https://github.com/nicholasgasior/pi-hashline-edit) — hash-anchored editing
- [pi-read-map](https://github.com/nicholasgasior/pi-read-map) — structural file maps
- [pi-rtk](https://github.com/mcowger/pi-rtk) — bash output compression

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
