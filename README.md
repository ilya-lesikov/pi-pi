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

## Memory

The prompt is kept inside the model's window by folding old tool traffic out of the copy on its way to the provider: a result becomes an `[omitted: <size>B]` notice, and the call that asked for it, along with everything the user and the model said, is never touched. Arguments are left exactly as they were written, so a folded call still states what it ran and on what; only the answer goes. Folding is oldest-first and never reversed, so the prompt's prefix stays stable between requests and the provider's cache survives. Calls old enough to be finished with are removed outright rather than left as husks.

The session itself is never cut. `recall_tool_output` hands back a folded result by the id of the call it answered — the one on the call and on the result block beside the notice — and `vcc_recall` searches durable session history: messages, tool calls, and tool results. Native Pi session restoration remains authoritative; pi-pi does not duplicate conversation state in task files.

## Tool provisioning

The tools the agent is told to prefer are installed rather than assumed. ripgrep and the code graph are fetched at session start; a language server is fetched the first time a file of its language is touched. Everything lands in one directory that is prepended to the session's `PATH`, so ordinary `which` lookups find it and the user's shell environment is untouched.

Downloads verify what the publisher actually offers — a published digest where there is one, npm's own integrity check for npm packages, a toolchain's own verification for toolchain components — and `/pp → Doctor` reports which of those applied per tool rather than implying a uniform guarantee. A session that cannot reach the network starts anyway, degraded exactly as it would have been before.

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

Workers never block the main session. `Agent` returns a worker id at once, and the result arrives on its own: at the main agent's next tool-call boundary while it is busy, or as a new turn once it is idle and nobody is typing or answering a dialog. The main agent controls what it started with `agent_wait` (bounded, returns on the first result or question), `agent_send` (steer a running worker, answer its question, or give a finished one follow-up work in the same context), `agent_status`, and `agent_stop` (`graceful`, `kill` even when stuck, or `tool` to cancel only the call it is stuck in). A worker can report progress and ask its parent a question, and finishes with a structured result; reviewers return their findings with severity and location.

A worker has no run, turn or silence limit: the parent agent watches it with `agent_status` and stops it when it judges the work stuck or done. A worker that stays silent is flagged to the parent once after `performance.internals.workerStallWarn` (3 minutes); a run whose session produces nothing at all within `workerStartTimeout` (1 minute) fails with the startup step it was stuck in; a model request that goes `workerModelStale` (10 minutes) without a response and with no tool running is abandoned and the worker continues in place, failing after the third such hang in a run; `workerQuestionTimeout` bounds how long a question waits, and `workerBashTimeout` is the default for a worker's shell commands. Workers end with the session that started them.

The panel above the editor shows each worker's current step (waiting for the model, thinking, running a tool, retrying…) and how long it has been at it, when the model last produced output, and any pending question; `agent_status` gives the agent the same view, plus the tail of what a worker is writing; `/pp → Workers` lists them and opens a live transcript where you can steer, answer, interrupt a tool, stop or kill one.

## Task checklist

The main agent keeps a checklist with `TaskCreate`, `TaskUpdate`, `TaskList` and `TaskGet`, shown above the editor. The list lives in the session itself: every task tool result carries it, so `/resume`, forks and `/tree` restore the list as it stood at that point, and it survives compaction. Once every task is completed, the next one starts a fresh list. When edits, commits or turns pile up without the list changing, the agent gets a reminder that names what has gone stale. Workers have no task tools.

## Asking the user

`ask_user` asks one short question inline, above the editor: a list of options with optional descriptions, multi-select, a "Type something." row for a free answer, and ctrl+e to attach a comment to a choice. Several decisions go in one call as `questions`, shown one at a time as `Question N/M`; alt+← and alt+→ move between them, a revisited question keeps its earlier answer selected, and Esc cancels the whole call. Without the terminal UI (RPC) it falls back to the host's select and input dialogs.

## ACP clients

The pi-acp fork can expose `/pp`, usage, workers, elicitation, and session status in clients such as Zed. pi-pi no longer publishes a phase pipeline because there is none.

## Models and providers

Roles name a model slot, not a provider: Claude Haiku, Sonnet, Opus and Fable, and GPT Luna, Terra, Sol and Astra (GPT also with a costlier Pro variant), written `claude/opus` or `gpt/astra:pro` in config. Each slot runs on the newest version the first provider in a priority list serves:

- Claude subscription — reached directly or through the LLM API gateway, in the order you choose;
- ChatGPT subscription;
- GitHub Copilot;
- LLM API — paid per token.

A provider without credentials serves nothing and is passed over. On a rate limit the provider steps aside — a subscription for the whole account, the others for that one model — and work moves to the next one that serves the slot, paid LLM API included; it comes back once the limit clears. A slot can be locked to one version, and a role can name an exact `provider/model`, which routing then never moves.

A whole family can be replaced by another provider's models, for example every Claude slot served by a cheaper model from a provider pi already has credentials for. It still reads as "Claude Opus · override zai/glm-5.3" everywhere; an overridden family does not fall back to another provider.

All of this is under `/pp → Settings → Providers` and `Models`, scoped globally or per project; `Explain routing` shows what each slot runs on and why.
