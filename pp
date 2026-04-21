#!/bin/sh
exec pi --no-extensions \
  -e ./extensions/orchestrator \
  -e ./3p/pi-subagents/src/index.ts \
  -e ./3p/pi-tasks/src/index.ts \
  -e ./3p/pi-lsp/extensions/lsp \
  -e ./3p/pi-ask-user \
  -e ./3p/pi-mcp-adapter \
  -e ./3p/pi-plannotator/apps/pi-extension \
  -e ./3p/pi-hashline-readmap \
  "$@"
