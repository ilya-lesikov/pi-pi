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
behavior actually executes rather than merely being accepted:

```
npx vitest run 3p/pi-subagents/test/agent-runner.test.ts -t validateCompletion
npx vitest run 3p/pi-subagents/test/agent-manager.test.ts -t first_tool
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

Other files also diverge from upstream (`src/index.ts`, `src/agent-types.ts`,
`src/cross-extension-rpc.ts`, `src/settings.ts`, `src/ui/*`) for widget/menu
wiring, extension-only mode, event-based agent registration, and RPC
normalization. Those are large and structural rather than a single hook, so the
contract test covers their observable couplings instead of enumerating lines.
