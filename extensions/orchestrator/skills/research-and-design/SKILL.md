---
name: research-and-design
description: Load BEFORE open-ended research, design work, architecture decisions, or writing an implementation plan.
---

## Clarify and investigate

- If the request is ambiguous, ask one focused question, then wait for the answer before asking the next. Do not batch a list.
- Skip questions the request already answers.
- The first answer to a design question is often the polished or surface answer; push once more on it—what would that actually look like, or what breaks if it changes—before moving on.
- Research, explore, and design without interrupting mid-flow. Collect uncertainties and clarify them after the investigation. Only a genuine blocker justifies interrupting the work.
- Delegate research where useful. Spawn multiple explores in parallel for broad searches.
- Use code-structure tools to understand the affected pieces and how they connect.
- Resolve open questions through research or focused user questions. Do not leave a passive backlog of decisions that can be settled now.

## Explore the design space

- Identify two or three viable approaches, weigh their tradeoffs, and lead with a recommended direction and why.
- If the task spans independent subsystems, triage that up front and decompose it rather than treating it as one blob.
- Do not dismiss work as too simple to need design. Unexamined assumptions in simple work cause wasted effort.
- When giving a judgment, take a position and state what evidence would change it. Do not hedge without landing anywhere or offer empty validation.
- Before presenting a consequential recommendation, get an independent opinion from an advisor whose model family differs from yours. Escalate to more advisors for hard or high-stakes calls.
- Before finalizing concrete, costly-to-reverse, or opinion-heavy choices—exact wording, structure, naming, default values, or interface signatures—show the actual proposed text or values and get explicit approval. Do not silently invent and bury them.

## Write plans when requested

- Treat the user’s explicit constraints, chosen language or framework, and scope as locked predicates. Discard suggestions that violate them.
- If competing proposals contradict each other on a locked decision, surface the contradiction to the user rather than silently inventing a compromise.
- State scope in two to four lines: what changes, what does not, and the critical constraints.
- Express each checklist item as an independently verifiable outcome with an observable done condition.
- Include how each outcome will be verified.
- For work intended for parallel delegation, state the interface it consumes and produces.
- Resolve decisions before implementation; an item that defers a decision is not a complete plan.
- When adding a type, function, parser, annotation, config key, enum, or user-facing value, identify the closest existing behavioral analogue and the conventions to mirror: data shape, spelling and casing, parser shape, validation, and error handling.
- Describe outcomes rather than code-level mechanics, except where concrete existing analogues and conventions are acceptance criteria.
