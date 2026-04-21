Write content to a file. Creates the file if it does not exist, overwrites it if it does. Automatically creates parent directories. Returns hashlined content with `LINE:HASH` anchors for immediate use with `edit`.

## When to use
- Creating a new file
- Replacing an entire file when a sequence of `edit` operations would be more awkward than a full rewrite

## When NOT to use
- Small changes to an existing file — use `edit`
- Appending to a file — `read` first, then `edit` with `insert_after`
- Binary content workflows — `write` still writes the content, but binary-looking output gets no hashlines, so there are no anchors to feed into `edit`

## Output
Successful writes return the file contents in `LINE:HASH|content` format. Those anchors can be used directly in a follow-up `edit` call.
Display hashlines escape control characters for safe rendering.

## Truncation
Display output is capped at 2000 lines or 50 KB. When the text view is capped, `write` says so explicitly and tells you that full anchors remain available in `ptcValue`.

## Examples
```text
write({ path: "src/new-module.ts", content: "export function hello() {\n  return 'world';\n}\n" })
```

```text
write({ path: "README.md", content: "# Project\n", map: true })
```

## Parameters
- `path` — relative or absolute file path
- `content` — full file contents to write
- `map` — optional; append a structural map to the visible output
- map append is best-effort; if structural map generation fails, the write still succeeds

## Notes
- Parent directories are created automatically.
- Existing files are overwritten without confirmation.
- There is no append mode; use `read` + `edit` for append-style updates.
- Anchors returned from `write` are valid anchor sources for `edit` in the same session.
