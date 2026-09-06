---
name: repository-work
description: Version-control safety, repository conventions, worktrees, diffs, commits, and change hygiene
---

Use this guidance when work occurs in or modifies a version-controlled repository.

## Establish repository state

- Register every repository before changing it and identify the branch the work will merge into.
- Inspect status, current branch, remotes, and relevant repository instructions before edits.
- Treat pre-existing modifications as user work. Never overwrite, stash, discard, or rewrite them without explicit authorization.
- In multi-repository work, track and verify each repository independently.

## Work safely

- Keep changes scoped to the request and preserve local conventions.
- Do not switch branches or rewrite history merely to simplify your workflow.
- Use an isolated worktree only when parallel modification genuinely requires it or the user asks for one.
- Never include secrets, generated noise, editor state, temporary files, or unrelated formatting churn.

## Inspect changes

- Review the complete diff and status before reporting completion.
- Check for whitespace errors, accidental deletions, unrelated changes, and missing new files.
- Assess consumers and blast radius for modified interfaces or shared behavior.
- Verify from the final repository state, not from memory of intended edits.

## Commit coherent units

- Commit only after a logical unit is complete and verified.
- Use a concise message describing what changed and why.
- Do not amend, force-push, or create commits unless the user or environment authorizes commits.
- Report the resulting branch and commit identity when a commit was created.
