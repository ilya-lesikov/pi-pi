---
name: repository-work
description: Load BEFORE the first repository change or commit. Covers repository registration, change inspection, and the pre-1.0 commit contract.
---

- Register every git repository you will work in, including the root repository. Determine the base branch by examining the current branch and remote tracking.
- After completing changes, run `cbm_changes` to verify the blast radius.
- After completing a logical unit of work—a bug fix, a test, or another independently verifiable outcome—call `pp_commit` with a descriptive message explaining what changed and why.
- Prefix the message with a conventional-commit type (`fix:`, `feat:`, or `chore:`) unless the user asked for a different commit style.
- Never use a breaking-change marker: no `!` before the colon and no `BREAKING CHANGE:` trailer.
- Keep the body to at most two short paragraphs, no more than three sentences each and approximately 500 characters total. Omit the body unless it adds rationale the subject cannot carry.
- Do not batch all changes into one commit.
