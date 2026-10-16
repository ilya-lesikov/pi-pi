# Local patches to vendored extensions

`3p/` holds vendored copies of third-party pi extensions. Some carry **local
patches** that upstream does not have. `git subtree` updates overwrite the
vendored tree wholesale, so **every update silently reverts these patches.**

`pi-subagents`, `pi-tasks` and `pi-ask-user` used to be vendored here as well;
pi-pi now runs its own workers (`extensions/orchestrator/workers/`), task tools
(`extensions/orchestrator/tasks/`) and `ask_user` (`extensions/orchestrator/ask/`),
so all three are gone, and with them the
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
| pi-lsp | `describe()` on the shared API handle reports root path, each server's resolved binary, command line, extensions and running state, optionally spawning each one to prove it runs rather than merely resolves, plus the built-ins that matched nothing. `status` formats prose for a notification, which the doctor cannot judge an install from | `extensions/lsp/index.ts`, consumed by `extensions/orchestrator/doctor.ts` |
| pi-lsp | `LspClient.recentStderr()` exposes the tail of the server's stderr. A server that dies on spawn explains itself there and nowhere else — a rustup proxy's "Unknown binary" reached the user as "Server process exited" | `extensions/lsp/client.ts` |
| pi-lsp | `registerTool(pi)` on the shared API handle registers the `lsp` tool on another session bound to this one's server manager — pi-pi's worker sessions load no extensions, and their own language servers would leak since nothing would shut them down | `extensions/lsp/index.ts` (API handle), guarded by `test/index.local.test.ts` |
