# Local patches to vendored extensions

`3p/` holds vendored copies of third-party pi extensions. Some carry **local
patches** that upstream does not have. `git subtree` updates overwrite the
vendored tree wholesale, so **every update silently reverts these patches.**

`pi-subagents` used to be vendored here as well; pi-pi now runs its own workers
(`extensions/orchestrator/workers/`), so it is gone, and with it the
`pi-pi:subagent-session-scope` patches pi-lsp and pi-tasks carried. Worker
sessions load no extensions at all; what they need from these packages reaches
them through the shared handles listed below.

## After updating a subtree

Run that package's own suite from its directory (`npm run test:3p` runs all of
them), and `extensions/orchestrator/host-contract.test.ts` after a pi upgrade.
Patched regions are marked `LOCAL PATCH (pi-pi)` in the vendored source. Keep
that marker on anything you add, and list it here.

## Current local patches

| Extension | What | Where |
|---|---|---|
| pi-lsp | Server detection looks commands up with `where` on win32 and `which` elsewhere, through `execFileSync` argv rather than a shell string, and keeps the resolved path on `ResolvedServerConfig`. cmd.exe has no `which`, so every built-in failed detection on native Windows and no language server was ever registered | `extensions/lsp/config.ts` (`resolveCommandPath`, `resolveServer`), `extensions/lsp/types.ts` (`ResolvedServerConfig.resolvedPath`), guarded by `test/config.which.local.test.ts` |
| pi-lsp | `inspectBuiltinServers` reports every built-in with its detection verdict, so the doctor can name a language whose server is missing and the binary it wanted instead of silently omitting it | `extensions/lsp/config.ts`, guarded by `test/config.which.local.test.ts` |
| pi-tasks | Reminder cadence is driven by observed work (edits, commits) since the last task *mutation* rather than by turns since any task-tool call, never latches after an ignored reminder, escalates instead of repeating, and fires on sustained work with an empty task list. The original fired at most once per session, treated a read-only `TaskList` as maintenance, and was structurally silent when no task had ever been created | `src/reminder-cadence.ts` (whole module), `src/index.ts` (`MUTATING_TASK_TOOLS`, `READ_ONLY_TASK_TOOLS`, `EDITING_TOOLS`, `isCommitCall`, `renderReminder`, `tool_result`/`context` hooks), guarded by `test/reminder-cadence.test.ts` |
| pi-lsp | `describe()` on the shared API handle reports root path, each server's resolved binary, command line, extensions and running state, optionally spawning each one to prove it runs rather than merely resolves, plus the built-ins that matched nothing. `status` formats prose for a notification, which the doctor cannot judge an install from | `extensions/lsp/index.ts`, consumed by `extensions/orchestrator/doctor.ts` |
| pi-lsp | `LspClient.recentStderr()` exposes the tail of the server's stderr. A server that dies on spawn explains itself there and nowhere else — a rustup proxy's "Unknown binary" reached the user as "Server process exited" | `extensions/lsp/client.ts` |
| pi-tasks | The reminder names the drift it observed — which task is still `in_progress`, how many edits and commits have happened since task state last changed — instead of asking the agent to consider whether tracking might be useful | `src/index.ts` (`renderReminder`) |
| pi-tasks | The task widget keeps to a share of the terminal's rows — a callback widget is composited whole, so an unbounded one (`showAll` too) scrolls the editor and footer out of the area pi-tui renders differentially against | `src/ui/task-widget.ts` (`rowBudget`), guarded by `test/task-widget.test.ts` "share of a short terminal" |
| pi-tasks | `clearAll` on the global store API | `src/index.ts` (store API) |
| pi-tasks | `TaskExecute`/`TaskOutput`/`TaskStop` run task agents on pi-pi's workers through the typed `pi-pi:workers` handle (spawn, stop, settlement listener) instead of the pi-subagents event-bus RPC; the `model` parameter is gone because each agent type pins its own model | `src/index.ts` (`workers`, `spawnSubagent`, `stopSubagent`, `listenForSettlements`), guarded by `test/subagent-integration.test.ts` |
| pi-ask-user | `questions` sequences show a `Question N/M` title and can be walked with alt+←/alt+→ (`AskNavigate` sentinel from the UI layer, index-driven loop in `execute`, revisited answers preselected — cursor row for single-select, ticked rows for multi — and overwritten in place) | `index.ts` (`AskNavigate`/`isNavigate`, `NAV_PREV_KEY`/`NAV_NEXT_KEY`, `previousAnswerIndex`/`previousCheckedIndices`, `MultiSelectList` `checked` argument, `AskComponent` title/help/`handleInput`, `askUser` `navigation`/`checkedIndices` options, `execute` multi-question loop), guarded by `index.test.ts` "multi-question navigation (local patch)" |
| pi-lsp | `registerTool(pi)` on the shared API handle registers the `lsp` tool on another session bound to this one's server manager — pi-pi's worker sessions load no extensions, and their own language servers would leak since nothing would shut them down | `extensions/lsp/index.ts` (API handle), guarded by `test/index.local.test.ts` |
