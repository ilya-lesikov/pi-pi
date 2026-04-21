Search file contents for a pattern. Returns matching lines with `LINE:HASH` anchors for hashline edit workflows.

## Search Modes

### Default mode
Returns matching lines prefixed with `LINE:HASH|content` anchors. Use `>>` markers to identify match lines vs context lines.

### Context mode (`context: N`)
Includes N surrounding lines before and after each match. Nearby matches are merged and deduplicated automatically. Use when you need to see the code around a match, not just the matching line.

### Summary mode (`summary: true`)
Returns per-file match counts only — no line content, no anchors. Use this first to scope a broad search across many files, then drill into specific files with a targeted search.

### Symbol-scoped mode (`scope: "symbol"`)
Groups matches by their enclosing function, method, or class. By default, shows the full symbol block containing each match. Pass `scopeContext: N` to window output to ±N lines around each match (clipped at the symbol boundary); pass `scopeContext: 0` to get only match lines. The group header carries the line range and the `scoped to ±N lines` suffix. Falls back gracefully for files without structural maps. Ignored when `summary: true`.

## Parameters

- `pattern` — Search pattern (regex by default, or literal string with `literal: true`)
- `path` — Directory or file to search (default: current directory)
- `glob` — Filter files by glob pattern, e.g. `'*.ts'` or `'**/*.test.ts'`
- `ignoreCase` — Case-insensitive search (default: false)
- `literal` — Treat pattern as literal string instead of regex (default: false). Use for exact matches to avoid regex escaping issues.
- `context` — Number of lines to show before and after each match (default: 0)
- `limit` — Maximum number of matches to return (default: 100)
- `summary` — Return per-file match counts only (no hashline anchors)
- `scope` — Set to `"symbol"` to group matches by enclosing symbol block
- `scopeContext` — Number of context lines to show around each match within the enclosing symbol (requires `scope: "symbol"`). `0` = match lines only; `N > 0` = ±N lines clipped at the symbol boundary. Rejected when `scope` is not `"symbol"` — use `context` for non-symbol-scoped searches.

## Truncation behavior
- If total matches hit `limit`, grep appends `[Results truncated at N matches — refine pattern or increase limit]`.
- Independently, if the rendered output exceeds the overall line/byte budget, grep head-truncates the text and appends `[Output truncated: ...]`.

## Usage Guidance

- Use `summary: true` first to scope a broad search, then drill into specific files with `path` or `glob`
- Use `scope: "symbol"` when you need to understand the context of matches, not just find them
- Use `literal: true` for exact string matches (e.g., searching for `$variable` or `array[0]`) to avoid regex escaping issues
- Anchors from grep can be used directly in `edit` — no intermediate `read` needed
- For structural code patterns (function calls, imports, JSX), prefer `ast_search` if available

## Workflow: grep → edit

1. Search: `grep({ pattern: "oldFunction", glob: "*.ts" })`
2. Review output — each match has a `LINE:HASH` anchor
3. Use anchors directly: `edit({ path: "file.ts", edits: [{ set_line: { anchor: "45:a3f", new_text: "newFunction();" } }] })`

## Output Format

```
[3 matches in 2 files]
--- src/server.ts (2 matches) ---
src/server.ts:>>45:a3f|router.addRoute("/api", handler);
src/server.ts:  46:b12|router.addRoute("/health", healthCheck);
--- src/client.ts (1 match) ---
src/client.ts:>>12:c7e|const api = new ApiClient();
```

Lines with `>>` are matches; lines with `  ` (two spaces) are context lines.

### scope: "symbol" with scopeContext

```
[2 matches in 1 files]
--- src/server.ts :: function handleRequest (42-180, 2 matches, scoped to ±3 lines) ---
src/server.ts:  55:a12|  // validate input
src/server.ts:  56:b34|  if (!req.body) return 400;
src/server.ts:  57:c56|  // route lookup
src/server.ts:>>58:d78|  const route = findRoute(req);
src/server.ts:  59:e9a|  if (!route) return 404;
src/server.ts:  60:f01|  // auth
src/server.ts:  61:012|  const user = await authenticate(req);
--
src/server.ts:  75:234|  // response
src/server.ts:>>76:456|  const result = await handle(route, user);
src/server.ts:  77:678|  res.json(result);
```

With `scopeContext: 0`, only match lines are shown under the header:

```
--- src/server.ts :: function handleRequest (42-180, 2 matches, scoped to ±0 lines) ---
src/server.ts:>>58:d78|  const route = findRoute(req);
src/server.ts:>>76:456|  const result = await handle(route, user);
```