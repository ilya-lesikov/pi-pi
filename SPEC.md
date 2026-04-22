# pi-pi: Specification

A pi extension that orchestrates multi-phase, multi-model workflows for implementation, debugging, and brainstorming.

## Commands

All commands are prefixed with `pp:`.

### /pp:implement `<description>` [--from `<task-path>`]

Full pipeline: brainstorm → planning → implementation → review.

`--from <task-path>` inherits USER_REQUEST.md and RESEARCH.md from a previous debug or brainstorm task. When the source is a debug task, brainstorm phase is skipped.

Starting a new task while another is active auto-finishes the old one.

### /pp:debug `<description>`

Read-only diagnosis. The agent investigates the problem using bash, git, and subagents, but does not modify project source code. Produces USER_REQUEST.md (the derived fix request) and RESEARCH.md (root cause analysis, evidence, recommended fix approach). On completion, suggests `/pp:implement --from debug/<task-id>` to continue with a fix.

### /pp:brainstorm `<description>`

Open-ended conversation. No phases, no required output. Spawns explore/librarian subagents on demand. Does not modify source code. If the user asks to capture conclusions, writes USER_REQUEST.md and RESEARCH.md.

### /pp:next

Validates exit criteria for the current phase and transitions to the next. Both the LLM and the user can call this. If criteria aren't met, reports what's missing.

### /pp:resume

Lists all paused (non-done) tasks. User picks one to resume.

### /pp:done

Aborts all subagents, marks the task done, releases the lock.

### /pp:status

Shows current task info (type, phase, age, directory).

---

## Implement Flow

### Phase 1: Brainstorm

**Goal:** Produce USER_REQUEST.md and RESEARCH.md — complete enough for downstream agents.

The main agent interviews the user, spawns explore/librarian subagents for codebase and external research, and iteratively builds the two documents. Once both are non-empty, calls `/pp:next`.

RESEARCH.md follows a structured template: Affected Code, Architecture Context, Constraints & Edge Cases, Open Questions, Recommended Approach.

### Phase 2: Planning

**Goal:** Produce a synthesized plan in `plans/<timestamp>_synthesized.md`.

Multiple planner subagents run in parallel (opus, gpt, gemini, grok — each configurable/disablable). Each reads USER_REQUEST.md and RESEARCH.md and writes its own plan. The main agent synthesizes them into a final plan and asks the user for approval. Optionally, plan-reviewer subagents provide feedback before approval.

Plans use checkboxes for progress tracking. They describe *what* to do, not *how* at the code level.

### Phase 3: Implementation

**Goal:** Execute the plan.

The main agent implements the plan, checking off items as it completes them. Subtasks can be delegated to task subagents. LSP diagnostics run on each edit. `afterEdit` commands (formatters, type checkers) run after each file change — advisory, not blocking. Auto-commit creates human-readable commits after each checkpoint. If a fix fails 3 times, the agent stops and re-plans the approach.

After all items are checked, `afterImplement` commands run (full test suite, linters). These ARE gates — failures block the transition.

### Phase 4: Review

**Goal:** Validate the implementation.

The user chooses: manual review only, normal auto-review, or deep auto-review (higher thinking levels). Code-reviewer subagents run in parallel, each writing a review with structured output (CRITICAL/MAJOR/MINOR/OPEN QUESTIONS/VERDICT), evidence requirements (file:line for every CRITICAL/MAJOR), and confidence tagging (HIGH/MEDIUM/LOW). The main agent synthesizes reviews and presents to the user.

If changes are needed, the agent creates a separate fix plan (the original plan is never modified), implements fixes, and a new review round begins. Auto-review rounds are capped by `maxAutoReviewRounds` (default 2).

### Phase Transitions

On phase transitions (`/pp:next`), the extension aggressively compacts the conversation context and re-injects task artifacts (USER_REQUEST.md, RESEARCH.md, synthesized plan) as fresh messages. This provides a near-clean context for each phase without destroying extension state.

During long phases, pi's auto-compaction may trigger. When it does, artifacts are re-injected after compaction to ensure they're never lost.

On task start and resume, the configured model is set. If the model isn't found, a warning is shown and the current model is used as fallback.

---

## Debug Flow

Main agent (GPT 5.4, high reasoning) investigates the problem with bash access but no source code modification. Spawns explore/librarian subagents as needed. Produces USER_REQUEST.md and RESEARCH.md. On `/pp:done`, suggests the `--from` command to continue with implementation.

---

## Brainstorm Flow

Open-ended conversation. No phases. Spawns explore/librarian on demand. If conclusions are captured, writes USER_REQUEST.md and RESEARCH.md. Can feed into `/pp:implement --from <brainstorm-task>`.

---

## Subagents

### Agent Types

| Agent | Purpose | Who spawns it | Tools |
|-------|---------|---------------|-------|
| explore | Internal codebase search | LLM via Agent() | read, grep, find, ls, bash, lsp, ast_search, cbm_*, exa_* |
| librarian | External docs research | LLM via Agent() | read, grep, find, bash, exa_search, exa_fetch |
| task | Delegated implementation subtask | LLM via Agent() | all (read, write, edit, bash, grep, find, ls, lsp, ast_search, cbm_*, exa_*) |
| planner | Creates plans from requirements | Extension on planning phase entry | read, grep, find, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |
| plan-reviewer | Validates plan executability | Extension on demand | read, grep, find, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |
| code-reviewer | Reviews implementation diffs | Extension on review phase entry | read, grep, find, ls, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |

Planner, plan-reviewer, and code-reviewer have per-model variants (opus, gpt, gemini, grok), each independently configurable/disablable.

All subagents can spawn explore/librarian for additional context. Task subagents cannot spawn other task subagents (no recursion).

### Code Intelligence Tools

The extension hardcodes three code intelligence tool suites, always available without configuration:

**CBM (codebase-memory-mcp)** — Graph-based code knowledge engine. Binary at `~/.local/bin/codebase-memory-mcp`. Auto-indexes the workspace on first use.

| Tool | Purpose |
|------|---------|
| cbm_search | Natural-language BM25, regex, or semantic vector search across indexed symbols |
| cbm_search_code | Graph-augmented grep — deduplicates matches into containing functions |
| cbm_trace | Call chain traversal (inbound/outbound) by function name |
| cbm_changes | Git diff → affected symbols + blast radius |
| cbm_query | Cypher-like graph queries for multi-hop patterns |
| cbm_architecture | High-level codebase structure overview |

**LSP (via pi-lsp)** — Compiler-grade semantic analysis. Zero false positives. Supports goToDefinition, findReferences, hover, goToImplementation, documentSymbol, workspaceSymbol, incomingCalls, outgoingCalls, diagnostics, codeActions.

**ast-grep (via pi-hashline-readmap)** — AST-aware structural pattern matching via the `ast_search` tool. Finds code shapes (e.g. `if err != nil { $$$ }`, `go $FUNC($$$)`) rather than text.

**Exa (web search)** — Always-available web search via Exa AI. No API key required.

| Tool | Purpose |
|------|---------|
| exa_search | Search the web for docs, guides, examples. Natural-language queries. |
| exa_fetch | Read a URL's full content as clean markdown. |

### Tool Routing

Agent prompts include an intent-based tool routing guide:

| Intent | Primary tool | Fallback |
|--------|-------------|----------|
| Find code by concept | cbm_search | lsp workspaceSymbol → grep |
| Navigate to definition | lsp goToDefinition | — |
| Find all usages | lsp findReferences | — |
| Trace call chains | lsp incomingCalls/outgoingCalls | cbm_trace |
| Find structural patterns | ast_search | — |
| Search literal text | grep | — |
| Assess change impact | cbm_changes | — |
| Web search | exa_search → exa_fetch | — |

### Behavioral Blocks

All agent prompts include shared behavioral blocks from `tool-routing.ts`:

- **WORKING_PRINCIPLES** — verify before assuming, understand before modifying, smallest viable change, no temp artifacts, evidence over claims, match existing patterns. Read-only agents get a trimmed version.
- **FAILURE_RECOVERY** — 3-strike rule: after 3 failed attempts, stop editing, revert, document, report blocker.
- **COMMUNICATION** — be direct/brief, think critically, push back when wrong, dense over polished.
- **TOOL_ROUTING** — intent-first routing guide (see table above).

Prompts are structured for prompt caching: static blocks first, dynamic content (subtask description, user request, plan) last.

### Agent Registration

Agents are registered in-memory via the pi-subagents event bus — no temporary filesystem files. Default pi-subagents agents are disabled; only pi-pi's agents are available.

The extension intercepts Agent() tool calls and routes them to the appropriate registered agent type, injecting model and thinking settings from config.

### Subagent Context

- **explore, librarian:** Only their search prompt.
- **planner:** USER_REQUEST.md and RESEARCH.md.
- **plan-reviewer:** USER_REQUEST.md, RESEARCH.md, synthesized plan.
- **task:** USER_REQUEST.md, synthesized plan, specific subtask description.
- **code-reviewer:** USER_REQUEST.md, RESEARCH.md, synthesized plan (uses `git diff` to see changes).

---

## State & Directory Structure

All state lives in `.pp/` at the project root.

```
.pp/
├── config.json               # User config (gitignored)
├── context/                   # Injection files (committed)
│   ├── hard-rules.md
│   └── project-overview.md
├── .gitignore                 # Ignores state/ and config.json
└── state/                     # Runtime state (gitignored)
    ├── implement/
    │   └── <id>_<name>/
    │       ├── state.json
    │       ├── USER_REQUEST.md
    │       ├── RESEARCH.md
    │       ├── plans/
    │       └── reviews/
    ├── debug/
    │   └── <id>_<name>/
    └── brainstorm/
        └── <id>_<name>/
```

### state.json

```json
{
  "phase": "planning",
  "from": null,
  "description": "fix auth token expiry",
  "startedAt": "2026-04-15T12:00:00Z",
  "reviewRound": 1
}
```

Phase values: implement (`brainstorm → planning → implementation → review → done`), debug (`diagnosing → done`), brainstorm (`active → done`).

### Locking

File-based locking via `proper-lockfile` with configurable stale timeout. If a process crashes, the lock becomes stale and the next session can take over. Tasks from crashed sessions appear as "paused" on next startup — the user must explicitly `/pp:resume` to continue.

---

## Context Injection

### .pp/context/*.md

Per-file injection with YAML frontmatter:

```markdown
---
inject: system
agents: [task, codeReviewer]
---
Always use snake_case for database columns.
```

- `inject: system` — injected into the system prompt, survives compaction.
- `inject: context` — injected as a context message, may be summarized during compaction.

Targeting via `agents` (specific types) and/or `agentGroups` (`all`, `subagents`). Defaults to `main` only.

### AGENTS.md

Project's AGENTS.md is injected into the main agent's system prompt. Configurable via `injectAgentsMd`.

---

## Tool Safety

- Writes to `.pp/state/` are blocked except `*.md` files. Paths are resolved to absolute to prevent traversal bypasses.
- `state.json` and `config.json` are extension-managed only.
- `afterEdit` command templates (`${file}`, `${dir}`) are shell-escaped to prevent injection.

---

## Auto-Commit

During implementation, modified files are committed on each `turn_end` via `git add` + `git commit`. Commit messages are derived from the task description (no AI generation, no AI markers). Configurable via `autoCommit`.

---

## Hook Commands

### afterEdit

Runs after each file edit during implementation. Advisory — output is appended to the tool result for the LLM to see, but failures don't block.

```json
{ "run": "gofmt -w ${file}", "glob": ["*.go"] }
```

### afterImplement

Runs after all plan items are checked. Gate — failures block phase transition.

```json
{ "run": "go test ./..." }
```

---

## Configuration

`.pp/config.json` — gitignored, generated with defaults on first run.

Key settings:
- `mainModel` — model/thinking per command type (implement, debug, brainstorm)
- `planners`, `planReviewers`, `codeReviewers` — per-variant model configs with enable/disable
- `agents` — model/thinking for explore, librarian, task subagents
- `commands` — afterEdit (with glob), afterImplement
- `timeouts` — afterEdit, afterImplement, agentSpawn, lockStale, lockUpdate
- `autoCommit` — enable/disable auto-commit (default: true)
- `injectAgentsMd` — inject AGENTS.md into main agent (default: true)
- `usePlannotator` — use plannotator for plan/review UI (default: true)
- `maxAutoReviewRounds` — cap on automated review iterations (default: 2)

---

## Bundled Extensions

pi-pi bundles modified forks of third-party extensions in `3p/`. These are loaded instead of the npm-installed versions. On startup, the extension detects conflicting npm-installed versions and hard-fails with instructions to remove them.

Bundled:
- `pi-subagents` — modified to support in-memory agent registration and extension-only mode
- `pi-tasks` — modified to handle store upgrade in command handlers
- `pi-hashline-readmap` — modified: nu tool disabled and removed
- `pi-lsp`, `pi-ask-user`, `pi-mcp-adapter`, `pi-plannotator` — unmodified forks
