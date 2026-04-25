# pi-pi: Specification

A pi extension that orchestrates multi-phase, multi-model workflows for implementation, debugging, and brainstorming.

## Commands

All commands are prefixed with `pp:`.

### /pp:implement `<description>` [--from `<task-path>`]

Full pipeline: brainstorm → plan → implement.

`--from <task-path>` inherits USER_REQUEST.md and RESEARCH.md from a previous debug or brainstorm task. When the source is a debug task, brainstorm phase is skipped.

Starting a new task while another is active auto-finishes the old one.

### /pp:debug `<description>`

Read-only diagnosis. The agent investigates the problem using bash, git, and subagents, but does not modify project source code. Produces USER_REQUEST.md (the derived fix request) and RESEARCH.md (root cause analysis, evidence, recommended fix approach). On completion, the user can choose to start an implementation task from the diagnosis.

### /pp:brainstorm `<description>`

Open-ended conversation. Spawns explore/librarian subagents on demand. Does not modify source code. If the user asks to capture conclusions, writes USER_REQUEST.md and RESEARCH.md. On completion, the user can choose to start an implementation task if artifacts exist.

### /pp:next

Manual trigger for the phase-ending dialog. When the user picks a "continue" option (e.g. "Continue implementation", "Review on my own"), the extension prints that `/pp:next` can be used to re-open the dialog. This is also the manual override for advancing phases without the agent calling `pp_phase_complete`.

### /pp:resume

Lists all paused (non-done) tasks. User picks one to resume. The step machine resumes at the persisted step — if the task was mid-review-cycle, it picks up there.

Resume behavior:
- Resets all task-scoped state (spawned agent IDs, retry counters, nudge state, timers) before resuming
- Recreates phase task entries for progress tracking
- If resuming `await_planners`, only respawns planner variants that haven't produced output files yet (not all planners)
- If resuming a review cycle, uses phase-aware logic: plan phase uses `planReviewers`/`spawnPlanReviewers`, implement phase uses `codeReviewers`/`spawnCodeReviewers`

### /pp:done

Aborts all subagents, marks the task done, releases the lock.

### /pp:status

Shows current task info (type, phase, step, age, directory, review pass).

### /pp:review-plan

Opens the synthesized plan in Plannotator's browser UI for visual review and annotation. Requires plannotator extension to be loaded. Gracefully reports if plannotator is not available.

### /pp:review-code

Opens the code diff in Plannotator's code review browser UI. Shows committed changes (branch diff). Requires plannotator extension to be loaded.

---

## Architecture: Phases and Steps

Each task type defines a sequence of **phases**. Each phase defines a sequence of **steps**. Steps are the atomic unit of execution. The step machine advances through steps automatically — the LLM only has agency during `llm_work` steps. Everything else is system-driven.

### Step Kinds

| Kind | Who runs it | LLM involved? | Duration |
|------|-------------|----------------|----------|
| `spawn_subagents` | System | No | Instant |
| `await_subagents` | System (event-driven) | No | Seconds to minutes |
| `llm_work` | LLM agent | Yes | Variable |
| `user_gate` | System (UI dialog) | No | Until user responds |
| `external_gate` | System (Plannotator) | No | Until user responds |

On session restore, the system reads `phase` + `step` from state.json and resumes the correct behavior. If the step is `await_subagents`, the system checks subagent state — it does not prompt the LLM. If the step is `llm_work`, it injects artifacts and prompts the LLM. If the step is `user_gate`, it re-shows the dialog.

### Review Cycles

Review cycles are nested sequences within a phase. They are tracked separately in state.json as a `reviewCycle` object. A review cycle runs its own step sequence, then returns to the parent phase's `user_gate` step.

Review cycle kinds:
- `auto` — spawn reviewer subagents, await, LLM applies feedback
- `auto-deep` — same but with higher thinking levels
- `plannotator` — open Plannotator, await user verdict

The `reviewPass` counter tracks how many review cycles have completed within a phase. Dialog options show the pass number: "Automatic review (pass 2)", "Automatic deep review (pass 3)", etc.

---

## Implement Flow

### Phase: brainstorm

**Goal:** Produce USER_REQUEST.md and RESEARCH.md — complete enough for downstream agents.

Steps:
```
llm_work       — research, spawn explore/librarian subagents, produce USER_REQUEST.md + RESEARCH.md
user_gate      — dialog options (see below)
```

User gate options:
- **"Approve brainstorm"** → transition to plan phase
- **"Continue brainstorming"** → return to llm_work, print "/pp:next to advance"

RESEARCH.md follows a structured template: Affected Code, Architecture Context, Constraints & Edge Cases, Open Questions, Recommended Approach.

### Phase: plan

**Goal:** Produce a synthesized plan in `plans/<timestamp>_synthesized.md`.

Steps:
```
spawn_planners   — auto-spawn all enabled planner subagents
await_planners   — block until all planners complete (no LLM)
synthesize       — LLM reads planner outputs, synthesizes single plan
user_gate        — dialog options (see below)
```

User gate options:
- **"Approve plan"** → transition to implement phase
- **"Automatic review"** / **"Automatic review (pass N)"** → enter review cycle (auto)
- **"Automatic deep review"** / **"Automatic deep review (pass N)"** → enter review cycle (auto-deep)
- **"Review in Plannotator"** → enter review cycle (plannotator)
- **"Review on my own"** → return to synthesize step, print "/pp:next to advance"
- **"Continue planning"** → return to synthesize step, print "/pp:next to advance"

Review cycle (auto / auto-deep):
```
spawn_reviewers   — spawn plan reviewer subagents
await_reviewers   — block until complete
apply_feedback    — LLM synthesizes feedback, revises plan
→ reviewCycle = null, return to user_gate
```

Review cycle (plannotator):
```
await_result      — open Plannotator, block until user responds
→ if approved: transition to implement phase
→ if denied: apply_feedback (LLM applies feedback) → return to user_gate
```

Multiple planner subagents run in parallel (opus, gpt, gemini — each configurable/disablable). Each reads USER_REQUEST.md and RESEARCH.md and writes its own plan. The main agent is a SYNTHESIZER — it must NOT write its own plan from scratch.

Plans use checkboxes for progress tracking. They describe *what* to do, not *how* at the code level.

### Phase: implement

**Goal:** Execute the plan, review the implementation, iterate until approved.

Steps:
```
llm_work       — implement plan items, delegate subtasks, commit
user_gate      — dialog options (see below)
```

User gate options:
- **"Approve implementation"** → run afterImplement commands, transition to done
- **"Automatic review"** / **"Automatic review (pass N)"** → enter review cycle (auto)
- **"Automatic deep review"** / **"Automatic deep review (pass N)"** → enter review cycle (auto-deep)
- **"Review in Plannotator"** → enter review cycle (plannotator)
- **"Review on my own"** → return to llm_work, print "/pp:next to advance"
- **"Continue implementation"** → return to llm_work, print "/pp:next to advance"

Review cycle (auto / auto-deep):
```
spawn_reviewers   — spawn code reviewer subagents
await_reviewers   — block until complete
apply_feedback    — LLM synthesizes reviews, implements fixes
→ reviewCycle = null, return to user_gate
```

Review cycle (plannotator):
```
await_result      — open Plannotator, block until user responds
→ if approved: transition to done
→ if denied: apply_feedback (LLM fixes) → return to user_gate
```

The main agent implements the plan, checking off items as it completes them. Subtasks can be delegated to task subagents. LSP diagnostics run on each edit. `afterEdit` commands (formatters, type checkers) run after each file change — advisory, not blocking. If a fix fails 3 times, the agent stops and re-plans the approach.

When all items are checked, the agent calls `pp_phase_complete`. On "Approve implementation", `afterImplement` commands run (full test suite, linters) — these ARE gates, failures block the transition.

### Phase Transitions

Phase transitions are triggered either by the `pp_phase_complete` tool (agent-initiated, user-approved via dialog) or by `/pp:next` (manual override).

On transition, the extension:
1. Validates exit criteria (required files exist, plan items checked, etc.)
2. Runs `afterImplement` commands if leaving implement phase
3. Aggressively compacts the conversation context
4. Re-injects task artifacts (USER_REQUEST.md, RESEARCH.md, synthesized plan) as fresh messages
5. Auto-advances through non-LLM steps (spawn, await) before giving control to the LLM

During long phases, pi's auto-compaction may trigger. When it does, artifacts are re-injected after compaction to ensure they're never lost.

On task start and resume, the configured model is set. If the model isn't found, a warning is shown and the current model is used as fallback.

---

## Debug Flow

### Phase: debug

Steps:
```
llm_work       — read-only diagnosis, explore/librarian subagents, produce USER_REQUEST.md + RESEARCH.md
user_gate      — dialog options (see below)
```

User gate options:
- **"Implement a fix"** → creates new implement task with --from, starts at plan phase
- **"Continue debugging"** → return to llm_work, print "/pp:next to advance"
- **"Finish debugging"** → transition to done

The agent investigates with bash access but no source code modification. Spawns explore/librarian subagents as needed.

---

## Brainstorm Flow

### Phase: brainstorm

Steps:
```
llm_work       — open-ended conversation, optionally produce artifacts
user_gate      — dialog options (see below)
```

User gate options:
- **"Start implementation"** → creates new implement task with --from, starts at plan phase (only shown if USER_REQUEST.md + RESEARCH.md exist)
- **"Continue brainstorming"** → return to llm_work, print "/pp:next to advance"
- **"Finish brainstorming"** → transition to done

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
  "phase": "implement",
  "step": "llm_work",
  "reviewCycle": null,
  "reviewPass": 0,
  "from": null,
  "description": "fix auth token expiry",
  "startedAt": "2026-04-15T12:00:00Z"
}
```

Phase values by task type:
- implement: `brainstorm → plan → implement → done`
- debug: `debug → done`
- brainstorm: `brainstorm → done`

Step values are descriptive strings (e.g. `"llm_work"`, `"await_planners"`, `"user_gate"`, `"spawn_reviewers"`). The step machine in code defines transitions; state.json only records the current position.

When `reviewCycle` is non-null, the system is inside a review cycle:

```json
{
  "phase": "implement",
  "step": "user_gate",
  "reviewCycle": { "kind": "auto-deep", "step": "await_reviewers", "pass": 2 },
  "reviewPass": 1
}
```

`reviewPass` counts completed review cycles. `reviewCycle` is only present during an active cycle — once the cycle finishes, it becomes null and `reviewPass` increments.

### Exit Criteria

Validated before every phase transition:

| Phase | Criteria |
|-------|----------|
| brainstorm (implement) | USER_REQUEST.md and RESEARCH.md exist and are non-empty |
| plan | Synthesized plan exists in plans/ |
| implement | All plan checkboxes checked (no `- [ ]` remaining) |
| debug | USER_REQUEST.md and RESEARCH.md exist and are non-empty |
| brainstorm (brainstorm task) | Always passes |

### Locking

File-based locking via `proper-lockfile` with configurable stale timeout. If a process crashes, the lock becomes stale and the next session can take over. Tasks from crashed sessions appear as "paused" on next startup — the user must explicitly `/pp:resume` to continue.

---

## Subagents

### Agent Types

| Agent | Purpose | Who spawns it | Tools |
|-------|---------|---------------|-------|
| explore | Internal codebase search | LLM via Agent() | read, grep, find, ls, bash, lsp, ast_search, cbm_*, exa_* |
| librarian | External docs research | LLM via Agent() | read, grep, find, bash, exa_search, exa_fetch |
| task | Delegated implementation subtask | LLM via Agent() | all (read, write, edit, bash, grep, find, ls, lsp, ast_search, cbm_*, exa_*) |
| planner | Creates plans from requirements | Extension on plan phase entry | read, grep, find, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |
| plan-reviewer | Validates plan executability | Extension on demand | read, grep, find, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |
| code-reviewer | Reviews implementation diffs | Extension on demand | read, grep, find, ls, bash, write (restricted), lsp, ast_search, cbm_*, exa_* |

Planner, plan-reviewer, and code-reviewer have per-model variants (opus, gpt, gemini), each independently configurable/disablable.

All subagents can spawn explore/librarian for additional context. Task subagents cannot spawn other task subagents (no recursion).

### Code Intelligence Tools

The extension hardcodes three code intelligence tool suites, always available without configuration:

**CBM (codebase-memory-mcp)** — Graph-based code knowledge engine. Runs as a persistent daemon (JSON-RPC over stdio). Binary at `~/.local/bin/codebase-memory-mcp`. Auto-indexes the workspace on first use. Background file watcher keeps the index fresh as code changes.

| Tool | Purpose |
|------|---------|
| cbm_search | Natural-language BM25, regex, or semantic vector search across indexed symbols |
| cbm_search_code | Graph-augmented grep — deduplicates matches into containing functions |
| cbm_trace | Call chain traversal (inbound/outbound) by function name |
| cbm_changes | Git diff → affected symbols + blast radius |
| cbm_query | Cypher-like graph queries for multi-hop patterns |
| cbm_architecture | High-level codebase structure overview |

**LSP (via pi-lsp)** — Compiler-grade semantic analysis. Zero false positives. Supports goToDefinition, findReferences, hover, goToImplementation, documentSymbol, workspaceSymbol, incomingCalls, outgoingCalls, diagnostics, codeActions.

**ast-grep** — AST-aware structural pattern matching via the `ast_search` tool. Registered directly by the orchestrator extension (wraps the `sg` binary). Finds code shapes (e.g. `if err != nil { $$$ }`, `go $FUNC($$$)`) rather than text.

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

### Phase Completion Tool

The `pp_phase_complete` tool is the primary mechanism for triggering the user gate. When the agent calls it with a summary, the extension shows an interactive dialog with phase-appropriate options (see each phase's user gate section above).

On approval, the extension validates exit criteria and transitions automatically — no manual `/pp:next` needed.

### Commit Tool

The `pp_commit` tool lets the agent commit modified files during implementation. Takes a commit message. Only works when `autoCommit` is enabled in config and there are tracked modified files. On commit, the modified files set is cleared.

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

Project's AGENTS.md is injected into the main agent's system prompt.

---

## Tool Safety

- Writes to `.pp/state/` are blocked except `*.md` files. Paths are resolved to absolute to prevent traversal bypasses.
- `state.json` and `config.json` are extension-managed only.
- `afterEdit` command templates (`${file}`, `${dir}`) are shell-escaped to prevent injection.
- Phase prompts include FORBIDDEN blocks that instruct agents not to overstep their role (e.g. planning agent must not write own plan, review agent must not write own review).

---

## Auto-Continuation

### API Error Retry

When the agent's turn ends with an API error (provider timeout, rate limit, JSON parse error), the extension retries with exponential backoff:

- Attempt 1: wait 2s, then send continuation message
- Attempt 2: wait 6s
- Attempt 3: wait 24s
- After 3 failures: stop retrying, notify user

Retry timers are cancelled on task switch/done to prevent stale retries from firing into a different task. Each retry is guarded by a task token — if the active task changes before the timer fires, the retry is silently discarded.

On any successful turn, the retry counter resets to 0.

### Empty-Turn Auto-Continuation

When the agent's turn ends with an empty response (content filter, timeout, rate limit), the extension automatically sends a continuation nudge:

- Up to 3 empty turns in 60 seconds: instant nudge
- 5th empty turn in 60 seconds: notify user, wait 60 seconds, then nudge (resets window)
- 5 cooldown cycles in 20 minutes: halt nudging, notify user
- Any user message resumes nudging

Cooldown nudge timers are guarded by the task token — stale timers from a previous task are discarded.

---

## Concurrency Safety

Several mechanisms prevent race conditions and stale state mutations:

- **Task token** — An incrementing counter (`activeTaskToken`) is assigned on each `startTask`/`resume`. All deferred callbacks (retry timers, cooldown nudges) capture the token and verify it before executing. Stale callbacks from a previous task are silently discarded.
- **Review transition guard** — A `reviewTransitionToken` prevents both the event-driven completion handler and the 5s poller from independently transitioning `await_reviewers → apply_feedback`. Only the first to fire performs the transition.
- **User-gate reentrancy** — A `userGatePending` flag prevents overlapping `runUserGateDialog()` calls. Concurrent invocations (e.g. from `pp_phase_complete` and `/pp:next`) return immediately while a dialog is already open.
- **Subagent failure handling** — When all planners or reviewers fail, the system checks for actual output files before transitioning. Zero output files → sends a manual-work fallback message instead of falsely claiming "all completed."
- **Spawn no-op detection** — Spawn functions return `{ spawned: number }`. When prerequisites are missing and nothing is spawned, `pendingSubagentSpawns` is reset to prevent the system from waiting indefinitely.
- **Task-scoped state reset** — `resetTaskScopedState()` clears all mutable per-task state (spawned agent IDs, descriptions, retry/nudge/cooldown counters, timers, phase task IDs) on task start, resume, and cleanup.

---

## Plannotator Integration

Plannotator provides visual browser-based review for plans and code. It is an optional separate extension loaded alongside pi-pi.

Integration is via the event API (`plannotator:request` / `plannotator:review-result`), not through plannotator's own tool or commands. When plannotator is loaded:
- `/pp:review-plan` opens the synthesized plan in the browser
- `/pp:review-code` opens the code diff in the browser
- `pp_phase_complete` dialog includes "Review in Plannotator" option
- Plannotator approval/denial with user feedback is forwarded to the agent as a steer message

When plannotator is not loaded, these features gracefully degrade with a "not installed" notification.

Phase prompts explicitly forbid the `plannotator_submit_plan` tool to prevent confusion — plannotator is accessed only through the orchestrator's event API.

---

## Hook Commands

### afterEdit

Runs after each file edit during implementation. Advisory — output is appended to the tool result for the LLM to see, but failures don't block.

```json
{ "run": "gofmt -w ${file}", "glob": ["*.go"] }
```

### afterImplement

Runs after all plan items are checked and user approves implementation. Gate — failures block phase transition.

```json
{ "run": "go test ./..." }
```

---

## Configuration

Config is loaded by merging three layers: defaults → global config → project config. Global config lives at `~/.pi/agent/extensions/pp/config.json` (resolved via `getAgentDir()`). Project config lives at `.pp/config.json` (gitignored). Both are optional.

Key settings:
- `mainModel` — model/thinking per command type (implement, debug, brainstorm)
- `planners`, `planReviewers`, `codeReviewers` — per-variant model configs with enable/disable
- `agents` — model/thinking for explore, librarian, task subagents

Valid `thinking` values: `"off"`, `"low"`, `"medium"`, `"high"`. Invalid values (e.g. `"xhigh"`) are normalized to `"high"` at runtime.
- `commands` — afterEdit (with glob), afterImplement
- `timeouts` — afterEdit, afterImplement, agentSpawn, lockStale, lockUpdate
- `autoCommit` — enable/disable pp_commit tool (default: true)

---

## Bundled Extensions

pi-pi bundles modified forks of third-party extensions in `3p/`. These are loaded instead of the npm-installed versions. On startup, the extension detects conflicting npm-installed versions and hard-fails with instructions to remove them.

Bundled:
- `pi-subagents` — modified to support in-memory agent registration and extension-only mode
- `pi-tasks` — modified to handle store upgrade in command handlers
- `pi-hashline-readmap` — provides hash-line read/write/edit tools with content-addressable anchors
- `pi-lsp`, `pi-ask-user`, `pi-mcp-adapter`, `pi-plannotator` — forks with type fixes
