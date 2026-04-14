# pi-pi: Specification

A pi agent extension that orchestrates multi-phase, multi-model workflows for implementation, debugging, and brainstorming.

## Dependencies

- `@dreki-gg/pi-lsp` — LSP diagnostics
- `pi-hashline-readmap` — Line-addressable file reads
- `@tintinweb/pi-subagents` — In-process subagent spawning via EventBus RPC + LLM-callable `Agent(...)` tool
- `@tintinweb/pi-tasks` — Task tracking with visual widget for orchestration phase feedback
- `@plannotator/pi-extension` — Plan/review annotation UI
- `pi-mcp-adapter` — MCP server bridge
- `pi-ask-user` — User question dialogs
- `proper-lockfile` — Cross-platform file locking

---

## Commands

All commands are prefixed with `pp:`.

### /pp:implement

Full pipeline: brainstorm → planning → implementation → review. Main agent: Opus 4.6 (configurable).

Accepts `--from <task-id>` to inherit artifacts from a previous debug or brainstorm task. When `--from` is used with a debug task, the brainstorm phase is skipped and USER_REQUEST.md and RESEARCH.md are copied from the debug task. When used with a brainstorm task, USER_REQUEST.md and RESEARCH.md are copied as initial context for the brainstorm phase.

Starting `/pp:implement` while another task is active is an error. The user must first run `/pp:done` to finish the current task.

### /pp:debug

Read-only diagnosis. Main agent: GPT 5.4 high reasoning (configurable). The agent has bash access for running commands, git operations, and creating temporary reproduction files, but does not modify project source code (no `write` or `edit` tools). Produces USER_REQUEST.md and RESEARCH.md (root cause analysis, evidence, recommended fix approach). When the user runs `/pp:done`, the hint message suggests the `/pp:implement --from` command to continue with a fix.

### /pp:brainstorm

Open-ended conversation. Main agent: Opus 4.6 (configurable). No phases, no required output. Spawns explore/librarian subagents on demand for research. Does not modify source code. If the user asks to capture conclusions, writes USER_REQUEST.md (what the user wants) and RESEARCH.md (findings, context, open questions) in the task's state directory. These are optional — not produced unless the user asks.

### /pp:next

Validates the current phase's exit criteria and transitions to the next phase. Both the LLM and the user can invoke this command.

Behavior per phase:

- **Brainstorm exit**: Checks USER_REQUEST.md and RESEARCH.md exist and are non-empty. If met, transitions to planning via `newSession()` with artifact injection, followed by `sendUserMessage()` with the phase prompt.
- **Planning exit**: Checks synthesized plan exists. Asks user for approval via `ask_user` (or plannotator if available). If approved, transitions to implementation.
- **Implementation exit**: Checks all checkboxes in the synthesized plan are checked. Runs `afterImplement` commands. If all pass, transitions to review.
- **Review exit**: Presents review summary. Asks user for approval. If approved, marks task done.

If exit criteria are not met, the command reports what's missing and does not transition.

### /pp:resume

Lists all non-done tasks across all types (implement, debug, brainstorm) with their phase and age. User picks one to resume. The selected task is locked and the agent continues from where it left off, with relevant artifacts re-injected.

### /pp:done

Aborts any running LLM stream and all spawned subagents, marks the current task as done, releases the lock, and resets context (re-injecting only AGENTS.md and `.pp/context/` files). Must be run before starting a new task. Subagents are aborted via `subagents:rpc:stop` for each tracked agent ID. Transitioning to done via `/pp:next` (e.g. from review) also aborts all subagents before cleanup.

When finishing a brainstorm or debug task, if USER_REQUEST.md and RESEARCH.md exist, prints a hint:

```
Task 'rate-limiting' completed.
Artifacts saved. To continue with implementation, run:
  /pp:implement --from brainstorm/c8b4a9d1e7f3_rate-limiting
```

### /pp:status

Shows current task type, phase, task directory, and age. If no active task, says so.

---

## /pp:implement Flow

### Phase Transitions

Between phases, the extension calls `newSession()` with a `setup` callback to create a clean context. The `setup` callback uses `sm.appendMessage()` to inject the relevant task artifacts (USER_REQUEST.md, RESEARCH.md, synthesized plan) and `context`-mode `.pp/context/*.md` files into the fresh session as historical messages. After `newSession()` returns, the extension sends the phase-specific prompt via `pi.sendUserMessage()` to trigger the first LLM turn. The `before_agent_start` handler adds phase-specific system prompt snippets, `system`-mode context files, and AGENTS.md (if `injectAgentsMd` is enabled). This is a full reset — no summarization, no leftover context from the previous phase.

On task start and resume, the extension calls `pi.setModel()` and `pi.setThinkingLevel()` to switch to the configured model for the command type (e.g. Opus for implement, GPT for debug). If the configured model is not found in the registry, a warning is shown and the current model is used as fallback.

Phase transitions are triggered by the `/pp:next` command. The LLM is instructed to call `/pp:next` when it believes the phase is complete. The user can also call `/pp:next` at any time to manually push the pipeline forward (or unstick a stuck LLM). The extension validates exit criteria regardless of who invoked the command.

### Mid-Phase Compaction

During long phases (especially implementation), context may fill up. When pi triggers auto-compaction, the extension hooks into `session_before_compact` and re-injects the full contents of the current task's key artifacts (USER_REQUEST.md, RESEARCH.md, the synthesized plan as applicable) as a fresh message after the compacted summary. This preserves the summarized conversation history while ensuring critical artifacts are never lost.

### Phase 1: Brainstorm

**Goal:** Produce USER_REQUEST.md and RESEARCH.md — complete enough that downstream agents can work without re-exploring the codebase or re-interviewing the user.

**How it works:**

1. The main agent interviews the user via pi-ask-user to clarify requirements.
2. It spawns explore and librarian subagents via the `Agent(...)` tool for codebase and external research (via subagents to avoid polluting the main agent's context with raw search results). Results flow back to the main agent, which writes relevant findings into RESEARCH.md.
3. During research, the agent may ask the user additional questions.
4. The agent updates USER_REQUEST.md and RESEARCH.md as many times as needed. Open questions go into a section at the bottom of RESEARCH.md with checkboxes.
5. The agent must not modify any files except `.md` files in the task's state directory.
6. Once both files are produced, the agent calls `/pp:next`.

**Phase exit:** USER_REQUEST.md and RESEARCH.md exist and are non-empty. `/pp:next` validates this, calls `newSession()` to inject artifacts, then `sendUserMessage()` with the planning phase prompt.

### Phase 2: Planning

**Goal:** Produce a final synthesized plan in `plans/<timestamp>_synthesized.md`.

**How it works:**

1. Fresh context via `newSession()`. USER_REQUEST.md, RESEARCH.md, and `context`-mode files are injected as historical messages. The planning phase prompt is sent via `sendUserMessage()`.
2. The extension spawns four planner subagents in parallel via EventBus RPC (opus, gpt, gemini, grok — each configurable, any can be disabled). Each reads USER_REQUEST.md and RESEARCH.md (injected by the agent factory into the system prompt). Each writes its own plan to `plans/<timestamp>_<variant>.md`. Planners cannot see each other's output. They can spawn explore/librarian subagents via `Agent(...)` if they need additional context.
3. The main agent also builds its own plan.
4. The main agent reads all plans, synthesizes them into `plans/<timestamp>_synthesized.md`, asking the user for clarifications if unsure.
5. The user reviews the plan via plannotator (if `usePlannotator` is true in config; otherwise plain text). The main agent fixes it if needed.
6. Optionally, the user is asked if they want a deep review of the plan by a plan-reviewer (GPT 5.4 xhigh). If yes, the extension spawns plan-reviewer subagents via EventBus RPC. The reviewer reads USER_REQUEST.md, RESEARCH.md, individual plans, and the synthesized plan, then provides feedback.
7. The LLM or user calls `/pp:next`. The extension asks for user approval before transitioning.

**Plan format:** Plans use checkboxes for progress tracking. Plans should describe *what* needs to be done, not *how* at the code level. No code snippets, no line-by-line instructions. Example: "Rate limiter middleware must expose a configurable concurrency limit; default 10, 0 means default, 1 means sequential."

**Phase exit:** Synthesized plan exists. User approves via `/pp:next`. `newSession()` is called to inject USER_REQUEST.md, RESEARCH.md, synthesized plan, and `context`-mode files as historical messages. The implementation phase prompt is sent via `sendUserMessage()`.

### Phase 3: Implementation

**Goal:** Execute the plan.

**How it works:**

1. Fresh context via `newSession()`. USER_REQUEST.md, RESEARCH.md, synthesized plan, and `context`-mode files are injected as historical messages. The implementation phase prompt is sent via `sendUserMessage()`.
2. The main agent implements the plan, checking off tasks in the synthesized plan as it completes them.
3. Subtasks can be delegated to task subagents via the `Agent(...)` tool (full tool access, matching main agent model). Task subagents can spawn explore and librarian subagents for context but cannot spawn other task subagents.
4. LSP diagnostics run on each edited file (via pi-lsp).
5. After each file edit, `afterEdit` commands run — **advisory** (formatters, type checkers, fast linters — configured in config.json, filtered by glob). Output is appended to the tool result so the LLM sees it, but failures do not block. The LLM decides whether to fix issues now or defer. These are run by the extension via `tool_result` event handler on successful `edit`/`write` calls.
6. Auto-commit: after completing a plan checkpoint and `afterEdit` commands pass, the extension commits via `git add` + `git commit`. Commit message is derived from the plan checkpoint text (no LLM generation). No AI markers. Commits are squashable. Configurable (`autoCommit: true` by default).
7. After all plan items are checked off, `afterImplement` commands run (full test suite, all linters).

**Phase exit:** All checkboxes in the synthesized plan are checked. `afterImplement` commands pass (these ARE gates — failures block the transition). Triggered by `/pp:next`.

### Phase 4: Review

**Goal:** Validate the implementation via automated multi-model review, then manual user review.

**How it works:**

1. The user is asked: manual review only, normal auto-review (default), or extra deep auto-review. Extra deep uses higher thinking levels for the reviewer models (e.g. GPT 5.4 xhigh instead of medium).
2. If auto-review: the extension spawns code-reviewer subagents in parallel via EventBus RPC (opus, gpt, gemini, grok — configurable). Each reads USER_REQUEST.md, RESEARCH.md, the synthesized plan (injected by the agent factory). Each writes to `reviews/<timestamp>_<variant>_round-N.md`. Code-reviewers can spawn explore/librarian subagents via `Agent(...)` if they need additional context.
3. The main agent reads all reviews, synthesizes into `reviews/<timestamp>_final_round-N.md`, presents to the user via plannotator (if `usePlannotator` is true in config; otherwise plain text).
4. If changes are needed: the main agent creates a separate fix plan at `plans/<timestamp>_<description>.md` (e.g. `1776256000_fix-error-handling.md`). The original synthesized plan is never modified — it remains the source of truth for the original approved plan. The user reviews the fix plan (plannotator if configured). Then the flow loops back to implementation (context is NOT reset — the agent retains implementation context). `afterImplement` commands run after fixes. A new review round begins.
5. Auto-review rounds are capped by `maxAutoReviewRounds` (default 2). The current round is persisted to `state.json` (`reviewRound` field) so it survives session restarts. After exhausting rounds, the extension automatically switches to manual review and notifies the user.
6. The user reviews diffs manually (plannotator if configured).
7. If the user is not satisfied, the review phase loops again.

**Phase exit:** User approves the final state via `/pp:next`. Task marked done.

---

## /pp:debug Flow

1. Main agent (GPT 5.4, high reasoning) investigates the problem. Has bash access for running commands, git operations, and creating temp reproduction files, but no `write` or `edit` tools — source code is not modified.
2. Spawns explore and librarian subagents via `Agent(...)` as needed.
3. Produces USER_REQUEST.md (the fix request derived from diagnosis) and RESEARCH.md (root cause analysis, evidence, recommended fix approach).
4. When the user runs `/pp:done`, the extension prints a hint: `/pp:implement --from debug/<task-id>`. Running that command copies USER_REQUEST.md and RESEARCH.md from the debug task into the new implement task, skips brainstorm, and sets `"from": "<debug-task-id>"` in state.json.

---

## /pp:brainstorm Flow

Open-ended conversation with the user. No phases, no state machine. The agent explores ideas, analyzes tradeoffs, and discusses approaches. Spawns explore/librarian via `Agent(...)` on demand for research. Does not modify source code. If the user asks to capture conclusions, writes USER_REQUEST.md (what the user wants) and RESEARCH.md (findings, context, open questions) in the task's state directory. Can later feed into `/pp:implement --from <brainstorm-task>`.

---

## Tools

pi-pi registers **zero custom tools**. The LLM uses tools provided by other extensions:

- **pi-mono built-in tools**: read, write, edit, bash, grep, find, ls
- **`Agent(...)`** from `@tintinweb/pi-subagents`: spawn explore, librarian, and task subagents on demand
- **`get_subagent_result(...)`** from `@tintinweb/pi-subagents`: poll background agent results
- **`ask_user`** from `pi-ask-user`: LLM-callable user clarification dialogs during agent turns (rich multi-select, searchable options, descriptions). For extension-code-initiated dialogs (not during agent turns), use pi-mono's built-in `ctx.ui.select/confirm/input` instead.
- **`lsp`** from `@dreki-gg/pi-lsp`: diagnostics after edits
- **`plannotator_submit_plan`** from `@plannotator/pi-extension`: plan/review annotation UI (optional)
- **`TaskCreate`**, **`TaskUpdate`**, **`TaskGet`**, **`TaskList`** from `@tintinweb/pi-tasks`: visible task tracking for orchestration phases. The extension creates tracking tasks on `/pp:implement` start (one per phase: brainstorm, planning, implementation, review) and updates their status as phases transition. Gives the user a persistent visual overview of pipeline progress. **Note:** pi-tasks does not expose a programmatic API (no globalThis/Symbol.for, no RPC for CRUD). Task creation/updates are triggered via steering messages that instruct the LLM to call the TaskCreate/TaskUpdate tools.

The extension controls behavior exclusively through **slash commands** (`/pp:*`) and **event handlers** (`tool_call`, `tool_result`, `before_agent_start`, `session_start`, `session_before_compact`, `turn_end`).

---

## Subagent Spawning

Two spawning paths, depending on who triggers the spawn:

### LLM-Driven Spawning

The main agent (and task/planner/reviewer subagents) can spawn explore, librarian, and task subagents using the `Agent(...)` tool provided by `@tintinweb/pi-subagents`. The LLM decides when to spawn these based on its needs.

The extension writes custom agent definition `.md` files to `.pi/agents/` at task creation time (explore, librarian, task). It also intercepts all `Agent(...)` tool calls via the `tool_call` event handler, remapping `subagent_type` to the custom `pp_<taskId>_*` names and injecting `model` and `thinking` from config. This ensures LLM-spawned agents always use our custom definitions (prompts, tools, `prompt_mode: replace`) instead of the built-in pi-subagents defaults.

### Extension-Driven Spawning

The extension spawns planner, plan-reviewer, and code-reviewer subagents programmatically via EventBus RPC:

```typescript
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "pp_<taskId>_planner_opus",
  prompt: "...",
  options: { run_in_background: true }
});
// Reply on: subagents:rpc:spawn:reply:<requestId>
// Completion on: subagents:completed (filtered by agent ID)
```

These spawns are invisible to the LLM. The extension spawns them on phase entry, collects results via `subagents:completed` events, and writes output files. The LLM then reads the output files.

### Subagent discovery

The extension listens for the `subagents:ready` event to confirm pi-subagents is loaded and RPC handlers are registered before attempting any RPC spawns.

### Routing

The main agent can spawn explore/librarian in any phase via `Agent(...)`. During implementation, the main agent can additionally spawn task subagents. Planners, plan-reviewers, and code-reviewers can spawn explore/librarian via `Agent(...)` for additional research. Task subagents can spawn explore/librarian but not other task subagents (no recursion).

### User Questions from Subagents

Subagents cannot directly interact with the user (no UI access). If a subagent needs clarification, it returns the question in its result text. The orchestrator relays it to the user via the main session's ask tool, then respawns or steers the subagent with the answer.

### Subagent Context

The factory function controls what each subagent sees:

- **explore, librarian:** Only their search prompt. No task artifacts.
- **planner:** USER_REQUEST.md and RESEARCH.md contents (injected by factory into system prompt). Told exactly which file to write output to. `.pp/context/*.md` files targeting `planner` agents are injected.
- **plan-reviewer:** USER_REQUEST.md, RESEARCH.md, and the latest synthesized plan. For initial review: the synthesized plan. For reviews after fix rounds: the synthesized plan + the latest fix plan. Individual planner outputs are not included. `.pp/context/*.md` files targeting `planReviewer` agents are injected.
- **task:** USER_REQUEST.md and the synthesized plan for broader context, plus the specific subtask description. `.pp/context/*.md` files targeting `task` agents are injected.
- **code-reviewer:** USER_REQUEST.md, RESEARCH.md, the synthesized plan. Uses `git diff` to see changes. `.pp/context/*.md` files targeting `codeReviewer` agents are injected.

---

## Agent Registry

Six agent types, all defined as TypeScript factory functions.

### explore

Internal codebase search. Single cheap model. Read-only. Can be spawned by the main agent in any phase, by task subagents, and by planners/plan-reviewers/code-reviewers. Spawned by the LLM via `Agent(...)`.

Tools: read, grep, find, ls, bash.

### librarian

External docs and library research. Single medium model. Read-only. Can be spawned by the main agent in any phase, by task subagents, and by planners/plan-reviewers/code-reviewers. Spawned by the LLM via `Agent(...)`.

Tools: read, grep, find, bash.

### planner

Creates a plan from USER_REQUEST.md and RESEARCH.md. Per-model variants: opus, gpt, gemini, grok (each independently configurable/disablable). Can spawn explore/librarian subagents via `Agent(...)` if RESEARCH.md is insufficient. Spawned by the extension via EventBus RPC on planning phase entry.

Tools: read, grep, find, bash, write (path-restricted to `.pp/state/**/*.md` — enforced by system prompt, not frontmatter).

### plan-reviewer

Validates plan executability. Blocker-finder, not perfectionist — approves by default, rejects only for critical blockers (max 3). Variants: opus, gpt. Can spawn explore/librarian subagents via `Agent(...)`. Spawned by the extension via EventBus RPC.

Tools: read, grep, find, bash, write (path-restricted to `.pp/state/**/*.md` — enforced by system prompt).

### task

Delegated implementation subtask. For parallelizable, self-contained work (e.g., "write tests for rate limiter" while the main agent continues implementing other items). Single model matching the main agent. Full tool access. Can spawn explore and librarian subagents for context but cannot spawn other task subagents (no recursion — enforced by system prompt). Spawned by the LLM via `Agent(...)`.

Tools: all.

### code-reviewer

Reviews implementation diffs for bugs. Per-model variants: opus, gpt, gemini, grok (each independently configurable/disablable). Can spawn explore/librarian subagents via `Agent(...)` for deeper investigation. Spawned by the extension via EventBus RPC on review phase entry.

Tools: read, grep, find, ls, bash, write (path-restricted to `.pp/state/**/*.md` — enforced by system prompt).

---

## Agent Definitions

Agents are defined as TypeScript factory functions — no static `.md` files in the repo. Each function (e.g. `createPlannerAgent(variant, config, taskArtifacts)`) returns `{ frontmatter, prompt }` — the YAML frontmatter fields and system prompt body.

System prompts are assembled in code: TypeScript functions compose sections from structured metadata (role description, constraints, output format, injected context from task artifacts). No template engine — string building with conditionals.

### Agent `.md` files

All agent types (explore, librarian, task, planner, plan-reviewer, code-reviewer) are written to `.pi/agents/pp_<taskId>_<agentType>.md` (or `pp_<taskId>_<agentType>_<variant>.md` for multi-variant agents) at task creation time. These use `@tintinweb/pi-subagents` frontmatter format with `prompt_mode: replace`:

```yaml
---
description: Codebase explorer (pi-pi)
tools: read, bash, grep, find, ls
model: google/gemini-3.1-flash
thinking: low
max_turns: 20
prompt_mode: replace
---
```

The `pp_<taskId>_` prefix uses a random UUID-based ID (not a timestamp), ensuring no collisions between concurrent pi instances even if started in the same second.

Built-in pi-subagents agents (Explore, Plan, general-purpose) are **never used directly**. The extension's `tool_call` handler intercepts every `Agent(...)` call and remaps the `subagent_type` to the corresponding `pp_<taskId>_*` name. This ensures our custom prompts, tools, and `prompt_mode: replace` are always used instead of the built-in defaults.

Routing in the `tool_call` handler:
- LLM passes `"Explore"` or omits type → remapped to `pp_<taskId>_explore` (explore model)
- LLM passes `"Librarian"` → remapped to `pp_<taskId>_librarian` (librarian model)
- LLM passes anything else (e.g. `"Task"`) → remapped to `pp_<taskId>_task` (task model)

The handler also injects `model` and `thinking` from config on every call.

Cleanup: all `pp_<taskId>_*.md` files are deleted from `.pi/agents/` when the task completes (`/pp:done`).

---

## State & Directory Structure

All state lives in `.pp/` at the project root.

### Layout

```
.pp/
├── config.json               # User config (gitignored — contains machine-specific provider names)
├── context/                   # Injection files (committed)
│   ├── hard-rules.md
│   ├── project-overview.md
│   └── codestyle.md
├── .gitignore                 # Ignores state/ and config.json
└── state/                     # Runtime state (gitignored)
    ├── implement/
    │   └── a3f2b1c9d0e4_fix-auth/
    │       ├── state.json
    │       ├── USER_REQUEST.md
    │       ├── RESEARCH.md
    │       ├── plans/
    │       │   ├── 1776255600_opus.md
    │       │   ├── 1776255600_gpt.md
    │       │   ├── 1776255600_gemini.md
    │       │   ├── 1776255600_grok.md
    │       │   ├── 1776255600_synthesized.md
    │       │   └── 1776256000_fix-error-handling.md
    │       └── reviews/
    │           ├── 1776255800_opus_round-1.md
    │           ├── 1776255800_gpt_round-1.md
    │           ├── 1776255800_gemini_round-1.md
    │           ├── 1776255800_grok_round-1.md
    │           ├── 1776255800_final_round-1.md
    │           ├── 1776256100_opus_round-2.md
    │           └── 1776256100_final_round-2.md
    ├── debug/
    │   └── e5d7f2a1b3c6_auth-bug/
    │       ├── state.json
    │       ├── USER_REQUEST.md
    │       └── RESEARCH.md
    └── brainstorm/
        └── c8b4a9d1e7f3_rate-limiting/
            ├── state.json
            ├── USER_REQUEST.md
            └── RESEARCH.md
```

### Task Directories

Organized by command type: `state/implement/`, `state/debug/`, `state/brainstorm/`. Each task gets a directory with a random UUID-based ID prefix and a sanitized descriptive name (e.g. `a3f2b1c9d0e4_fix-auth`). The random ID avoids collisions between concurrent pi instances.

### state.json

Minimal, machine-consumed only. No subphase tracking — the extension infers substate from which artifacts exist on disk (planner outputs exist → skip spawning planners, synthesized plan exists → skip synthesis).

```json
{
  "phase": "planning",
  "from": null,
  "description": "fix auth token expiry",
  "startedAt": "2026-04-15T12:00:00Z",
  "reviewRound": 1
}
```

The `description` field stores the full original user-provided task description. The directory name is a truncated/sanitized version for filesystem safety; `description` preserves the original text for display in the UI, session names, and phase prompts.

`reviewRound` is optional — present only for implement tasks that have reached the review phase. It tracks which review iteration the task is on, persisted to survive session restarts. Used to enforce `maxAutoReviewRounds`.

Phase values:
- implement: `brainstorm → planning → implementation → review → done`
- debug: `diagnosing → done`
- brainstorm: `active → done`

### Artifacts

Everything except state.json is markdown. Plan progress is tracked via checkboxes in the synthesized plan. Review verdicts are in review markdown. Open questions are a section at the bottom of RESEARCH.md.

When `/pp:implement --from <task>` is used, USER_REQUEST.md and RESEARCH.md are copied (not linked) from the source task. The implement task is self-contained.

### Locking

`proper-lockfile` for cross-platform file locking. Uses atomic `mkdir` strategy with stale detection via mtime (stale timeout and refresh interval are configurable via `timeouts.lockStale` and `timeouts.lockUpdate`, defaults 600s and 30s). `onCompromised` errors are logged via `console.error` — a compromised lock (`.lock` dir disappeared) is non-fatal since tasks are single-instance in practice, but the event is now visible for debugging. Lock release failures during cleanup are also logged rather than silently swallowed. If a process crashes, the lock becomes stale after the timeout and the next session can take over. Acquire with `lockfile.lock(taskDir)`, release with `release()`.

### Worktrees

Each git worktree gets its own independent `.pp/` directory (`.pp/` is gitignored, so worktrees don't share state).

---

## Context Injection

Flexible per-file injection via `.pp/context/*.md`. Each file has YAML frontmatter:

```markdown
---
inject: system
agents: [task, codeReviewer]
---

Always use snake_case for database columns.
```

### Injection Modes

- `inject: system` — Injected into the system prompt. Always present, survives compaction. For hard rules and constraints.
- `inject: context` — Injected as a context message at session/phase start. Informational, may be summarized during compaction. For project overview, conventions, architecture notes.

### Targeting

Two fields (union of matches):

- `agents`: specific types — `main`, `explore`, `librarian`, `planner`, `planReviewer`, `task`, `codeReviewer`
- `agentGroups`: shortcuts — `all`, `subagents` (everything except main)

If neither specified, defaults to `main` only.

### AGENTS.md

The project's AGENTS.md (if present) is injected as context into the main agent. Configurable via `"injectAgentsMd": true` in config.

---

## Session Resume & Task Lifecycle

Starting `/pp:implement`, `/pp:debug`, or `/pp:brainstorm` while another task is active is an error. The extension prints: "Task '<name>' is active (phase: <phase>). Run /pp:done to finish it, or /pp:resume to continue."

`/pp:done` marks the current task as done, releases the lock, and resets context. When finishing a brainstorm or debug task with captured artifacts, prints a hint with the `--from` command.

`/pp:resume` lists all non-done tasks with their phase and age. User selects one. The task is locked and the agent continues from its current phase with artifacts re-injected.

---

## Tool Call Safety & Agent Routing

Hooks into `tool_call` events for two purposes:

1. **Write safety**: Blocks agent writes to `.pp/state/` except `*.md` files. Only the extension code modifies `state.json` and `config.json`. Paths are resolved to absolute before checking to prevent bypass via relative path tricks (e.g. `.pp/./state/`, `../` traversal).

2. **Agent routing**: Intercepts all `Agent(...)` tool calls and remaps `subagent_type` to our custom agent definitions (`pp_<taskId>_explore`, `pp_<taskId>_librarian`, `pp_<taskId>_task`). Also injects `model` and `thinking` from config. The LLM uses human-readable names in its calls (`"Explore"`, `"Librarian"`, `"Task"`); the handler transparently routes them to our custom `.md` agent definitions which have our prompts, tools, and `prompt_mode: replace`. Built-in pi-subagents agents are never used.

---

## Auto-Commit

Extension-driven. On `turn_end` during implementation, if there are modified files tracked by the extension, the extension runs `git add` + `git commit` using `execFileSync` with argument arrays (bypassing shell interpretation for safety — file paths and commit messages are passed as direct arguments, not interpolated into shell strings). The commit message is derived from the task description — strip markdown formatting, truncate to ~72 chars, lowercase first word. No AI markers, no LLM generation. Commit messages look human-written (e.g. "add rate limiter middleware"). Commits are squashable for clean history.

Configurable: `"autoCommit": true` by default.

---

## Commands (Hooks)

User-configurable commands that run at specific points during the workflow.

### afterEdit

Runs after each file edit during implementation. **Advisory** — output (including failures) is appended to the tool result so the LLM can see it, but failures do not block the agent. The LLM decides how to handle failures (fix, ignore, defer). This is intentional: a single file edit may produce transient errors that resolve when related files are updated. Filtered by glob patterns. For formatters, type checkers, and fast linters. Executed by the extension via `tool_result` event handler on successful `edit`/`write` tool calls.

```json
"afterEdit": [
  { "run": "gofmt -w ${file}", "glob": ["*.go"] },
  { "run": "npx tsc --noEmit", "glob": ["*.ts"] }
]
```

### afterImplement

Runs after all plan items are checked off, before the review phase. **Gate** — failures block the phase transition. The LLM must fix the issues before `/pp:next` can advance. For full test suites, all linters, build checks.

```json
"afterImplement": [
  { "run": "go test ./..." },
  { "run": "golangci-lint run" }
]
```

Templates: `${file}` (full file path), `${dir}` (directory of changed file). Both are shell-escaped (single-quoted with internal quote escaping) before interpolation to prevent command injection via crafted file paths. If neither is present, command runs as-is.

---

## Event Handlers

The extension registers the following pi-mono event handlers:

| Event | Purpose |
|-------|---------|
| `session_start` | Restore abandoned task state from `.pp/state/` (only if exactly one unlocked non-done task exists — locked tasks belong to other sessions, multiple unlocked tasks are ambiguous). Update status. Notify user. |
| `before_agent_start` | Append phase-specific system prompt snippet. Inject `system`-mode context files and AGENTS.md (if `injectAgentsMd` enabled) for `main` agent. |
| `tool_call` (Agent) | Intercept `Agent(...)` calls: remap `subagent_type` to custom `pp_<taskId>_*` names, inject `model` and `thinking` from config. Routes Explore/Librarian/Task to our custom agent definitions. |
| `tool_call` (write/edit) | Block writes to `.pp/state/` except `*.md`. Block all writes to `state.json` and `config.json`. |
| `tool_result` (edit/write) | Run matching `afterEdit` commands during implementation (advisory — output appended to tool result for LLM to see, failures don't block). Nudge LLM to run LSP diagnostics. |
| `session_before_compact` | Re-inject full artifact contents (USER_REQUEST.md, RESEARCH.md, active plan) after compacted summary. |
| `turn_end` | Update status bar with current phase. During implementation, auto-commit modified files if `autoCommit` is enabled. |
| `subagents:completed` | Send `display: true` message with agent description, stats (duration, tokens), and truncated result preview. Provides user visibility into subagent findings. |
| `subagents:failed` | Send `display: true` message with agent description and error. |
| `subagents:created` | Track spawned agent IDs for abort-on-done. |

---

## Error Recovery

Pi's built-in `AgentSession` handles auto-retry for 429, 5xx, and context overflow errors. Subagents spawned via `@tintinweb/pi-subagents` inherit this behavior.

If a planner or reviewer variant fails permanently (provider down), the orchestrator proceeds with the remaining variants' results instead of failing the entire phase. If all variants fail (zero output files produced), the extension sends an explicit error message to the LLM instructing it to create the plan/review itself, rather than silently proceeding with no output.

---

## Configuration

`.pp/config.json` — gitignored, user-editable. Generated with defaults on first run if absent. Gitignored because model provider names (e.g. `flant-openai/gemini-3.1-flash` vs `google/gemini-3.1-flash`) are machine-specific. Loaded with deep merge against hardcoded defaults. Validated at load time by a `validateConfig()` function that checks field presence, types, and structural correctness (e.g. model strings non-empty, `afterEdit` entries have `run` field, enabled variants have `model`). Throws descriptive errors on invalid config. No schema library — manual runtime validation.

```json
{
  "mainModel": {
    "implement": { "model": "anthropic/claude-opus-4-6", "thinking": "high" },
    "debug": { "model": "openai/gpt-5.4", "thinking": "high" },
    "brainstorm": { "model": "anthropic/claude-opus-4-6", "thinking": "high" }
  },
  "planners": {
    "opus": { "enabled": true, "model": "anthropic/claude-opus-4-6", "thinking": "high" },
    "gpt": { "enabled": true, "model": "openai/gpt-5.4", "thinking": "high" },
    "gemini": { "enabled": true, "model": "google/gemini-3.1-pro", "thinking": "high" },
    "grok": { "enabled": true, "model": "xai/grok-4", "thinking": "high" }
  },
  "planReviewers": {
    "opus": { "enabled": true, "model": "anthropic/claude-opus-4-6", "thinking": "high" },
    "gpt": { "enabled": true, "model": "openai/gpt-5.4", "thinking": "high" }
  },
  "codeReviewers": {
    "opus": { "enabled": true, "model": "anthropic/claude-opus-4-6", "thinking": "high" },
    "gpt": { "enabled": true, "model": "openai/gpt-5.4", "thinking": "high" },
    "gemini": { "enabled": false },
    "grok": { "enabled": false }
  },
  "agents": {
    "explore": { "model": "google/gemini-3.1-flash", "thinking": "low" },
    "librarian": { "model": "google/gemini-3.1-flash", "thinking": "medium" },
    "task": { "model": "anthropic/claude-opus-4-6", "thinking": "medium" }
  },
  "commands": {
    "afterEdit": [
      { "run": "gofmt -w ${file}", "glob": ["*.go"] }
    ],
    "afterImplement": [
      { "run": "go test ./..." },
      { "run": "golangci-lint run" }
    ]
  },
  "timeouts": {
    "afterEdit": 30000,
    "afterImplement": 300000,
    "agentSpawn": 30000,
    "agentReadyPing": 5000,
    "lockStale": 600000,
    "lockUpdate": 30000
  },
  "autoCommit": true,
  "injectAgentsMd": true,
  "usePlannotator": true,
  "maxAutoReviewRounds": 2
}
```

The `timeouts` section is optional — all values have sensible defaults. `afterEdit` and `afterImplement` control command execution timeouts. `agentSpawn` and `agentReadyPing` control subagent RPC timeouts. `lockStale` and `lockUpdate` control file locking behavior.

---

## File Structure

```
extensions/orchestrator/
├── index.ts              # Entry: register commands, event handlers, tool_call Agent routing, subagent lifecycle listeners
├── config.ts             # loadConfig(), defaults, types
├── state.ts              # Task lifecycle: create, persist, restore, lock, list
├── context.ts            # .pp/context/*.md loading, AGENTS.md, artifact injection
├── commands.ts           # afterEdit/afterImplement shell runners, auto-commit
├── vendor.d.ts           # Type declarations for proper-lockfile
├── phases/
│   ├── machine.ts        # Transition table, validation, exit criteria
│   ├── brainstorm.ts     # Phase prompts for brainstorm/debug/brainstorm-open
│   ├── planning.ts       # Spawn planners via RPC, collect results
│   ├── implementation.ts # Phase prompt for implementation
│   └── review.ts         # Spawn reviewers via RPC, collect results
└── agents/
    ├── registry.ts       # Write .pi/agents/pp_*.md, cleanup, RPC spawn/wait helpers
    ├── explore.ts        # Factory: frontmatter + prompt
    ├── librarian.ts      # Factory: frontmatter + prompt
    ├── planner.ts        # Factory: frontmatter + prompt
    ├── plan-reviewer.ts  # Factory: frontmatter + prompt
    ├── task.ts           # Factory: frontmatter + prompt
    └── code-reviewer.ts  # Factory: frontmatter + prompt
```
