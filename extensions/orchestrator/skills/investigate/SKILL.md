---
name: investigate
description: Load BEFORE answering how something works, why it behaves a certain way, or how two things compare, when the answer depends on real code, docs or systems rather than general knowledge — "how does X work", "explain this repo", "what is this for", "analyze", "compare A and B", "make a table", "does X support Y", "read this thread and tell me", "как работает", "разберись", "сравни". Covers reading the actual source over recalling it, cited answers, fair comparisons, and leaving things unchanged. Not for a request to change code.
---

An answer from memory and an answer from the source read the same, and only one of them is right about this version. The difference shows up as a confident claim about a function that was renamed last year, a default that changed, or a feature the other tool added since. Read the thing, and cite where you read it.

## Scope it

- The deliverable is an answer, not a change. Do not edit, fix, commit or "tidy up" anything along the way, even when you find a bug. Report the bug in the answer.
- Settle what is being asked about: which repository, which version (a branch, a tag, the installed one), and what level of detail the user needs. A version-sensitive question answered about the wrong version is a wrong answer.

## Read the source, not your memory of it

- Trace the actual path. Find the entry point, follow the calls with `lsp` and `cbm_trace` down to where the behaviour happens, and read the implementation rather than inferring it from names. File names and function names say what someone meant, not what the code does.
- When the question is about a tool or library outside this repository, read its source at the version in use: the installed copy (`node_modules`, the Go module cache, `site-packages`), or a clone pinned to the tag. Its documentation is evidence too, but code wins when they disagree, and the disagreement is itself worth reporting.
- For a broad question ("what is this repo", "how is X organised"), spawn 2–3 `explore` agents in parallel on orthogonal parts, then read the files they name yourself before writing the answer. For questions outside the repo, a `librarian`.
- Check your claims against behaviour where that is cheap: run the command, call the function in a scratch script, read the test that pins the behaviour.
- Answers go wrong on the paths nobody exercises. For each behaviour the user will rely on, trace the error branches and the boundaries (missing, empty, zero, malformed, partially valid input, a value that falls through a silent `catch`), not just the path that works.

## Answer with evidence

- Lead with the answer in one or two sentences, then the detail that supports it.
- Attach a `path:line` or a pinned link to each claim that matters, especially any claim the user might act on. A claim you could not check gets marked as such ("from the docs, not verified in code", "from memory").
- Say what you did not look at. A sound answer about the half you read is fine. The same answer presented as covering the whole thing is not.

## Comparing two things

- Compare them on the user's criteria, the things they will actually decide with, not on whatever happens to be easy to list.
- Read both sides to the same depth. A table where one column comes from the source and the other from a README or from memory is not a comparison.
- Cite each cell that is not obvious. Mark a difference that only exists in the docs, a capability behind a flag or a plugin, and a cell you could not determine. "Unknown" beats a guess.
- End with what the comparison means for the user's decision, and what would change it.

## Threads, tickets and someone else's problem

- When asked to read a thread or ticket and help, separate what the reporter observed from what they concluded. Check the conclusion against the code or the system before repeating it.
- If the help ends up as a reply to someone, draft it for the user to send. Do not post it yourself.
