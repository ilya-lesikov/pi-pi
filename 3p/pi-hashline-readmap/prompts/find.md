Find files recursively matching a glob or regex pattern. Respects `.gitignore` (including nested), always includes hidden files. Supports sorting by name/mtime/size and filtering by mtime/size. Returns sorted relative paths with structured metadata.

## Parameters

- `pattern` — Glob pattern (default) or JavaScript regular expression when `regex: true`. Matches against file **basename**. Example glob: `'*.ts'`. Example regex: `'(Router|Handler)\\.ts$'`. **Required.**
- `path` — Directory to search (default: current directory).
- `limit` — Maximum entries to return after filtering and sorting (default: 1000).
- `type` — Filter by entry type: `"file"` (default), `"dir"`, or `"any"`.
- `maxDepth` — Maximum directory depth to search.
- `regex` — Treat `pattern` as a JavaScript regular expression against the basename (default: `false`). Uses JS `RegExp` semantics uniformly on every platform.
- `sortBy` — `"name"` (default, lexicographic), `"mtime"`, or `"size"`. Ascending by default; combine with `reverse: true` to flip.
- `reverse` — Reverse the sort order (default: `false`). With `sortBy: "mtime"` → newest first. With `sortBy: "size"` → largest first.
- `modifiedSince` — Filter to entries modified **strictly after** this instant. Accepts ISO date (`"2024-01-01"`), ISO timestamp (`"2024-01-01T00:00:00Z"`), or relative shorthand `<n><unit>` where unit ∈ `m`, `h`, `d`: `"30m"`, `"1h"`, `"24h"`, `"7d"`.
- `minSize` / `maxSize` — File size bounds, inclusive on both ends. Accepts a number (bytes) or a string with a **1024-based** suffix: `B`, `K`, `KB`, `M`, `MB`, `G`, `GB` (case-insensitive). Fractional values are allowed (e.g. `"1.5MB"`). Size filters apply to files only; directories are never removed by size.

## Output

One path per line, sorted and filtered per the parameters. Paths are relative to `cwd` with forward slashes. Directories (when `type: "dir"` or `type: "any"`) show a trailing `/` suffix.

When the entry count exceeds `limit`, a truncation notice is appended. Output is also bounded at 50 KB.

## Agent Examples (paste-ready)

- Newest files in the project: `{ pattern: "*", type: "any", sortBy: "mtime", reverse: true, limit: 20 }`
- Files changed in the last hour: `{ pattern: "*", modifiedSince: "1h" }`
- Largest source files: `{ pattern: "*.ts", sortBy: "size", reverse: true, limit: 10 }`
- Files over 1 MB: `{ pattern: "*", minSize: "1MB" }`
- `Router` or `Handler` in the filename: `{ pattern: "(Router|Handler)", regex: true }`
- All `.test.ts` files modified in the last day: `{ pattern: "*.test.ts", modifiedSince: "24h", sortBy: "mtime", reverse: true }`

## Pipeline

Results are produced in this order:

1. Enumerate candidates using `fd` (if installed) or a built-in walker. Both respect `.gitignore`.
2. Apply filters: regex (if `regex: true`), `modifiedSince`, `minSize`, `maxSize`.
3. Sort by `sortBy` (with `reverse`).
4. Apply `limit`.

`limit` always applies **after** filtering and sorting, so adding `modifiedSince` or a size filter surfaces lower-ranked entries into the limit window.

## Usage Guidance

- Use `find` for recursive file discovery across the tree.
- Use `type: "dir"` to discover directory structure.
- Use `maxDepth: 1` for shallow exploration without switching to `ls`.
- Use `ls` instead for single-directory inspection.
- Use `grep` to search file *contents*, not file names.
- Size units are 1024-based (`1KB` = 1024 B, `1MB` = 1024² B, `1GB` = 1024³ B).

## Backend

Uses `fd` when available for maximum speed. Falls back to a pure Node.js implementation when `fd` is not installed. Filters, regex, and sort are applied in-process in JavaScript, so regex semantics and sort behavior are identical on both backends.
