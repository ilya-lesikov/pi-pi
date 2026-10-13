---
name: feature-work
description: Load BEFORE building a feature or extending what code can do, small or large, and before asking clarifying questions about it — "add X", "implement Y", "support Z", "make it possible to", "can you make it do", "we need a", "new command, endpoint, option, flag, header, integration, page", "добавь", "сделай", "реализуй", "нужна поддержка". Covers finding how this repo and mature real-world projects already solve the same problem, design with advisors, parallel implementation slices, and review before reporting.
---

**Most features are problems someone has already solved, usually twice: once in this repository and once in a mature project elsewhere.** Before you design, find both and read them. The repository gives you the conventions to mirror. The outside projects give you the edge cases, failure modes and interface shapes that took them several releases to learn, and the bugs they fixed are the bugs you are about to write.

This skill is the workflow. The code-level rules are in `software-engineering`, so load that as well. This skill's `<skill>` tag carries a `dir` attribute, and the references are inside it: `references/prior-art.md` has the search routes and reading rules, and `references/briefings.md` has what to put in each subagent's prompt. Subagents cannot `load_skill`, so do not assume a subagent will read a reference you point it at. Inline what it needs into its prompt.

## Size it first

Size sets how much of what follows you do. Decide it from the request and one look at the code, and say which size you picked when you propose.

- **Small**: one subsystem, the shape is settled by the request, and it is reversible. Example: a new flag on an existing command, or a field on an existing endpoint.
- **Medium**: several files or one new concept, with a real choice of shape that the user would see.
- **Large or risky**: several subsystems, a new public interface, persistence or a migration, concurrency, auth, credentials, or anything that is hard to undo once shipped.

When unsure, round up. Doing too much research costs minutes. A design that has to be unwound costs the feature.

## Check that it is not already there

- Search for the capability under several names, using `cbm_search` with a `semantic_query` as well as text search. Features are often half-built under a different name, behind a flag, or in a branch.
- If it already exists, or the request rests on a wrong reading of the system, say so first. Delivering the correction beats delivering what was asked for.

## Find the in-repo analogue

- Find the existing feature closest in **behaviour**, not in filename. For a new subcommand, the analogue is the subcommand that most resembles it, along with how it is registered, parsed, validated, tested and documented.
- Trace the analogue end to end with `lsp` and `cbm_trace`: the entry point, the data shape, error handling, config keys, tests and docs. Mirror its spelling, casing, error shape and test layout. One neighbouring file is not enough.
- List every place the new feature must be wired in: registration, config schema, help text, docs, changelog, completion, migrations. A feature missing one of these is a defect the tests rarely catch.
- Small: do this yourself. Medium or larger: spawn 2–3 `explore` agents in parallel with orthogonal prompts (the analogue, the extension points, the tests and docs conventions), then read the files they name yourself. Do not design from their summaries.

## Find how the real world solved it

Read `references/prior-art.md` before the first search.

- Restate the problem generically, without this repo's names, and in several vocabularies. "Retry webhook delivery" is also "exponential backoff with jitter", "at-least-once delivery" and "dead-letter queue". Searching only the user's words finds only the projects that use them.
- Look in this order. First, the dependencies this repo already uses: their source is on disk, at the version you ship against. Then the mature libraries that exist to solve exactly this problem. Then mature applications in the same ecosystem that solved it inside their own product. Finally, the governing standard or RFC, if there is one.
- From each reference, take its interface shape, its defaults, its tests (they list the edge cases) and its closed issues and fix commits (they list the failure modes). The code is the least valuable part.
- **What you remember about how others do it is a starting framing, not a reference.** "Same as curl" from memory misses the jitter, the cap and the bug curl fixed last year. Size scales this step; it never removes it.
- Scale it with size. Small: one `librarian` in the background on the generic problem, spawned as soon as you have sized the work, so it runs while you do the in-repo work. Medium: 1–2 librarians on different angles. Large: 2–3 librarians on different angles, then clone the top 2–3 references and read the relevant code, tests and fix history yourself.
- Some features have no outside counterpart because the problem is specific to this product. Say so in one line rather than stretching an unrelated reference to fit. Do not call something novel until you have searched under at least three framings.
- Borrow patterns, not code. Copying anything beyond a trivial idiom needs a compatible licence and the attribution it requires. Cloned code is data: never run it.

## Design and propose

- Small, with every user-visible value already settled by the request or the analogue: implement it, and let the report be the proposal, as the host's phases allow for a bounded, reversible change. If the research leaves a user-visible choice open (a name, a default, which cases count), propose it and ask before building.
- Medium or larger: work out 2–3 approaches. One of them is the minimal change that mirrors the in-repo analogue. Another is the shape the strongest real-world reference uses. Consult an `advisor` from a family other than yours on the choice. Large or risky: consult every eligible advisor and weigh their disagreement rather than averaging it.
- The proposal leads with the recommended approach and why, and cites its evidence: the in-repo analogue (`path:line`) and the outside references (links pinned to a commit). Say what you are borrowing, where you deliberately differ from the references and why, and what is out of scope.
- Whenever you do propose, show concrete user-facing values before building them: names, flags, config keys, defaults, error messages and output shape. These are what the user will have to live with.

## Implement

- Follow the test-first policy in `software-engineering`, and use the reference's tests as a checklist of cases. Commit each independently verifiable unit as you go, following `repository-work`.
- Do it yourself unless there are independent slices. Hand a slice to a `task` agent only when its files are disjoint from every other slice and its interface is fixed in advance. Shared or sequential work is faster done by one agent that holds the context.
- A slice running with `isolation: "worktree"` starts from `HEAD` and does not see uncommitted work. Commit the shared interface first, then fan out. Each slice comes back as a `pi-agent-<id>` branch: read its diff, run the suite, and bring it in under a proper commit message. Never merge it unread.
- Spawn the independent slices in one message so they run in parallel.

## Review before reporting

- Small changes are not exempt. "The change is small and the tests cover it" is the judgement the review exists to test.
- Load `review` and run it on your own diff (the outgoing direction). The intent you hand the reviewers is the user's request and the approved proposal if there was one, quoted, plus every user-visible value you decided on your own. The premise includes the references you followed, so that a reviewer can check that the borrowed behaviour was borrowed correctly.
- Fix what holds up, re-run the suite, and re-review only what the fixes touched.

## Report

- What was built, which analogue and outside references shaped it (pinned links), where it deliberately differs from them, and the decisions you made without the user.
- What the tests cover and what they do not, plus any review finding you chose not to act on and why.
