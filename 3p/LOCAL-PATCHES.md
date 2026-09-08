# Local patches to vendored extensions

`3p/` holds vendored copies of third-party pi extensions. Some carry **local
patches** that upstream does not have. `git subtree` updates overwrite the
vendored tree wholesale, so **every update silently reverts these patches.**

Silently is the operative word. The orchestrator couples to `3p/pi-subagents`
entirely at runtime — events on a shared bus, and spawn options forwarded across
an `options?: any` RPC boundary. A reverted patch therefore produces no type
error, no runtime error, and no log line. It just stops working.

This has already happened twice, undetected for months each time. The v0.13.0
update (`5e1f882`) reverted:

- **`validateCompletion`** (added in `0f029ef`) — the post-run hook that
  re-prompts a planner/reviewer that finished without writing a valid output
  file. All four callsites kept passing the callback into a manager that no
  longer read it, so reviewers that wrote only a `REVIEW_STATUS: INCOMPLETE`
  stub were recorded as completed and never retried. Restored in `cfd6f35`.
- **`first_tool` / `first_turn` emission** (added in `db7b21f`) — moved into
  `AgentManager.startAgent` so every spawn path reports first progress, RPC
  reviewer panels included. `event-handlers.ts` kept subscribing to events
  nothing emitted, losing the signal that distinguishes a reviewer that actually
  investigated from one that wrote from context alone. Restored in `11eca17`.

Two other commits (`e0cdffd`, `db88556`) exist purely to repair widget, menu,
and agent-registration wiring the same update clobbered.

## After updating a subtree

Run the contract test first — it machine-checks the couplings that types cannot:

```
npx vitest run extensions/orchestrator/vendored-contract.test.ts
```

It fails, naming the specific event or option, when the vendored code stops
emitting a `subagents:*` event the orchestrator subscribes to, stops handling an
RPC the orchestrator sends, stops reading a forwarded spawn option, or drops a
manager-handle method. Then run the guard tests that assert the patched
behavior actually executes rather than merely being accepted. These must run
from the package directory so they pick up its own vitest config — it dedupes
`@earendil-works/pi-ai`, and the root config does not (that is what `npm run
test:3p` does, and why root `npm test` excludes `3p/**`):

```
cd 3p/pi-subagents
npx vitest run test/agent-runner.test.ts -t validateCompletion
npx vitest run test/agent-runner.test.ts -t "compaction resume"
npx vitest run test/agent-manager.test.ts -t first_tool
```

To review every local divergence from pristine upstream, diff against the
upstream side of the subtree merge (`git log --merges -- 3p/pi-subagents/`
finds it; for v0.13.0 it is `3e55067`):

```
git diff 3e55067:src HEAD:3p/pi-subagents/src
```

Patched regions are marked `LOCAL PATCH (pi-pi)` in the vendored source. Keep
that marker on anything you add, and list it here.

## Current local patches

| Extension | What | Where |
|---|---|---|
| pi-subagents | `validateCompletion` / `maxValidationRetries` — re-prompt an agent that finished without a valid output file | `src/agent-runner.ts` (`RunOptions`, `runAgent`), `src/agent-manager.ts` (`SpawnOptions`, `startAgent`) |
| pi-subagents | `first_tool` / `first_turn` emitted at the manager choke point so all spawn paths report first progress | `src/agent-manager.ts` (`startAgent`), `src/types.ts` (`AgentRecord`) |
| pi-subagents | `graceTurns` default raised 5 → 10 so a reviewer that trips the soft turn limit still has room to write its output file | `src/agent-runner.ts` (`graceTurns`) |
| pi-subagents | Guard the `onStart`/`onComplete` side-effect callbacks and restore the concurrency slot when a queued start throws, so one failing callback cannot wedge the background queue or reject an unawaited run promise | `src/agent-manager.ts` (`startAgent`, `drainQueue`) |
| pi-subagents | Opens the `pi-pi:subagent-session-scope` async scope around a subagent's extension load, so pi-pi's extensions can tell an in-process subagent session apart from a root session the host re-instantiated on /new, /resume or fork | `src/agent-runner.ts` (`subagentSessionScope`, `runAgent`) |
| pi-subagents | Waits out a compaction started from an extension and re-prompts the run it aborted, so a worker compacted mid tool loop finishes its task instead of answering with the narration it had streamed before the cut | `src/agent-runner.ts` (`watchCompactionCuts`, `promptWithEmptyRetry`), guarded by `test/agent-runner.test.ts` "compaction resume" |
| pi-subagents | Finished agents linger in the widget by wall time (1 h) instead of one main-session turn, the record retention window matches it (1 h, capped at 20 finished records so retained sessions cannot pile up), and the repaint timer idles to 1 s when nothing is running | `src/ui/agent-widget.ts` (`shouldShowFinished`, `ensureTimer`, `update`), `src/agent-manager.ts` (`cleanup`, `MAX_RETAINED_FINISHED`) |
| pi-subagents | `subagents:created` carries the spawning `toolCallId`, so a subscriber can correlate a worker with the turn that spawned it | `src/index.ts` (background Agent-tool spawn) |
| pi-subagents | The conversation viewer is full-screen (100% width/height, no margin) and the agents widget is parked while it is open — pi-tui composites overlays into the same line buffer it diffs, so a partial-height overlay tears whenever the content behind it changes | `src/index.ts` (`viewAgentConversation`), `src/ui/conversation-viewer.ts` (`VIEWPORT_HEIGHT_PCT`), `src/ui/agent-widget.ts` (`suspend`, `resume`) |
| pi-subagents | The completion notification renders a failed agent's error text instead of the "No output." placeholder — a failure's reason was otherwise reachable only through `get_subagent_result` | `src/index.ts` (`subagent-notification` renderer), guarded by `test/notification-error-rendering.test.ts` |
| pi-tasks | `clearAll` on the global store API; skip lifecycle hooks and shared-handle publication in in-process subagent sessions, snapshotting the `pi-pi:subagent-session-scope` scope at factory time | `src/index.ts` (`isSubagentSession`, store API) |
| pi-vcc | `scope:` parsing (`src/core/recall-scope.ts`), the `source: root\|current` parameter and `RecallSessionSource` on the recall tool, and a trimmed re-export surface — pi-pi consumes the engine as a library, not as an extension | `index.ts`, `src/core/recall-scope.ts`, `src/tools/recall.ts` |
| pi-lsp | Skip session/tool hooks and shared-handle publication in in-process subagent sessions, snapshotting the `pi-pi:subagent-session-scope` scope at factory time (reading it per event would also silence the root session, which never runs inside the scope). A subagent's `lsp` tool borrows the root session's server manager, since nothing disposes a subagent session and its own language servers would leak | `extensions/lsp/index.ts` (`isSubagentSession`, `rootServerManager`) |

Other files also diverge from upstream (`src/index.ts`, `src/agent-types.ts`,
`src/cross-extension-rpc.ts`, `src/settings.ts`, `src/ui/*`) for widget/menu
wiring, extension-only mode, event-based agent registration, and RPC
normalization. Those are large and structural rather than a single hook, so the
contract test covers their observable couplings instead of enumerating lines.
