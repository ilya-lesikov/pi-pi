---
name: software-engineering
description: Load BEFORE your first source-code edit of the session and BEFORE diagnosing any non-trivial failure. Covers implementation discipline, debugging, testing, and code quality.
---

Use this guidance when the work changes or diagnoses software.

## Understand before changing

- Inspect the implementation, types, callers, and surrounding conventions before editing.
- Navigate definitions and references with language-aware tools when available. Search literal text only for literals, configuration keys, and messages.
- Trace the actual data and control flow. Compilation alone does not establish behavioral correctness.
- Match the nearest existing solution by behavior, naming, error handling, and abstraction level.

## Make the smallest sound change

- Change only what the request requires. Do not fold adjacent cleanup or speculative extensibility into the work.
- Prefer direct code over one-use helpers and unnecessary abstraction.
- Keep visibility as narrow as possible.
- Leave no temporary logging, instrumentation, dead code, TODOs, or commented-out alternatives.
- Add comments only for a non-obvious reason or required public documentation. Never narrate what the code already says.

## Prove behavior

- For a bug fix or behavior change, reproduce the failure with an automated test first when practical.
- Test observable behavior and important failure paths rather than implementation details.
- After edits, run language diagnostics on changed files and the narrowest relevant tests. Expand to broader checks when the blast radius warrants it.
- A successful build is evidence of type and integration consistency, not proof that the behavior is correct.
- If verification cannot be performed, say exactly what remains unverified and why.

## Diagnose failures

- Read the complete error and establish a minimal reproduction before proposing causes.
- Distinguish the root cause from downstream symptoms.
- After one failed real fix attempt on a difficult issue, use an independent debugger rather than repeating guesses.
- Remove diagnostic artifacts before finishing.
