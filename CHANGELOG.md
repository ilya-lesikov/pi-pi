# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.7.0] - 2026-04-20

### Added
- Anchor-contract prompt/docs alignment (#42).
- Surface edit semantic annotations + replace-only guidance (#43).
- Require confirmation for fuzzy symbol matches (#44).
- `grep` `scopeContext` windowing (#45).
- `find` regex pattern, `modifiedSince`, `minSize`/`maxSize`, `sortBy`/`reverse` options (#46).
- Expose `ls` / `find` / `nu` hashline executor surface (#47).
- `nu` lazy-load advanced guidelines (#48).
- Structured `ptcValue` error envelopes (#49).
- Doom-loop escalate from warning → append-then-review in `edit` (#50).
- Bash compression raw-bypass via `PI_RTK_BYPASS=1` (#51).
- Persistent structural-map cache across sessions (#52).

### Fixed
- `find`: validate `maxDepth` ≥ 0 before spawning `fd` (#112).
- `read`: reject empty / whitespace-only `symbol` instead of silently returning full file (#113).
- `ls`: validate `limit > 0` and surface invalid-glob errors (#114).
- `ast_search`: report `path '<x>' does not exist` instead of silent "No matches" (#115).
- `write`: map `EACCES`/`EPERM`/`EISDIR`/`ENOENT`/`ENOSPC`/`EROFS` to friendly messages (#116).

### Docs
- `AGENTS.md`: correct extension-loading description (absolute-path entry in `~/.pi/agent/settings.json`, not a symlink) and note the restart requirement for running sessions (#117).
- `README.md`: document persistent map cache, `scopeContext`, new `find` filters, `PI_RTK_BYPASS`, edit semantic summaries, and fuzzy-symbol confirmation banners (#118).

## [0.4.0] - 2026-03-24

### Added
- Semantic edit summaries for `edit`, including additive structured metadata and optional difftastic-backed classification.
- Additive output-contract metadata for `read` local bundles and `grep` symbol-scoped results.
- Render helpers / richer TUI rendering for `read`, `grep`, `edit`, and `sg` tool output.
- Additional RTK compressors and routing improvements for Docker, package managers, HTTP clients, transfer tools, and file-listing commands.
- EventBus / global executor exposure for downstream consumers.
- Public PTC policy / structured output integration for hashline tools.

### Changed
- Repo metadata and docs were cleaned up for the `0.4.0` release.
- README and local agent guidance were refreshed.

## [0.3.0] - 2026-03-16

### Added
- Symbol-addressable reads via `read(path, { symbol })`, including ambiguity handling and graceful fallback warnings.
- Bash output compression filter wired into the extension tool-result flow.
- Faster hash generation via `xxhash-wasm`.
- Lower-syscall `read` / `edit` file access paths.
- Grep output summary headers, smarter truncation, and context-window deduplication.
- AST-grep range merging to reduce duplicate output blocks.
- Compact single-line edit diffs.

### Changed
- README and release metadata were updated for the `0.3.0` release.

## [0.2.0] - 2026-03-03

### Added
- Unified project scaffold combining hashline read/edit/grep behavior, structural read maps, and RTK bash-output compression foundations.
- Core source layout under `src/`, `src/readmap/`, `src/rtk/`, `scripts/`, `prompts/`, and `tests/`.
- Initial Vitest suite and TypeScript project configuration.

## [0.1.0] - 2026-03-02

### Added
- Initial local development baseline for the combined extension workspace.
