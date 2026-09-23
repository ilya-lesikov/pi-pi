---
name: skill-scout
description: Load BEFORE finding, evaluating, or choosing agent skills to install — including deciding whether an existing skill is worth adopting at all, or whether to write one instead. Not for using a skill already installed.
---

The ecosystem indexes skills by install count and stars. Those measure adoption, not fitness, and the index exposes almost nothing else — so ranking by them reproduces the popularity order anyone can already see. A recommendation is worth making only once the candidate's own text has been read. Never recommend a skill whose body you have not fetched.

## Establish what is being solved

- State the task the skill would serve, in the user's own words, before searching. A scout that searches for a category returns the category's most popular member.
- Extract the constraints that disqualify a candidate: host agent, required tooling, offline or network, language and framework lock-ins, licence.
- Check what is already installed and loadable. A skill that duplicates one in `~/.pi/skills`, the project's `.pi/skills`, or pi-pi's bundled set is a finding, not a candidate.
- Decide up front what "good enough to adopt" means here. Without it every candidate looks partial.

## Search, then resolve

- Search several routes and pool the results. Each index covers a different slice and ranks by its own signal; see `references/sources.md` for the endpoints and commands.
- Search for the capability, not the label. The strongest candidate is often filed under a term the user did not use.
- An index entry is a pointer, not a location. Resolve each candidate to its real path by walking the repository tree — the id rarely encodes where the file lives.
- Stop widening once the same names recur across routes. Coverage is reached when new routes return known candidates.

## Read the candidate

- Fetch the body. Measure it. Read it in full — this is the step the existing finders skip and the only one that separates a good skill from a popular one.
- Inventory everything the skill ships, not just its body: `scripts/`, `references/`, templates, assets. A skill is the whole folder.
- Read any executable code it carries. A skill can ship scripts that run on the user's machine, so treat unreviewed code as the supply-chain surface it is and report what it does, what it reaches, and what it would need permission for.
- Judge against the rubric in `references/rubric.md`: structural quality, description-versus-body alignment, completeness, and threat surface.
- Alignment is the dominant failure mode in a bulk-generated ecosystem: a description promising far more than the body delivers. Check it on every candidate.
- Note the maintenance reality — last commit, open issues, whether one author has moved on. A dead skill is still readable, but nothing will be fixed.

## Recommend

- Lead with a recommendation and the evidence for it: quote the lines that decide it, cite line counts and paths, and name what you could not verify.
- Compare the winner against the strongest near-miss explicitly. A recommendation with no rejected alternative was not a choice.
- Separate fit from confidence. A strong match read only in part is not the same as a weak match read fully.
- Report a skill that is popular and bad as exactly that, with the evidence. Install counts are the reason it was found, never the reason to adopt it.
- Recommend writing one instead when nothing clears the bar — and say what the gap is, which candidate comes closest, and what to borrow from it. This is a legitimate outcome, not a failure to find something.
- Never install without the user's approval. Present the command and the scope; let them choose.
