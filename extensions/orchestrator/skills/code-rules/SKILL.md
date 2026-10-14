---
name: code-rules
description: Load BEFORE writing or editing source code, and name it in the skills parameter of every subagent spawned to write code. Covers scope, comments, visibility, function shape, leftovers, and the checks that must pass after an edit.
audience: any
---

These rules apply to whoever is editing the code, whether that is the main agent or a subagent writing one slice. This repository's own conventions win wherever they differ: a linter config, a style guide, the density of comments in surrounding code. When those conventions are silent, these rules apply.

## Before you edit

- Read the code you are changing and every caller of the function you are changing. Code that compiles has not thereby been shown to be correct.
- Find the closest existing code that does something similar, judged by behaviour rather than filename. Mirror its naming, error handling, data shapes and test layout.

## Scope

- Make the smallest change that delivers what was asked. Do not refactor adjacent code, rename things in passing, or reformat lines you did not otherwise change.
- Note an improvement you spotted in your report. Do not make it.

## Comments

- Comment only what the code cannot say: a non-obvious constraint, a workaround and the reason for it, or a gotcha the next reader would otherwise walk into. Required public API documentation is the other exception.
- Do not restate the code, repeat a name, narrate the obvious, or label sections.
- Do not put volatile details in a comment: flag names, constant values, or a restatement of behaviour that will drift out of date.
- Match the comment density of the surrounding code. When unsure, leave the comment out.

## Shape

- Keep every symbol as private as the language allows. Widen visibility only for a real cross-module caller, never just in case, and never only so that a test can reach it.
- Do not extract a helper that is used once merely to give a step a name. Extract when it removes real duplication or creates a unit that is meaningful and reused.
- Leave nothing temporary behind: no debug output, no `TODO` or `HACK` you added, no commented-out code, no skipped test, no fixture nobody uses any more.

## After every edit

- Run language-server diagnostics on each file you changed, and fix what you introduced before you move on.
- Run the tests that cover the change. A test you wrote counts only once you have seen it fail without your change and pass with it. When the task is only to add tests for code that already works, break the code each test covers instead, watch the test fail, and restore the code exactly. A test that cannot fail is padding.
- Report what you ran and what it showed. If something could not be verified, say what and why rather than implying that it passed.
