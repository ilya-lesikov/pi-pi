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
- providers, model slots and family overrides;
- main and worker models.

Reports (Status, Usage, Diagnostics, Explain routing) open as a scrollable view in the terminal. Elsewhere they go wherever the host shows pi-pi's messages: its notifications, a chat message the model never sees, or stderr in a run without a UI, where `/pp` prints the status and exits. The worker viewer becomes the transcript as text with Refresh, Send and Stop. Some apps (bb, and possibly ACP adapters) wait for a model run after every prompt and `/pp` starts none; there the menu says the app may stay busy afterwards, and on bb, which shows neither notifications nor chat messages outside a turn, reports open in a read-only text dialog.

## Memory

The prompt is kept inside the model's window by folding old tool traffic out of the copy on its way to the provider: a result becomes an `[omitted: <size>B]` notice, and the call that asked for it, along with everything the user and the model said, is never touched. Arguments are left exactly as they were written, so a folded call still states what it ran and on what; only the answer goes. Folding is oldest-first and never reversed, so the prompt's prefix stays stable between requests and the provider's cache survives. Calls old enough to be finished with are removed outright rather than left as husks.

The session itself is never cut. `recall_tool_output` hands back a folded result by the id of the call it answered — the one on the call and on the result block beside the notice — and `vcc_recall` searches durable session history: messages, tool calls, and tool results. Native Pi session restoration remains authoritative; pi-pi does not duplicate conversation state in task files.

## Tool provisioning

The tools the agent is told to prefer are installed rather than assumed. ripgrep and the code graph are fetched at session start; a language server is fetched the first time a file of its language is touched. Everything lands in one directory that is prepended to the session's `PATH`, so ordinary `which` lookups find it and the user's shell environment is untouched.

Downloads verify what the publisher actually offers — a published digest where there is one, npm's own integrity check for npm packages, a toolchain's own verification for toolchain components — and `/pp → Diagnostics` reports which of those applied per tool rather than implying a uniform guarantee. A session that cannot reach the network starts anyway, degraded exactly as it would have been before.

## Language servers

The `lsp` tool gives the agent and its workers definitions, references, hover, diagnostics, symbols, call hierarchy and code actions from real language servers. Fourteen are built in (TypeScript/JavaScript, Go, Rust, Python, C/C++, Bash, Lua, Zig, Kotlin, Ruby, C#, Swift, Elixir, Java); five of them are installed on demand, the rest are used when found on `PATH`. A server starts on first use, once per project root — the nearest directory with one of its markers (`go.mod`, `Cargo.toml`, `tsconfig.json`, …) — so a monorepo gets one server per project. Queries that span the project wait for the server to finish indexing; a server that keeps failing to start is retried with a growing delay rather than on every call.

After each successful edit or write, the errors and warnings the file's already-running servers report are appended to the result, at most 20, inside `<diagnostics file="…">`. It never starts a server or waits more than a moment for one; reading a file starts its servers in the background so the next edit finds them ready. Turn it off with `lsp.diagnosticsAfterEdit: false` or `/pp → Settings → LSP`.

`lsp.servers` in the global or project config overrides a built-in field by field or adds a server:

```json
{
  "lsp": {
    "servers": {
      "typescript": { "command": ["/opt/tsls/bin/typescript-language-server", "--stdio"] },
      "go": { "enabled": false },
      "nix": { "command": ["nil"], "extensions": [".nix"], "rootMarkers": ["flake.nix"], "settings": { "nil": { "formatting": { "command": ["nixfmt"] } } } }
    }
  }
}
```

`settings` answers the server's `workspace/configuration` requests; `initializationOptions` and `env` are passed as given. A project config can only choose the `command` and `env` a server runs once pi trusts the project; until then they are ignored and `/pp → Diagnostics` says so.

## Skills

The main prompt contains a compact catalog. Full skill guidance is loaded through `load_skill` and appears as a tagged tool result, so it remains searchable and can be loaded again when no longer salient.

Skill precedence is:

1. `<project>/.pi/skills`
2. `~/.pi/skills`
3. bundled pi-pi skills

A skill may be `<name>/SKILL.md` or a Markdown file directly inside a skills directory. It needs frontmatter with `name` and `description`. Subagents cannot load skills themselves; a skill whose frontmatter also sets `audience: any` can be named in an Agent call's `skills` parameter and is preloaded into that subagent's prompt. Other skills are written for the main agent and are refused there.

Bundled skills cover feature work, bug work, investigation, git operations, operations on real machines and clusters, review, skill authoring, and the code rules shared with subagents. The agent decides when to load them; `/pp` only shows the catalog and source settings.

## Workers

The main session owns long-running and interactive work. Functional workers are optional and bounded:

- `explore` for local retrieval and mapping;
- `librarian` for external sources;
- `advisor_*` for independent judgment;
- `deep-debugger_*` for difficult diagnosis;
- `reviewer_*` for fresh read-only review;
- `task` for a self-contained parallel slice.

Workers receive no duplicated task artifact bundle. They can search the owning session with `vcc_recall` when prior decisions or tool results matter.

Workers never block the main session. `Agent` returns a worker id at once, and the result arrives on its own: at the main agent's next tool-call boundary while it is busy, or as a new turn once it is idle and nobody is typing or answering a dialog. Outside the terminal, where an app expects one turn per prompt, a run that ends while workers are busy stays open until their results are in it instead of the results starting an unprompted turn later; you can stop it or send a message at any time, and after 30 minutes without any worker activity it ends and the results wait for your next message. A run without a UI waits up to two hours of silence, then stops the workers and says in its final answer what they did not finish. pi-pi's own automatic continuations likewise continue the run that is ending rather than starting a new one; in the terminal they keep the short pause in which you can step in. The main agent controls what it started with `agent_wait` (bounded, returns on the first result or question), `agent_send` (steer a running worker, answer its question, or give a finished one follow-up work in the same context), `agent_status`, and `agent_stop` (`graceful`, `kill` even when stuck, or `tool` to cancel only the call it is stuck in). A worker can report progress and ask its parent a question, and finishes with a structured result; reviewers return their findings with severity and location.

A worker has no run, turn or silence limit: the parent agent watches it with `agent_status` and stops it when it judges the work stuck or done. A worker that stays silent is flagged to the parent once after `performance.internals.workerStallWarn` (3 minutes); a run whose session produces nothing at all within `workerStartTimeout` (1 minute) fails with the startup step it was stuck in; a model request that goes `workerModelStale` (10 minutes) without a response and with no tool running is abandoned and the worker continues in place, failing after the third such hang in a run; `workerQuestionTimeout` bounds how long a question waits, and `workerBashTimeout` is the default for a worker's shell commands. Workers end with the session that started them.

The panel above the editor lists the workers under a header that counts them by state, the ones that need you first: a question (with its text), a worker gone silent (for how long, in which tool), a failure (with its error, kept until you open it); then running workers with their current step, time and tokens, then queued ones. It shows three at a time and sums up the rest; a finished worker stays a few seconds. `ctrl+n` lets you pick one with the arrow keys and act on it without leaving the prompt: Enter opens its live transcript, `m` messages or answers it, `i` interrupts its current tool, `s` stops and `k k` kills it, Esc goes back. `agent_status` gives the agent the same view, plus the tail of what a worker is writing; `/pp → Workers` lists them too.

Every worker's conversation is written as it happens to `.pp/workers/<session>/<worker>.jsonl`, in pi's session format, readable only by you and deleted after a week. A missing `.pp/.gitignore` is created ignoring everything; when an existing one does not ignore `workers/`, transcripts go to `~/.cache/pi-pi/workers` instead. While the main agent waits with `agent_wait`, the call's progress shows each worker's current step, so apps that show a running tool's progress show the workers too. Under Paseo, workers also appear as Paseo's own sub-agent cards following that transcript.

## Task checklist

The main agent keeps a checklist with `TaskCreate`, `TaskUpdate`, `TaskList` and `TaskGet`, shown above the editor as counts plus the running and next pending tasks (five rows at most). Each create or update result repeats that short list, so apps that do not show pi-pi's panels show the tasks there; under Paseo the four tools are one `todo` tool, which Paseo draws as its own todo card. The list lives in the session itself: every task tool result carries it, so `/resume`, forks and `/tree` restore the list as it stood at that point, and it survives compaction. Once every task is completed, the next one starts a fresh list. When edits, commits or turns pile up without the list changing, the agent gets a reminder that names what has gone stale. Workers have no task tools.

## Asking the user

`ask_user` asks one short question inline, above the editor: the question as the main line, a short `header` in the frame, options with optional descriptions, an optional `recommended` option focused and marked, multi-select, and an "Other…" row for a typed answer. Digits answer at once, ctrl+e attaches a comment to the choice, and Esc cancels after an optional reason; ctrl+c never cancels a question. Several decisions go in one call as `questions`, shown one at a time; ← and → move between them. Calls with one option, duplicate options or an option that only declines are refused before anything is shown.

`confirm` puts a single yes/no decision: Yes, No, or dismissed, with `danger` focusing No for destructive actions.

Outside the terminal both use the host's own dialogs, kept within the limits of the strictest host: one-line titles, `Title — description` options, multi-select as Add/Remove entries with an explicit "Use selected", a Back entry and a final review for several questions, and "Other…" or "Add a comment…" only where the host can collect typed text. `confirm` becomes the host's native approval. Without any UI, `ask_user` lists the questions for the model to answer on stated assumptions, and `confirm` reports that nothing was confirmed.

## Models and providers

Roles name a model slot, not a provider: Claude Haiku, Sonnet, Opus and Fable, and GPT Luna, Terra, Sol and Astra (GPT also with a costlier Pro variant), written `claude/opus` or `gpt/astra:pro` in config. Each slot runs on the newest version the first provider in a priority list serves:

- Claude subscription — reached directly or through the LLM API gateway, in the order you choose;
- ChatGPT subscription;
- GitHub Copilot;
- LLM API — paid per token.

A provider without credentials serves nothing and is passed over. On a rate limit the provider steps aside — a subscription for the whole account, the others for that one model — and work moves to the next one that serves the slot, paid LLM API included; it comes back once the limit clears. A slot can be locked to one version, and a role can name an exact `provider/model`, which routing then never moves.

A whole family can be replaced by another provider's models, for example every Claude slot served by a cheaper model from a provider pi already has credentials for. It still reads as "Claude Opus · override zai/glm-5.3" everywhere; an overridden family does not fall back to another provider.

All of this is under `/pp → Settings → Providers` and `Models`, scoped globally or per project; `Explain routing` shows what each slot runs on and why.
