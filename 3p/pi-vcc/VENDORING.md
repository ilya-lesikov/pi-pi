# Vendored pi-vcc (retained closure only)

Upstream: `@monotykamary/pi-vcc` v0.7.1 (https://github.com/monotykamary/pi-vcc).

pi-pi vendors **only** pi-vcc's deterministic compaction ENGINE (`compile()`) and
its lossless `vcc_recall` tool. pi-pi owns the single `session_before_compact`
handler and the in-phase compaction trigger, so vcc's own hooks/commands are
**not** vendored and **not** registered — registering them would clobber pi-pi's
compaction (the SDK runner keeps the last non-null `session_before_compact`
result, so two handlers fight).

## Retained modules (`src/` + `index.ts`)

Reachable from the two entry points `src/core/summarize.ts` (`compile`) and
`src/tools/recall.ts` (`registerRecallTool`):

- `src/core/`: summarize, normalize, filter-noise, build-sections, format,
  causal-keys, content, sanitize, tool-args, brief, skill-collapse,
  load-messages, search-entries, format-recall, lineage, recall-scope,
  render-entries
- `src/extract/`: goals, shared-symbols, preferences, commits
- `src/tools/recall.ts`
- `src/{types,sections,details}.ts`
- `index.ts` — re-exports `compile`, `CompileInput`, `registerRecallTool`,
  `PiVccCompactionDetails`, `FileOps` (nothing else; no hook/command registration).

## Deliberately EXCLUDED (not copied)

- `src/hooks/before-compact.ts`, `src/hooks/proactive-threshold.ts` — vcc's own
  compaction hook + proactive trigger (pi-pi owns these).
- `src/commands/*` — vcc slash commands.
- `src/core/invisible-continue.ts` — the ONLY importer of
  `@earendil-works/pi-agent-core`; reached only from the dropped hook path.
- `src/core/settings.ts` — reads `~/.pi/agent/pi-vcc-config.json`; NOT in the
  `compile()` closure (only the dropped hook used it). pi-pi feeds compaction
  thresholds from its own config, so this stays out to avoid a second config
  source.

## Guarantees

- Zero new runtime deps: the retained closure imports only the peers pi-pi
  already has — `@earendil-works/pi-ai` (types + `Message`), `typebox` (recall
  tool schema), and a type-only `@earendil-works/pi-coding-agent` import for
  `ExtensionAPI`. `package.json.dependencies` is empty.
- `test/no-agent-core.test.ts` walks the import graph from the two entry points
  and asserts no reachable module imports `@earendil-works/pi-agent-core`; it
  also asserts the excluded files are absent. This guards against a future
  upstream sync spreading that import into the engine.

## Packaging (root TODO — reported, not applied)

The root `package.json` `files` array must add, alongside the other 3p entries:

```
"3p/pi-vcc/index.ts",
"3p/pi-vcc/src/",
"3p/pi-vcc/package.json",
```

(Do NOT add `test/`.) No change to root `dependencies` is needed.
