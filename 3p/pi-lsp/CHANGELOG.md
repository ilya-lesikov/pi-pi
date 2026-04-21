# @dreki-gg/pi-lsp

## 0.1.1

### Patch Changes

- [`2a5bccb`](https://github.com/dreki-gg/pi-extensions/commit/2a5bccb2d2d663574d03e6e72bf6fcb2cdabc051) Thanks [@jalbarrang](https://github.com/jalbarrang)! - Fix stale LSP footer status so it stays in sync with detected/configured servers.

  - refresh footer status on session start from the resolved config
  - refresh footer status when running `/lsp`
  - refresh footer status after `/lsp-restart`
  - refresh footer status after `lsp` tool execution so running servers are reflected in the UI
