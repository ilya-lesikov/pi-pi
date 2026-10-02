---
name: review
description: Load BEFORE reviewing finished work of any kind — a GitHub PR or GitLab MR, someone's branch, a patch, your own diff before you push or commit, a design doc, a config or migration, a dataset — including "review this", "посмотри что я наделал", "ревью", "is this ready to merge", "what did I miss". Load it BEFORE posting anything to a PR or MR — "post the review", "leave these comments on the PR", "approve the MR", "request changes" — because those calls publish irreversibly and this skill holds the draft-first procedure that makes them safe. Covers direction, intent, premise, severity, and posting findings back to the forge.
---

Review is judging finished work against the intent it was meant to serve. The judgement is the same whoever wrote it; only the audience for the findings changes. This skill's `<skill>` tag carries a `dir` attribute; the references live inside it.

## Settle the direction before anything else

Infer it from the request — do not ask.

- **Incoming** — a PR/MR URL, a remote branch, a patch file, a name other than yours. You are the approver; findings are addressed to an author and may be posted. See `references/incoming.md`.
- **Outgoing** — uncommitted work, `HEAD` from this session, "before I push", "what did I miss". Findings are a worklist, not prose for a third party. See `references/outgoing.md`.
- Do not reach for `git log -1 --format=%ae` to settle it. The agent commits under the user's own identity, so the author email cannot separate work this session produced from work the user wrote by hand — and the second is incoming however the email reads.
- What you genuinely know is whether *this session* produced the change. Apply `references/outgoing.md`'s section on your own blind spots only when it did; the rest of that file fits any change that is not going to a third party.
- Ask only when authorship and audience disagree — your own diff that someone else must approve — because that alone changes what you emit.

## Pin what is under review

- Establish the fixed point: the merge target for a PR/MR, the ref the session started from when reviewing its own work, the merge-base otherwise. Diff three-dot (`git diff base...HEAD`), so the comparison is against the merge-base rather than the branch tip. `HEAD~1` is right only when exactly one commit is under review — a session that committed each unit separately, as it should, leaves several.
- Prove the ref resolves and that something is actually under review before doing anything else. A bad ref must fail here, not inside three subagents.
- `git status --short` before `git diff`, and state which of the four populations you are reviewing: committed, staged, unstaged, untracked. Work that lives entirely in the working tree is the normal outgoing case and an empty `base...HEAD` says nothing about it — a review that silently skips it is worse than no review.
- For a non-git artifact, pin the version it supersedes. Where there is no before — a document written from scratch — review it against its stated requirements instead, and say that is what you did.
- On an incoming change, treat the branch as untrusted material before running anything from it. See `references/incoming.md`; for a forge-hosted change, `references/forges.md` covers fetching it and the CLI traps on the way.

## Establish intent, then the premise

- Outgoing: the intent was settled earlier in this session — `vcc_recall` it rather than reconstructing it from the diff. The diff cannot tell you what it was supposed to do.
- Incoming: the PR/MR description, the linked issue, the commit messages, in that order. If none of them states a goal, say so and review against what the change implies — never against a goal you guessed silently.
- Then establish the **premise**: the diagnosis or reading of the system that makes this the right change at all. A change can be flawless against a false premise — correct code fixing the wrong thing, a workaround for a problem that is really upstream, a test built on the same wrong reading as the code.
- Verify the premise independently of the change. Where the evidence for it is absent, weak, or merely asserted, that is itself a finding, and usually the most valuable one.
- Before rejecting a premise, measure what the change does before and against after. A change whose stated rationale is wrong may still be a large improvement on the axis it actually moves — that is a finding against the commit message, not grounds to dismiss the change, and recommending its removal on the strength of the bad story is the expensive error.

## Read with the tools

- `cbm_changes` for blast radius; `lsp diagnostics` on every changed file; `lsp findReferences` and `incomingCalls` on every modified symbol. A reviewer who only read the diff cannot speak about callers.
- For a consistency finding, cite the precedent: `cbm_search` for how the repo already solves the closest problem, by behaviour rather than filename. "Not idiomatic" without a cited neighbour is a preference, not a finding.
- You can run the suite; the reviewer pool cannot. Run it, and carry the result into the review. A failing test is evidence. An uncovered path is a gap to investigate — it becomes a finding when you can name what breaks on it, and otherwise it is stated as a limit of what the suite proves.

## Keep the two axes apart

- **Intent failures**: missing requirements, scope that nobody asked for, something implemented but wrong.
- **Craft failures**: correctness, edge and failure handling, concurrency, resource and performance behaviour, security exposure, consistency with surrounding conventions.
- Report them separately and never rerank across them. Code that follows every convention while implementing the wrong thing passes one axis and fails the other; merging the lists hides exactly that.

## Severity, and what it costs to be wrong

- Use the same vocabulary as pi-pi's reviewer pool — `CRITICAL`, `MAJOR`, `MINOR`, `OPEN QUESTIONS` — so an inline review and a delegated one read identically. For incoming, open with `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES` on the first line.
- Anchor every `CRITICAL` and `MAJOR` to `file:line` or a quoted excerpt. Never assert a problem in something you did not read.
- A concern you cannot prove with what you ran goes to `OPEN QUESTIONS` with the evidence that would settle it. It does not get promoted to a finding because it feels right.
- Calibrate by blast radius, not by how irritating it is. Schema changes, API contracts, auth paths, anything touching credentials or user data earn an extra pass; naming and layout do not block.
- Say explicitly which defects the change introduces and which it merely inherits. A pre-existing problem in a touched line is worth raising and is not the author's debt to this commit, and filing it at the same severity inflates the list it is read against.
- Rank by what would change the author's next action. A list where most items are `MAJOR` carries no ordering at all and gets skimmed exactly like an unordered one.
- Report the findings, not the procedure. Which commands you ran, which subagents you spawned, and how you pinned the diff are yours — a reader wants what you found and where.

## Delegate what you cannot see yourself

- The reviewer pool reads cold, which is the point for work you wrote or already formed a view on. Prefer a family other than your own; for a high-stakes change spawn the whole pool and weigh the disagreement rather than averaging it.
- No pool's tool allowlist includes `load_skill`, and reviewers are read-only: inline the criteria into the prompt, and paste in test results they cannot produce themselves.
- `advisor` for a genuine design judgement, `librarian` for an external standard or CVE, `explore` to map an area you do not know. Spawn them in one message so they run in parallel.

## Non-code artifacts

- Prose and designs: is each claim supported, is each instruction executable as written, would the examples actually run.
- Config and IaC: what it does on apply, what it takes down while applying, how it rolls back.
- Data and migrations: reversibility, volume, and what a failure halfway through leaves behind.

## Size the review to the change

- Scale the effort and the output to the diff. Twenty correct lines deserve three lines back; the ceremony belongs to the change, not to this document.
- **Zero findings is a valid result and the right one more often than not.** Say it in a sentence and stop. A review padded to look thorough buries the one real finding in the next review the author skims.
- Check the premise once. Report it when it fails or when nothing establishes it, and say nothing about it when it holds — relitigating whether a sound change should exist is the most expensive way to be useless.
- Every section of this skill permits silence. None of them is a quota.

## Never publish without approval

Produce the review, show it, get approval, then post. Drafts are reversible and published comments are not — `references/forges.md` keeps everything in a draft state until the moment you submit. `gh pr review`, `gh pr comment`, `gh api .../replies`, `glab mr note` and `glab mr approve` have no draft state at all: they publish on return, and none of them is to be run before that approval.
