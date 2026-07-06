# How pi-pi Review Works

This document explains pi-pi's review workflow: how automated reviews run, which
models are involved (yes — GPT is used), and how findings are surfaced back to
you (markdown reports, `AI_COMMENT:` source markers, and GitHub PR line comments).

## Two kinds of review

pi-pi offers two independent review UIs from the `/pp` menu:

1. **Auto review** — spawns automated reviewer subagents (this document's focus).
2. **Plannotator** — an in-browser diff/plan review (plan and implement phases
   only; disabled in autonomous mode).

There is also **"Review on my own"**, where *you* annotate files with `AI_REVIEW:`
markers and the agent addresses and removes each one. That is the user→agent
direction and is unrelated to the reviewer→user `AI_COMMENT:` markers below.

## Auto review: the reviewer variants (is GPT used?)

**Yes, GPT is used.** An Auto review runs **three reviewer variants in parallel**,
each backed by a different model family:

- `opus` — Anthropic Claude
- `gpt` — OpenAI GPT
- `gemini` — Google Gemini

These are the default `codeReviewers` variants (see `config.ts`; the flant preset
resolves the same three via latest-model discovery). Two presets exist:
`regular` and `deep` (deep raises reviewer thinking to `xhigh`).

Each reviewer subagent is **READ-ONLY**: it runs `git diff` + `cbm_changes` +
`lsp diagnostics`, reads the changed code, and writes exactly ONE review file:

```
<task>/code-reviews/<timestamp>_<variant>_round-N.md
```

Every review file starts with `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES`, and
lists CRITICAL / MAJOR / MINOR findings plus OPEN QUESTIONS. Each reviewer also
emits a machine-readable `ANCHORS:` block — one `path:line — finding` per
actionable finding — which is what lets pi-pi place findings at their exact
locations.

## Synthesis

After all three reviewers finish, the **main agent synthesizes** their outputs
into a single file:

```
<task>/code-reviews/<timestamp>_final_pass-N.md
```

The main agent is the SINGLE writer for any source/PR anchoring — the three
parallel reviewers stay read-only so they can't collide.

## Standalone review tasks vs. implement-phase review

- In the **implement phase**, Auto review checks the implementation against the
  approved synthesized plan (a plan is required).
- In a **standalone review task** (phase `review`), there is no plan by design:
  reviewers assess the diff against `USER_REQUEST.md` / `RESEARCH.md`. The
  synthesizer does NOT create a fix plan, implement fixes, or run afterImplement
  commands — it just reports and anchors.

## Anchoring findings

When you start an Auto review in a standalone review task, pi-pi asks how to
anchor the findings:

- **Markdown only** — findings stay in the synthesized review report.
- **AI_COMMENT source comments** — the synthesizer inserts `AI_COMMENT:` markers
  at each finding's location, in the file's native comment syntax
  (`// AI_COMMENT: …`, `# AI_COMMENT: …`, `<!-- AI_COMMENT: … -->`). This is the
  reviewer→user mirror of `AI_REVIEW:`.
- **GitHub PR line comments** — pi-pi posts line-anchored review comments to the
  branch's PR **from your own `gh`-authenticated account**, each body ending with
  a `_Generated with pi-pi_` footer. Requires a detected PR and `gh auth`; if
  either is missing it degrades gracefully to the report/markers with a notice.
  Findings that can't be mapped to a line in the PR diff are skipped and reported.
- **AI_COMMENT + GitHub PR line comments** — both of the above.

### AI_COMMENT deletion

`AI_COMMENT:` markers are temporary. You address them (typically in a follow-on
implement task, symmetric with the `AI_REVIEW:` workflow), and as a safety net
**pi-pi automatically strips any remaining `AI_COMMENT:` markers when the review
task completes** — so none are ever left behind or committed.

## Tuning

- Reviewer models/presets: `config.performance` / `agents.subagents.presetGroups`
  and the `codeReviewers` preset group in `config.ts`.
- Main-turn stall watchdog timeout: `performance.internals.mainTurnStale`
  (default `10m`).
