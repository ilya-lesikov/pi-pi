Explore files, structured data (JSON/CSV/TOML/YAML), and system state using Nushell pipelines. Returns structured output ideal for inspection and analysis. Use for exploration and investigation — for running project commands, build tools, scripts, or git operations, use `bash` instead.

## Default prompt surface (Tier 1)

The default `nu` prompt loads three compact blocks:

1. **Routing table** — when to pick `nu` vs `bash`.
2. **Primer** — one-line syntax and example cheatsheet covering `ls | where ... | first`, `open package.json | get scripts`, and `http get URL | get results`, plus the key operators (`where`, `sort-by`, `first`, `length`, `math sum`, `group-by`).
3. **Plugin pointer** — lists optional plugins (`gstat`, `query`, `formats`, `semver`, `file`) and tells the agent to run `plugin list` inside nu to check what is installed.

## On-demand hints (Tier 2)

Plugin-specific recipes are no longer loaded every turn. When a `nu` invocation fails (non-zero exit or timeout) and the output contains a known needle such as `command not found: gstat`, an install/usage hint is appended to the returned text as a line prefixed with `[nu-hint] …`. Agents can rely on that marker to distinguish tooling-appended guidance from `nu`'s own output.

Hints are defined in `src/nu.ts` as `NU_ERROR_HINTS` and applied by `augmentNuOutput` inside `execute`. The prompt surfaces (`NU_GUIDELINES`, `NU_DESC`, `NU_SNIPPET`) never contain hint text.
