---
name: git-work
description: Load BEFORE the first commit in a repository, and BEFORE any git operation beyond committing — merge or rebase a branch, resolve conflicts, cherry-pick, sync a fork or vendored copy with upstream while keeping local patches, find when or why something changed, or summarize changes since a tag or release ("что изменилось с прошлого тега", changelog, release notes, "смержи main", "обнови до апстрима"). Covers the commit contract, conflict resolution by intent, large drift, patch preservation, history archaeology, and release notes.
---

Git operations are where an agent destroys work quietly. Every procedure here starts by making the current state recoverable and ends by proving the result builds and behaves. This skill's `<skill>` tag carries a `dir` attribute; `references/history.md` is inside it.

## Before anything

- Find the base branch, meaning the branch this work merges into, from the current branch and its upstream. Do not assume `main`.
- Run `git status --short` and decide whose each dirty file is. Work you did not make in this session is the user's: never stash it, reset it, or sweep it into your commit.
- Before a merge, rebase, cherry-pick series or upstream sync, record where you started: `git branch backup/<name>-<date> HEAD`. A recovery ref costs nothing, and `reflog` is a poor substitute once several operations have run.
- Never rewrite published history, force-push, or delete a remote branch without the user's explicit go-ahead for that specific operation. Approval to "merge main" is not approval to force-push. When a force-push is approved, use `--force-with-lease`.

## Commits

- Commit after each logical unit: a fix, a test, or another outcome that can be verified on its own. Stage only the files that belong to that unit.
- Write the subject and the body in English, whatever language the conversation is in.
- Prefix the subject with a conventional-commit type (`feat:`, `fix:` or `chore:`) unless the repository or the user uses another style. Read `git log --oneline -20` to find out.
- Never use a breaking-change marker: no `!` before the colon and no `BREAKING CHANGE:` trailer.
- Keep the body to at most two short paragraphs of no more than three sentences each, about 500 characters in total. Omit it unless it carries a reason the subject cannot.

## Resolving conflicts

- Run the operation with `git -c merge.conflictstyle=zdiff3 merge …` (or `rebase`, `cherry-pick`), so that each conflict shows the common ancestor as well as both sides, without editing the user's config. Without the ancestor you cannot tell which side changed what.
- Resolve by intent, never by picking a side wholesale. For each conflicted hunk, read why each side changed it: `git log -p --merge -- <file>` lists the commits on both sides that touched the file. Then write the code that does what both sides wanted. "Keep both" is not a resolution when the two changes are incompatible. Say which intent won and why.
- A conflict-free merge can still be wrong. A function renamed on one side and given a new caller on the other merges cleanly and fails to build. Build and run the tests after every resolution step, not once at the end.
- When a resolution needs a judgement about behaviour the user owns, such as which of two incompatible features survives, stop and ask.

## Large drift

When a merge or rebase brings in a lot of change at once:

- Measure it first: `git log --oneline base..target | wc -l`, and `git diff --stat $(git merge-base HEAD target) target` to see which areas changed.
- Merge in steps rather than all at once. Pick landmark commits on the incoming side (releases and large merges from `git log --oneline --merges base..target`, and the commits touching your hot files from `git log --oneline base..target -- <paths>`) and merge up to each one in turn, building and testing at each step. A broken step then points at a small range.
- Turn on `git config rerere.enabled true` so that a conflict you resolve once is reapplied if you need to redo a step. This one does persist in the repository config: say so in your report.
- Keep a short ledger in your checklist: the step, the conflicts it produced, how each was resolved, and the test result. The user needs exactly that list afterwards.
- Prefer a merge to a rebase for a long-lived branch that others have seen. Rebase only private work, and only with approval if it was pushed.

## Syncing a fork or vendored copy with upstream

The danger is losing a local patch silently: one that no longer applies, or one that upstream made unnecessary in a slightly different way.

- If the repository documents its vendoring (a `LOCAL-PATCHES.md`, a vendor script, a `subtree` make target, contract tests that guard the patches), that procedure and its guard tests win over everything below.

- Inventory the local patches before touching anything. For a fork, find upstream's branch first (`git remote show upstream`), then use `git log --oneline <upstream>/<branch>..HEAD`, plus `git cherry -v <upstream>/<branch> HEAD` to see which of them upstream already contains. For a vendored copy in a subdirectory, find the commit or version it was imported at, then use `git log --oneline -- <dir>` since that import. For `git subtree`, the last subtree merge is the import point (`git log --merges --oneline -- <dir>`), and after `git subtree pull` the guard tests run before anything else. Look for local-patch markers the repo uses, such as `LOCAL PATCH` comments.
- Classify each patch: upstream now has it (drop it), still needed (reapply it), or conflicts with the new upstream design (rework it, and that may be the user's call).
- Apply the new upstream first, then reapply the remaining patches one at a time as separate commits, each with its tests. Use `git range-diff` to compare the old patch series against the reapplied one, so that you can show each patch survived intact.
- Report the inventory: patches dropped and why, patches reapplied, patches reworked, and anything upstream changed that a local patch relied on.

## Cherry-picks

- Use `git cherry-pick -x`, so that the commit records where it came from.
- Check what the commit depends on before you pick it: `git log --oneline <commit>~10..<commit> -- <its files>` on the source branch shows the earlier commits it may need. A cherry-pick that applies cleanly but depends on an earlier change builds against code that is not there.
- When the target branch has diverged, adapt the change to the target's code rather than forcing the source's shape onto it, and say what you adapted.

## Finding when and why something changed

Read `references/history.md`. In short: use `git log -S` or `-G` to find when a string or pattern appeared, `git blame -w -C -C` to see past moves and whitespace, `git log -L` to follow one function's history, and `git bisect run` with a script that exits non-zero on the bad behaviour to find the commit that broke it.

## Release notes and "what changed since"

- Find the range from the tags, not from memory: `git describe --tags --abbrev=0` gives the last tag reachable from `HEAD`. When the user names the tag instead, check it with `git merge-base --is-ancestor <tag> HEAD` before trusting the range.
- Read the changes, not just the subjects. A subject says what the author thought they did, and a `chore:` commit can change user-visible behaviour. For a long range, triage: `git log --stat <tag>..HEAD` first, the full diff for anything whose effect is not obvious, and the PR or MR description for the reason.
- Group the changes by what a user notices, and rank them by importance rather than by commit order. Merge commits and reverts that cancel out are not changes.
- When the user gives a sample of a previous release note, mirror its structure, language, length and tone exactly.
- Do not invent impact. If you cannot tell what a change does for a user, say so rather than guessing.
