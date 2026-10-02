# Reviewing your own work before it ships

No audience, no diplomacy, no verdict line. The output is a worklist. The whole difficulty is that you already believe this change is correct.

## Defeat the obvious failure mode

- You cannot review your own reasoning by rereading it. Re-deriving an argument reproduces it; the error survives the second pass intact. Attack the change from outside: run it, break it, or hand it to the reviewer pool cold.
- `vcc_recall` what was actually asked, in the user's words, before looking at the diff. Mid-implementation drift is the most common outgoing finding and it is invisible from inside the diff.
- Read the diff in the reverse order you wrote it. The last file written gets the least scrutiny and holds the most haste.
- List what you decided silently — a default, an error path, a name, a dependency — and check each against the request. The ones that conflict with it are findings; the rest are assumptions to surface in your report, not defects to pad the list with.

## Check the things tests do not

- Every changed symbol: `lsp findReferences` and `incomingCalls`. A signature or behaviour change is only as safe as its callers, and the suite exercises the callers you remembered.
- `cbm_changes` for the blast radius you did not intend. A file in the diff you cannot justify is either scope creep or a stray edit.
- Diff hygiene: debug output, commented-out code, a `TODO` you left for yourself, a test skipped to get green, a fixture that is now unused.
- What the suite proves. "Tests pass" is not evidence for a path no test covers — name the uncovered paths explicitly rather than letting green stand in for coverage.
- Run the suite before delegating. The reviewer pool is read-only and cannot run anything; a reviewer handed unproven code reviews the code and not the behaviour.

## Delegate the cold read

- Brief the reviewer with the intent, the constraints, the accepted tradeoffs and the test output. It has no access to this skill, cannot run anything, and reconstructing intent from a diff means reviewing a goal it invented.
- A reviewer finding you disagree with gets checked, not argued with. Verify against the code; if it is wrong, say what you checked and why it does not apply. If it is right, fix it and move on without ceremony.

## Before the commit or the push

- Each commit is one independently verifiable unit, staged deliberately — not everything that happens to be dirty.
- The message says what changed and why; the subject is in English with a conventional-commit type.
- Nothing in the diff that the request did not call for. An improvement you noticed is a separate commit or a note in your report, never a passenger.
- State plainly in your report what you could not verify, and what would verify it. An unverified claim that passes silently into a report is the one that costs trust.
