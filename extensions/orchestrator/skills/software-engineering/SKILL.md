---
name: software-engineering
description: Load BEFORE modifying source code or diagnosing a non-trivial software failure. Covers implementation, verification, testing, and failure-recovery rules.
---

## Implementation principles

- Understand before modifying. Read the code, trace callers, and check types before editing. Compiling does not establish correctness.
- Make the smallest viable change. Do what was asked, nothing more. Do not broaden scope or refactor adjacent code.
- Leave no temporary artifacts: no `console.log`, `TODO`, `HACK`, debugger, or commented-out code.
- Do not write comments that restate the code, repeat a function or variable name, narrate the obvious, or label sections.
- Add a comment only for a genuine reason the code cannot express—a non-obvious constraint, workaround, or gotcha—or for required public API documentation.
- Never comment a private symbol. Never embed volatile details that drift out of date, such as flag names, option names, constant values, or a restatement of behavior.
- Match the existing comment density. When unsure, do not comment.
- Prefer fewer, larger functions over many tiny ones. Do not extract a helper used in only one place merely to name a step. Extract only when it removes real duplication or creates an independently meaningful, reused unit.
- Keep everything as private as possible. Export or widen visibility only when cross-module use genuinely requires it, never just in case or to let a test reach an internal symbol.

## Understand the affected code

- Find relevant functions and their context before modifying them.
- Use definitions, references, hover information, implementations, and incoming or outgoing calls to understand types, callers, implementors, and call chains.
- Find structural patterns such as existing error-handling conventions.
- Before adding a type, function, or user-facing value, find how the codebase already solves the closest problem by behavior, not filename. Mirror its shape, naming, error handling, and conventions. Reading one neighboring file is not enough.
- Before modifying a function, inspect all callers.

## Verification gate

- After editing files, run language-server diagnostics and fix errors before moving on. Use code actions for applicable fixes.
- After completing changes, assess the blast radius.
- A completion claim is valid only when fresh tool output proves it.
- Identify what output proves the claim, produce that output, and cite it.
- If a claim cannot be proven with the available tools, say so and state why rather than implying verification.

## Test-first policy

- For a behavior change or bug fix where an automated test is feasible, write or reproduce the failing test first, then make it pass.
- When an automated test is not feasible—for example, configuration, migrations, documentation, a pure refactor, or no usable harness—state the verification method before editing.
- There is no universal test-first mandate and no rule to delete untested code. Choose the path that produces evidence.

## Failure recovery

- If a fix attempt fails, analyze the root cause before retrying. Do not repeat the same approach.
- After three failed attempts at the same issue:
  1. Stop editing immediately.
  2. Revert to the last working state if possible.
  3. Document what you tried and why it failed.
  4. Report the blocker; do not keep pushing.
