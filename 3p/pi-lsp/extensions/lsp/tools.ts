/**
 * Single unified `lsp` tool registration.
 *
 * 11 operations routed to the right server by file extension. The execution
 * logic lives in `tools/programs.ts` as Effect programs; this module owns the
 * tool schema/description and runs the program with the live `ServerManager`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';

import { toNativeError } from './errors';
import {
  lspToolProgram,
  ServerManager,
  type LspToolParams,
  type ServerManagerService,
} from './tools/programs';
import { LSP_OPERATIONS, type LspOperation } from './types';

export type { ServerManagerService } from './tools/programs';
export { ServerManager } from './tools/programs';

// ── Registration ────────────────────────────────────────────────────────────

export function registerLspTool(pi: ExtensionAPI, mgr: ServerManagerService) {
  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description: [
      'Interact with Language Server Protocol servers for code intelligence.',
      '',
      'Supported operations:',
      '  goToDefinition    — find where a symbol is defined',
      '  findReferences    — find all references to a symbol',
      '  hover             — get type info and documentation for a symbol',
      '  diagnostics       — get type errors and lint warnings for a file',
      '  documentSymbol    — get all symbols in a file (with line:column positions)',
      '  workspaceSymbol   — search for symbols across the workspace',
      '  goToImplementation — find implementations of an interface/abstract method',
      '  prepareCallHierarchy — get call hierarchy item at a position',
      '  incomingCalls     — find callers of a function/method (auto-prepares hierarchy)',
      '  outgoingCalls     — find callees of a function/method (auto-prepares hierarchy)',
      '  codeActions       — get quick fixes and refactoring suggestions',
      '',
      'Parameters:',
      '  operation (required) — one of the operations above',
      '  filePath  — file path relative to project root (required for most operations)',
      '  line      — line number, 1-indexed (required for position-based operations)',
      '  character — column number, 1-indexed (required for position-based operations)',
      '  query     — search string (required for workspaceSymbol)',
      '',
      'Tips:',
      '  — Position the character in the middle of the symbol name for best results.',
      '  — Use hover before goToDefinition to quickly check signatures and docs.',
      '  — workspaceSymbol may need a retry if the server is still indexing.',
    ].join('\n'),
    promptSnippet:
      'Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions',
    promptGuidelines: [
      'lsp line and character params are 1-indexed — use the values from the read tool or rg output directly.',
      'lsp `hover` is the fastest way to get a function signature, type params, and doc comment — prefer it over `goToDefinition` for quick type inspection.',
      'lsp `documentSymbol` returns line:column positions for each symbol — use those values directly for follow-up lsp operations.',
      'For lsp position-based operations, place the character in the **middle** of the symbol name, not at the first character.',
      'lsp `incomingCalls` and `outgoingCalls` automatically prepare the call hierarchy — no need to call `prepareCallHierarchy` first.',
      'lsp `workspaceSymbol` may return empty results while the LSP server is still indexing. If it returns nothing, wait a few seconds and retry.',
      'lsp `diagnostics` relies on server-pushed notifications which may be slow for some servers. For compiled languages (Rust, Go, C++), prefer running the compiler directly (e.g. `cargo check`, `go build`) for reliable error checking.',
      'Use lsp for type info, macro-generated symbols, and cross-module navigation. Use rg for simple text search and file discovery — it is faster and needs no server.',
      'lsp servers are auto-detected by file extension. Use /lsp to check status.',
    ],
    parameters: Type.Object({
      operation: StringEnum(LSP_OPERATIONS),
      filePath: Type.Optional(Type.String({ description: 'File path relative to project root' })),
      line: Type.Optional(Type.Number({ description: 'Line number (1-indexed)' })),
      character: Type.Optional(Type.Number({ description: 'Column number (1-indexed)' })),
      query: Type.Optional(Type.String({ description: 'Search query (for workspaceSymbol)' })),
    }),
    async execute(_toolCallId, params) {
      const program = lspToolProgram(params as LspToolParams);
      return Effect.runPromise(
        program.pipe(Effect.provideService(ServerManager, mgr), Effect.mapError(toNativeError)),
      );
    },
  });
}

export type { LspOperation };
