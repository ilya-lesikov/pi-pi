---
name: research-and-design
description: Load BEFORE choosing between materially different designs, resolving ambiguous requirements, or acting on external technical claims. Covers evidence-led investigation and consequential decisions.
---

Use this guidance for unfamiliar domains, open-ended investigation, architecture, or choices that are expensive to reverse.

## Frame the decision

- Identify the concrete outcome, constraints, unknowns, and what evidence would distinguish the viable options.
- Recall prior decisions before asking the user to repeat them.
- Separate facts, interpretations, and assumptions. Verify assumptions that materially affect the result.

## Gather evidence

- Prefer primary sources, current documentation, observed system behavior, and repository evidence.
- Use multiple independent sources when a claim is consequential or likely to have changed.
- Record source dates, versions, and relevant limitations.
- Stop researching when additional evidence is unlikely to change the decision.

## Design proportionately

- Generate alternatives before committing to an opinion-heavy or costly-to-reverse design.
- Compare options against the actual constraints, including operational complexity and reversibility.
- Prefer the smallest design that preserves a clear path for likely evolution.
- Do not invent compatibility, abstraction, or configurability without a demonstrated need.

## Clarify only when needed

- Ask one focused question when user preference or unavailable information controls the decision.
- Show the concrete proposed wording, values, structure, or interface before requesting approval for a costly-to-reverse choice.
- If the decision is reversible and evidence supports a default, choose it, state the assumption when relevant, and continue autonomously.
