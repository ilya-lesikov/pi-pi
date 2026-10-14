---
name: review
description: Load BEFORE reviewing finished work of any kind — a GitHub PR or GitLab MR, someone's branch, a patch, your own diff before you push or commit, a design doc, a config or migration, a dataset — including "review this", "посмотри что я наделал", "ревью", "is this ready to merge", "what did I miss". Load it BEFORE posting anything to a PR or MR — "post the review", "leave these comments on the PR", "approve the MR", "request changes" — because those calls publish irreversibly and this skill holds the draft-first procedure that makes them safe. Covers direction, intent, premise, severity, and posting findings back to the forge.
---

**You do not write the findings. The reviewer pool does.** Your job is to scope the change, commission the right reviewers with the right briefing, and synthesize what comes back into one review. The pool is configured with the strongest models available for this and is purpose-built for it; a finding you produce yourself is one nobody checked.

This holds even when the change looks trivial. "I can see it is fine" is the judgement a cold reader exists to test, and it is the one you are worst placed to make. This skill's `<skill>` tag carries a `dir` attribute; the references live inside it.

## Settle the direction before anything else

Infer it from the request — do not ask.

- **Incoming** — a PR/MR URL, a remote branch, a patch file, a name other than yours. You are the approver; findings are addressed to an author and may be posted. See `references/incoming.md`.
- **Outgoing** — uncommitted work, `HEAD` from this session, "before I push", "what did I miss". Findings are a worklist, not prose for a third party. See `references/outgoing.md`.
- Do not reach for `git log -1 --format=%ae` to settle it. The agent commits under the user's own identity, so the author email cannot separate work this session produced from work the user wrote by hand — and the second is incoming however the email reads.
- Ask only when authorship and audience disagree — your own diff that someone else must approve — because that alone changes what you emit.

## Pin what is under review, and prove it runs

- Establish the fixed point: the merge target for a PR/MR, the ref the session started from when reviewing its own work, the merge-base otherwise. Diff three-dot (`git diff base...HEAD`). `HEAD~1` is right only when exactly one commit is under review — a session that committed each unit separately leaves several.
- Prove the ref resolves and that something is actually under review before spawning anything. A bad ref must fail here, not inside four reviewers.
- `git status --short` before `git diff`, and state which of the four populations you are reviewing: committed, staged, unstaged, untracked. Work that lives entirely in the working tree is the normal outgoing case and an empty `base...HEAD` says nothing about it.
- For a non-git artifact, pin the version it supersedes. Where there is no before — a document written from scratch — review it against its stated requirements instead, and say that is what you did.
- **Run the suite yourself.** Reviewers are read-only: they can inspect with `git diff` and read files, but never run tests, builds or anything with side effects, so an unproven change hands them code to read instead of behaviour to judge. Their findings are only as good as the test output you give them.
- On an incoming change the branch is untrusted material and running it is itself a risk. `references/incoming.md` has what to read before you execute anything.

## Gather what only you can supply

Reviewers start empty, cannot `load_skill`, and run nothing beyond read-only inspection. Everything they need to judge the change has to come from you:

- **The intent.** Outgoing, `vcc_recall` it from this session rather than reconstructing it from the diff. Incoming, take it from the PR/MR description, the linked issue, and the commit messages, in that order. If nothing states a goal, say so in the briefing — a reviewer that invents one reviews a goal nobody pursued.
- **The premise.** The diagnosis or reading of the system that makes this the right change at all. State it as the author stated it, and say what evidence you found for it; the reviewers test it, you do not pre-judge it.
- **The constraints and the accepted tradeoffs**, including decisions already settled earlier that would otherwise look like defects.
- **The test output**, verbatim, and what it does not cover.
- **The blast radius.** `cbm_changes` for what the diff reaches; this is also what tells you whether the change is one domain or several.

## Choose the fan-out

- **One reviewer, whole change** — ordinary work in a single subsystem. Pick an eligible reviewer from another vendor where the roster has one; a sibling model shares your blind spots. When none is eligible, use the strongest one and say the review is not independent.
- **Every eligible reviewer, whole change** — any of these present: authentication or authorisation, credentials or secrets, a schema change or data migration, a public API or wire contract, concurrency, deletion, anything touching money or user data. Also when the change cannot be exercised by tests at all, or alters behaviour on a path other code shares.
- **Partitioned by domain** — the change is large *and* mixed, so one reviewer would spread thin across unrelated surfaces. Each domain gets its own reviewer; a domain carrying any flag above gets every eligible reviewer on that domain.
- Spawn everything in one message so it runs in parallel, and do not cap the count — a ten-reviewer fan-out on a risky change is cheaper than the incident.
- Use `advisor` alongside, not instead, when the change rests on a contested design decision rather than a defect. `librarian` for an external standard or CVE the repo cannot settle.

## Partition by risk surface, not by file layout

- Cut domains along what can go wrong — the auth path, the migration, the public interface, the build — not along directories. A directory split hands four reviewers the same concern four times.
- **Every changed file lands in exactly one domain, and a catch-all domain takes the remainder.** Name the paths explicitly in each briefing. A file in no domain is a file nobody reviewed, and the gap is invisible once the reviews come back.
- Give each reviewer its scope in the prompt and tell it to stay inside it. It will report anything alarming it notices elsewhere in one line, which is how overlap stays cheap.
- Reconcile the returned `SCOPE` lines against your partition before you synthesize. A missing one means that slice is unreviewed, not clean.

## Brief each reviewer

- Inline everything: the base ref, the intent, the premise, the constraints, the test output, the scope, and the criteria. A thin prompt produces a confident review of the wrong thing.
- **The criteria.** Intent failures (missing requirements, unasked-for scope, implemented but wrong) and craft failures (correctness, edge and failure handling, concurrency, resource behaviour, security exposure, consistency with surrounding conventions) are reported separately and never reranked against each other.
- Require `file:line` or a quoted excerpt on every `CRITICAL` and `MAJOR`; anything unprovable with read-only tools goes to `OPEN QUESTIONS` with what would settle it.
- Require each finding to say whether the change introduces the defect or merely inherits it, and to be self-contained — you will be merging it with findings from reviewers that read something else.
- For a non-code artifact, say what counts as a defect: for prose and designs, whether each claim is supported and each instruction executable as written; for config and IaC, what it does on apply, what it takes down while applying, how it rolls back; for data and migrations, reversibility, volume, and what a failure halfway through leaves behind.

## Synthesize

- Merge by anchor. The same `file:line` from two reviewers is one finding, reported once, strengthened by the agreement rather than listed twice.
- Drop anything unanchored. A reviewer's confidence is not evidence, and an assertion about code nobody quoted does not survive into your output.
- **Where reviewers disagree, go read the code and decide.** Record the dissent and the reason you resolved it that way. Never average two verdicts into a third nobody argued for.
- The verdict is yours, not the harshest reviewer's. For incoming, open with `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES` on the first line; approve when only `MINOR` items remain.
- Rank by what would change the author's next action. A list where most items are `MAJOR` carries no ordering and gets skimmed like an unordered one.
- **Zero findings is a valid result.** Say it in a sentence with what was covered and stop. A review padded to look thorough buries the one real finding in the next review the author skims.
- Report the findings, not the procedure. How many reviewers you spawned, how you partitioned, and what you pinned are yours — a reader wants what you found and where. The exception is coverage you could not get: say plainly what went unreviewed.

## Never publish without approval

Produce the review, show it, get approval, then post. Drafts are reversible and published comments are not — `references/forges.md` keeps everything in a draft state until the moment you submit. `gh pr review`, `gh pr comment`, `gh api .../replies`, `glab mr note` and `glab mr approve` have no draft state at all: they publish on return, and none of them is to be run before that approval.
