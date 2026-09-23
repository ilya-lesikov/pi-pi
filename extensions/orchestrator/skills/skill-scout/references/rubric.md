# Judging a skill you have read

Four axes. Alignment and threat surface are pass/fail — a candidate failing either is rejected whatever else it scores. Structure and completeness are judgements, reported with the evidence that produced them.

Do not compute a composite score. Weighted formulas over judgemental dimensions ("stars 35%, installs 35%, description 15%") look objective and are arbitrary; the existing finders all publish one. Report the axes separately and let the tradeoff stay visible.

## 1. Alignment — does the body deliver what the description promises

The dominant failure mode in an ecosystem where most skills are bulk-generated. The description is what the host agent sees at startup and what makes it load the skill; an overpromising description wastes context on every session it triggers, and misfires on tasks the body cannot serve.

- Take each capability the description claims. Find where the body delivers it. A claim with no corresponding section fails.
- Check the trigger conditions: does the body actually cover the situations the description says to load it for?
- Check the converse — substantial behaviour in the body that the description never mentions means the skill will not be loaded when it should be.
- A description that is mostly adjectives ("comprehensive", "production-ready", "battle-tested") with a thin body is the signature case. Report it plainly.

## 2. Threat surface — what it does on the machine

A skill is a folder, and it can ship executable code. Inventory the whole folder before judging.

- List every file. Read anything executable: `scripts/`, hooks, anything the body tells the agent to run.
- Name what that code touches: network, filesystem outside the project, credentials, package installs, shell invocations built from unvalidated input.
- Flag anything fetched at runtime from a URL the skill controls — that is remote code execution with extra steps, and it defeats the review you are performing.
- Flag instructions that tell the agent to bypass confirmation, disable safety checks, or run with elevated permissions.
- A skill with no scripts and no runtime fetches has essentially no threat surface. Say so, briefly, rather than leaving it unstated.

## 3. Structure — Anthropic's published criteria

From the official authoring guidance. These are the format authors' own standards, which is why they beat invented ones.

- **Length.** SKILL.md under ~500 lines. Past that it is a document, not a skill, and it competes with the conversation for context every time it loads.
- **Concision.** It should add only what the model does not already know. A skill explaining what a PDF is, or what a library is, is spending the user's context on nothing.
- **Progressive disclosure.** Heavy material belongs in `references/` and `scripts/`, loaded on demand, not inlined in the body.
- **Degrees of freedom matched to the task.** Fragile, order-dependent operations want exact commands; open-ended judgement wants direction, not a script. A skill prescribing rigid steps for a judgement call — or hand-waving through a fragile sequence — is mismatched.
- **Description in third person**, stating both what it does and when to use it. First- or second-person descriptions degrade selection.
- **Name** lowercase, hyphenated, specific. `helper`, `utils`, `tools` are not names.
- **No voodoo constants.** Numbers and thresholds should be explained or derivable, not asserted.

## 4. Completeness — will it hold up in use

- Concrete examples rather than only abstractions.
- Explicit handling of the failure cases the task actually has.
- Any bundled script solves a real problem rather than restating the body in code.
- Evidence it was tested: evaluations, examples with expected output, a test harness. Anthropic's `skill-creator` expects at least three evaluations; almost nothing in the ecosystem has them, so treat their presence as a strong positive rather than their absence as disqualifying.

## Maintenance, read honestly

Activity is context, not a criterion. A sharp 90-line skill last touched a year ago may be perfectly good — the format is stable and the text still reads correctly. What matters is whether anything would get fixed if it broke, which decides how much you depend on it, not whether it works today.

Scope the check to the skill's own path, not the repository. A monorepo's commit rate says nothing about one file in it.

## Popularity

Install counts and stars are how a candidate was found, never why it is adopted. They measure how many agents copied a folder, which happens before anyone reads it and never reverses.

When a heavily-installed skill reads badly, say so with the evidence — that is the most useful single finding a scout can return, and the reason reading bodies is worth the calls it costs.

## When nothing clears the bar

Recommending that the user write their own is a real outcome, and it needs the same evidence as a recommendation to adopt:

- What the gap is, concretely — the capability no candidate covers.
- Which candidate comes closest, and what specifically to borrow: a rubric, a phase structure, a checklist.
- Whether the gap is worth a skill at all. A one-off need is a prompt, not a skill; a skill earns its keep by being loaded repeatedly.
