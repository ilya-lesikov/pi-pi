# pi-pi

A persistent, general-purpose agent configuration for Pi.

## Install

```shell
pi install npm:@ilya-lesikov/pi-pi
```

Recommended optional extension:

```shell
pi install npm:pi-mcp-adapter
```

Start Pi and talk to it normally. The initial Pi session owns all work; pi-pi does not create a second task context or impose research, planning, implementation, or review phases. It continues interrupted work autonomously, recovers stalled turns, and asks for user input only when unavailable information or preference controls a consequential decision. A turn that ends in prose after real work is checked out of band — the turn is replayed to its own model with a yes/no question — and resumed through a hidden message only when that model says work is left, so nothing is added to the conversation on a false alarm.

## `/pp`

`/pp` remains the control panel for:

- session and context status;
- bounded background workers;
- reloadable skills;
- prompt size and recall;
- main and worker model routing;
- provider configuration.

## Memory

The prompt is kept inside the model's window by folding old tool traffic out of the copy on its way to the provider: arguments are capped per value, results become a `[omitted: <size>B; <call_id> — <tool>: <what it addressed>]` notice, and what the user and the model said is never touched. The trailing subject names the call the notice stands for, so a folded result can be recognised without being recalled. Folding is oldest-first and never reversed, so the prompt's prefix stays stable between requests and the provider's cache survives.

The session itself is never cut. `recall_tool_output` and `recall_tool_args` hand back a folded call by its id, and `vcc_recall` searches durable session history — messages, tool calls, and tool results. Native Pi session restoration remains authoritative; pi-pi does not duplicate conversation state in task files.

## Tool provisioning

The tools the agent is told to prefer are installed rather than assumed. ripgrep and the code graph are fetched at session start; a language server is fetched the first time a file of its language is touched. Everything lands in one directory that is prepended to the session's `PATH`, so ordinary `which` lookups find it and the user's shell environment is untouched.

Downloads verify what the publisher actually offers — a published digest where there is one, npm's own integrity check for npm packages, a toolchain's own verification for toolchain components — and `/pp → Doctor` reports which of those applied per tool rather than implying a uniform guarantee. A session that cannot reach the network starts anyway, degraded exactly as it would have been before.

## Skills

The main prompt contains a compact catalog. Full skill guidance is loaded through `load_skill` and appears as a tagged tool result, so it remains searchable and can be loaded again when no longer salient.

Skill precedence is:

1. `<project>/.pi/skills`
2. `~/.pi/skills`
3. bundled pi-pi skills

A skill may be `<name>/SKILL.md` or a Markdown file directly inside a skills directory. It needs frontmatter with `name` and `description`.

Bundled guidance covers software engineering, repository work, research and design, and skill authoring. The agent decides when to load it; `/pp` only shows the catalog and source settings.

## Workers

The main session owns long-running and interactive work. Functional workers are optional and bounded:

- `explore` for local retrieval and mapping;
- `librarian` for external sources;
- `advisor_*` for independent judgment;
- `deep-debugger_*` for difficult diagnosis;
- `reviewer_*` for fresh read-only review;
- `task` for a self-contained parallel slice.

Workers receive no duplicated task artifact bundle. They can search the owning session with `vcc_recall` when prior decisions or tool results matter. Worker execution has no turn or stale-time limit by default. Users can set `maxTurns` per simple worker or pool entry and `performance.internals.subagentStale` in scoped `.pp/config.json`; `0` means unlimited.

## ACP clients

The pi-acp fork can expose `/pp`, usage, workers, elicitation, and session status in clients such as Zed. pi-pi no longer publishes a phase pipeline because there is none.

## Flant

Flant model discovery and provider routing remain available through scoped `.pp/config.json` configuration.
