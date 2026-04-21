# Inline Gaps & Bullet List Coverage

## Inline Formatting — Known Gaps

### Strikethrough

This feature is ~~deprecated~~ and should be removed.

The old ~~`legacyMode` flag~~ has been replaced by `modernMode`.

### Nested and Combined Emphasis

This is ***bold and italic*** at the same time.

Here is _**underscore italic wrapping bold**_ text.

And **_bold wrapping underscore italic_** text.

Single *italic* and **bold** beside each other with no space: *italic***bold**.

### Backslash Escaping

Literal asterisk: \*not italic\*

Literal underscore: \_not italic\_

Literal backtick: \`not code\`

Literal bracket: \[not a link\]

### Autolinks

Visit <https://plannotator.ai> for more info.

Send mail to <hello@plannotator.ai>.

### Link Reference Definitions

Here is a [link to the docs][docs] and another [link to the repo][repo].

Also a [bare reference][docs] used twice.

[docs]: https://plannotator.ai/docs
[repo]: https://github.com/backnotprop/plannotator

---

## Bullet Lists — All Types

### Unordered — Dash

- First item
- Second item
- Third item

### Unordered — Asterisk

* Alpha
* Beta
* Gamma

### Ordered — Basic

1. First step
2. Second step
3. Third step

### Ordered — Arbitrary Numbers (should renumber 1, 2, 3)

1. First
99. Second
3. Third

### Ordered — Starting at Non-1

5. Item five
6. Item six
7. Item seven

### Checkboxes — Unchecked

- [ ] Write tests
- [ ] Review PR
- [ ] Deploy to staging

### Checkboxes — Mixed

- [x] Install dependencies
- [x] Configure environment
- [ ] Run integration tests
- [ ] Write release notes

### Ordered + Checkbox (GitHub style)

1. [x] Design spec approved
2. [x] Implementation complete
3. [ ] QA signoff
4. [ ] Shipped

---

## Nested Bullets

### Two Levels — Unordered

- Top level item A with enough text that it will wrap across multiple lines when viewed in a normal browser window at typical zoom levels
  - Nested under A, also with a longer description so we can confirm the bullet stays pinned to the top of the text and does not drift to the vertical center of the whole item
  - Another nested item under A with similar verbosity to make the wrapping behavior clearly visible during manual testing
- Top level item B which also has a fair amount of text to ensure it wraps and we can see how the marker aligns relative to the content block beneath it
  - Nested under B with extra detail: this item intentionally runs long so the bullet alignment fix is obvious even at wide viewport widths

### Three Levels — Unordered

- Level one — this is a long item that spans multiple lines so we can verify the top-alignment fix holds at the outermost nesting level, not just for deeply nested content
  - Level two — also written with enough words to cause line wrapping, confirming the fix applies consistently across all indentation levels and is not just a one-off
    - Level three — the deepest level in this section, with enough prose to wrap at least once so the bullet position relative to the first line is clearly observable
    - Another level three item with similar length to the one above, included so we have two consecutive wrapping items at the deepest level
  - Back to level two with a longer description than before so this item also wraps and we can spot any regression between siblings at the same nesting depth
- Another level one item, intentionally verbose so it wraps and gives us a second data point at the top level for the alignment check

### Mixed Ordered and Unordered

1. First ordered item written with enough detail to push it past a single line, confirming that the top-alignment fix works for ordered markers as well as plain bullets
   - Unordered child with a long enough description that it wraps, so we can see the bullet sit at the top of the wrapped content rather than floating in the middle
   - Another child item, equally verbose, to verify consistent alignment across sibling items within the same parent
2. Second ordered item, also long enough to wrap, giving us a second ordered marker to inspect for correct top alignment
   - Child of second ordered item, written long so the bullet wraps and the alignment is testable without squinting
3. Third ordered item to round out the list with a similarly verbose description for consistency

### Ordered Nested

1. Phase one — introductory work that sets up the environment, configures dependencies, and establishes the baseline from which all subsequent phases will build
   1. Task A involves researching the current implementation and documenting all the edge cases that need to be addressed before moving forward
   2. Task B covers writing the initial draft of the solution, including inline comments explaining the rationale behind each non-obvious decision
2. Phase two — the main implementation phase where the bulk of the work happens and the majority of the codebase changes are introduced
   1. Task C is the core refactor, touching the parser, the viewer, and the list marker component in a coordinated way to avoid regressions
   2. Task D is the follow-up cleanup pass that removes dead code, updates tests, and ensures the diff engine still produces correct output after the changes
      1. Sub-task D1: update parser tests to cover the new list continuation logic added during the refactor
      2. Sub-task D2: rebuild all build targets in the correct order and run a full manual smoke test against the test fixtures before merging

### Deep Nesting with Checkboxes

- [ ] Top-level task with a long description that wraps to confirm the checkbox icon stays at the top of the item rather than centering itself relative to all lines of text
  - [x] Subtask that has been completed, written with extra detail so the checked state and the strikethrough styling are both visible across multiple lines of wrapped content
  - [ ] Subtask still pending, also written long enough to wrap so we can compare the visual alignment of checked versus unchecked items at the same nesting level
    - [ ] Sub-subtask at the deepest level, long enough to wrap and confirm the fix holds even at three levels of nesting with checkbox markers
    - [x] Another sub-subtask that is done, included so we have both checked and unchecked examples at this depth for a thorough visual comparison
  - [ ] Another subtask at level two, written verbosely to wrap and complete the set of alignment test cases for this nesting structure
- [x] Another top-level task that is complete, with a long description so the strikethrough and muted text styles are visible across multiple wrapped lines

### Multi-line List Items (continuation lines)

- This is a list item with a genuinely long description that continues across several lines. It covers enough ground that even on a wide screen it should wrap at least once, giving us a real-world example of the bullet alignment fix in action without relying on artificial line breaks.
- Short item.
- Another item with continuation that also runs long enough to wrap naturally in the browser, so we can confirm the fix applies to continuation-style items the same way it applies to items written as a single long string.

### Bullets with Inline Formatting

- Item with **bold text** that also runs long enough to wrap so we can confirm the bullet aligns to the top even when the first line contains a bold span that changes the line's visual weight
- Item with *italic text* and enough surrounding prose that the line wraps and the bullet position relative to the first line is clearly observable during the manual test
- Item with `inline code` embedded partway through a longer sentence so the item wraps and we can see that the code span does not affect bullet alignment in any unexpected way
- Item with a [link to plannotator.ai](https://plannotator.ai) embedded in a longer description that wraps, confirming that anchor elements inside list items do not disrupt the top-alignment behavior
- Item with ~~strikethrough~~ text in a long enough sentence that the item wraps and the strikethrough styling is visible on the first line while the bullet stays pinned to the top
- Item with ***bold italic*** combined emphasis inside a sentence that continues long enough to wrap, giving us a combined formatting case to inspect for alignment
- **Bold label:** a longer description following the bold label, intentionally verbose so the item wraps and we can see the bold marker sit correctly at the top of the block

### Nested Bullets with Inline Formatting

- **Phase 1:** Initial setup — this phase covers installing all required runtimes, verifying the environment, and ensuring every developer on the team can reproduce the build locally without additional configuration steps
  - Install `bun` runtime by following the official installation guide; confirm the version matches the one pinned in `.tool-versions` or the project README before proceeding
  - Run `bun install` in the monorepo root to pull all workspace dependencies in a single pass; this may take a minute on a cold cache but subsequent runs will be fast
  - Verify with `bun --version` that the installed version is correct and matches CI; mismatches here have historically caused subtle build failures that are hard to diagnose
- **Phase 2:** Configuration — set all required environment variables and confirm that the local server starts cleanly before attempting any integration or end-to-end tests
  - Set `PLANNOTATOR_PORT=19432` to match the port expected by the VS Code extension and the remote tunnel configuration used in devcontainer environments
  - Export `PLANNOTATOR_REMOTE=1` when running inside a devcontainer or over SSH; without this flag the server will attempt to open a browser on the remote host which will silently fail
  - Confirm the SSH tunnel is *active* and forwarding the correct port before running any test that depends on the browser opening automatically on the local machine
- **Phase 3:** Deployment — build all targets in the correct order, verify the output, and notify the team before tagging the release so there is time to catch any last-minute issues
  - Run `bun run build` from the monorepo root, which executes the review build first and then the hook build in the correct sequence to avoid stale HTML being copied into the dist folder
  - ~~Upload to S3~~ (replaced by CDN push via GitHub Actions on merge to main; manual uploads are no longer part of the release process and should not be performed directly)
  - Notify the team via **Slack** in the `#releases` channel with the version number, a link to the changelog, and a brief summary of what changed so reviewers know what to look for
