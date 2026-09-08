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
- VCC compaction and recall;
- main and worker model routing;
- provider configuration.

## Memory

Automatic compaction uses the bundled VCC engine. `vcc_recall` searches durable session history, including messages, tool calls, and tool results. Native Pi session restoration remains authoritative; pi-pi does not duplicate conversation state in task files.

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
