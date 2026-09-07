---
name: repository-work
description: Load BEFORE the first repository change or commit. Covers base-branch discovery, change inspection, and the commit contract.
---

- For every git repository you will work in, including the root repository, determine the base branch (the branch this work will be merged into) by examining the current branch and its remote tracking before making changes.
- After completing changes, run `cbm_changes` to verify the blast radius.
- After completing a logical unit of work—a bug fix, a test, or another independently verifiable outcome—commit it with `git` using a descriptive message explaining what changed and why. Stage only the files that belong to that unit.
- Prefix the message with a conventional-commit type (`fix:`, `feat:`, or `chore:`) unless the user asked for a different commit style.
- Never use a breaking-change marker: no `!` before the colon and no `BREAKING CHANGE:` trailer.
- Keep the body to at most two short paragraphs, no more than three sentences each and approximately 500 characters total. Omit the body unless it adds rationale the subject cannot carry.
- Do not batch all changes into one commit.
