# Reviewing your own work before it ships

No audience, no diplomacy, no verdict line. The output is a worklist. The whole difficulty is that you already believe this change is correct — which is exactly why the findings come from reviewers and not from you.

## Why this direction is delegated hardest

- You cannot review your own reasoning by rereading it. Re-deriving an argument reproduces it; the error survives the second pass intact. The cold read is the only thing that breaks that, and the smaller the change looks the more certain you are and the less that certainty is worth.
- Rate your confidence before the reviews come back, and treat a large gap between it and what they return as information about your judgement, not about the pool.
- A reviewer finding you disagree with gets checked, not argued with. Verify against the code; if it is wrong, say what you checked and why it does not apply. If it is right, fix it and move on without ceremony.

## What only you can put in the briefing

- `vcc_recall` what was actually asked, in the user's words. Mid-implementation drift is the most common outgoing finding and it is invisible from inside the diff — and invisible to a reviewer that never saw the request.
- Everything you decided silently: a default, an error path, a name, a dependency. Hand the list over rather than ruling on it. The ones that conflict with the request are findings, and it is not you who should decide which those are.
- What the suite proves and what it does not. "Tests pass" is not evidence for a path no test covers — name the uncovered paths in the briefing rather than letting green stand in for coverage.
- The blast radius you did not intend: `cbm_changes`, plus `lsp findReferences` and `incomingCalls` on changed symbols. A file in the diff you cannot justify is either scope creep or a stray edit, and either way the reviewers need to know you noticed.
- Diff hygiene you can see from here — debug output, commented-out code, a `TODO` left for yourself, a test skipped to get green, a now-unused fixture. Listing these in the briefing stops several reviewers spending their pass on the same lint.

## Before the commit or the push

- Each commit is one independently verifiable unit, staged deliberately — not everything that happens to be dirty.
- The message follows the commit contract in `git-work`.
- Nothing in the diff that the request did not call for. An improvement you noticed is a separate commit or a note in your report, never a passenger.
- State plainly in your report what you could not verify, and what would verify it. An unverified claim that passes silently into a report is the one that costs trust.
