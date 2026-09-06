---
name: skill-authoring
description: Write or edit a Pi skill (SKILL.md) so it is discovered by the layered skill loader with the right name, description, and precedence.
---

# Skill authoring

A skill is a single `SKILL.md` file with YAML frontmatter and a markdown body.

## Location and precedence

The loader searches three layers and the first one that defines a name wins:

1. `<project>/.pi/skills` — project layer, checked in with the repo.
2. `<agent dir>/skills` — global layer, per user (`~/.pi/agent/skills` by default).
3. the bundled layer shipped inside this package.

Put a skill in the project layer to override a bundled or global skill of the
same name. Nothing is cached: editing a file changes the next load.

## Frontmatter

```
---
name: my-skill
description: One sentence saying when to use this skill.
---
```

- `name` must be lowercase letters, digits and single hyphens, at most 64
  characters, and must match the directory name.
- `description` is required, at most 1024 characters, and is the only text the
  agent sees before deciding to load the skill — write it as a trigger
  condition ("use when ..."), not as a title.

## Body

The body is loaded on demand and wrapped in a `<skill>` element, so write it as
direct instructions to the agent:

- Lead with the procedure, not with background.
- Prefer short imperative steps and concrete commands over prose.
- State preconditions and failure modes explicitly.
- Keep it self-contained; reference file paths rather than pasting large files.

## Checklist

1. Create `<layer>/skills/<name>/SKILL.md`.
2. Fill in `name` and `description`.
3. Write the procedure body.
4. Confirm the skill is listed, and that the resolved layer is the one intended.
