# Repository Guidelines

All rules in this document are requirements — not suggestions. ALWAYS follow them.

## Highest-priority rule (MANDATORY)

- NEVER add comments unless they document a non-obvious public API or explain genuinely non-obvious logic. NEVER add comments that restate what the code does, repeat the field/function name, describe obvious error handling, or act as section separators. When in doubt, don't comment.
- ALWAYS verify, don't assume — check the actual state before making changes.
- ALWAYS start with the simplest possible solution. If it works, stop. Add complexity only when justified by a concrete, current requirement — NEVER for hypothetical future needs.
- NEVER leave TODOs, stubs, or partial implementations.
- ALWAYS stay within the scope of what was asked. When asked to update a plan — only update the plan, don't change code. When asked to brainstorm/discuss — only discuss, don't write code. When asked to do X — do X and nothing else. NEVER make unsolicited changes.

## Code style

### Design (MANDATORY)

- ALWAYS prefer stupid and simple over abstract and extendable.
- ALWAYS prefer a bit of duplication over complex abstractions.
- ALWAYS prefer clarity over brevity in names.
- ALWAYS minimize interfaces, generics, embedding.
- ALWAYS prefer fewer types. Prefer no types over few. Prefer data types over types with behavior.
- ALWAYS prefer functions over methods. ALWAYS prefer public fields over getters/setters.
- ALWAYS keep everything private/internal as much as possible.
- ALWAYS validate early, validate a lot. ALWAYS keep APIs stupid and minimal.
- NEVER prefer global state. ALWAYS prefer simplicity over micro-optimizations.
- ALWAYS use libraries for complex things instead of reinventing the wheel.
- NEVER add comments unless they document a non-obvious public API or explain genuinely non-obvious logic. NEVER add obvious/redundant comments, NEVER add comments restating what code does. When in doubt, don't comment.

