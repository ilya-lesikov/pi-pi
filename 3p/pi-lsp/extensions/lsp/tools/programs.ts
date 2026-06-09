/**
 * Effect programs backing the unified `lsp` tool.
 *
 * Each operation is an Effect that depends on the `ServerManager` service to
 * locate the right client, then wraps the client's async LSP calls in
 * `Effect.tryPromise` so transport failures surface as typed
 * `LspOperationError`s. Routing/validation failures are typed too
 * (`LspValidationError`, `NoCapableServerError`, `NoServerAvailableError`).
 */

import { Context, Effect } from 'effect';

import type { LspClient } from '../client';
import {
  LspOperationError,
  LspValidationError,
  NoCapableServerError,
  NoServerAvailableError,
  type LspExtensionError,
} from '../errors';
import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
} from '../formatting';
import type { Diagnostic } from '../types';
import {
  FILE_ONLY_OPERATIONS,
  type LspOperation,
  POSITION_OPERATIONS,
  QUERY_OPERATIONS,
} from '../types';

// ── ServerManager service ─────────────────────────────────────────────────────

export interface ServerManagerService {
  /** Get all LSP clients that handle a given file extension. */
  clientsForFile: (filePath: string) => LspClient[];
  /** Get the first LSP client that handles a file and has a capability. */
  clientForFileWithCapability: (filePath: string, capability: string) => LspClient | null;
  /** Get any initialized client (for workspace-wide ops). */
  anyClient: () => LspClient | null;
  /** Current root path. */
  getRootPath: () => string;
}

export class ServerManager extends Context.Tag('Lsp/ServerManager')<
  ServerManager,
  ServerManagerService
>() {}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
}

export interface LspToolParams {
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
}

// ── Capability map ────────────────────────────────────────────────────────────

const CAPABILITY_MAP: Record<LspOperation, string> = {
  diagnostics: 'textDocumentSync',
  hover: 'hoverProvider',
  goToDefinition: 'definitionProvider',
  findReferences: 'referencesProvider',
  goToImplementation: 'implementationProvider',
  documentSymbol: 'documentSymbolProvider',
  workspaceSymbol: 'workspaceSymbolProvider',
  prepareCallHierarchy: 'callHierarchyProvider',
  incomingCalls: 'callHierarchyProvider',
  outgoingCalls: 'callHierarchyProvider',
  codeActions: 'codeActionProvider',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function cleanPath(path: string): string {
  return path.replace(/^@/, '');
}

function toZeroIndexed(oneIndexed: number): number {
  return Math.max(0, oneIndexed - 1);
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} };
}

/** Server name for error context — tolerates partially-shaped clients. */
function serverName(client: LspClient): string {
  return client.config?.name ?? 'lsp';
}

/** Wrap an async LSP client call as a typed Effect. */
function call<A>(
  operation: string,
  server: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, LspOperationError> {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) => new LspOperationError({ operation, server, cause }),
  });
}

function validate(params: LspToolParams): Effect.Effect<void, LspValidationError> {
  const { operation, filePath, line, character, query } = params;
  const fail = (reason: string) => Effect.fail(new LspValidationError({ reason }));

  if (POSITION_OPERATIONS.includes(operation)) {
    if (!filePath) return fail(`Operation '${operation}' requires filePath`);
    if (line === undefined) return fail(`Operation '${operation}' requires line`);
    if (character === undefined) return fail(`Operation '${operation}' requires character`);
  }
  if (FILE_ONLY_OPERATIONS.includes(operation)) {
    if (!filePath) return fail(`Operation '${operation}' requires filePath`);
  }
  if (QUERY_OPERATIONS.includes(operation)) {
    if (!query) return fail(`Operation '${operation}' requires query`);
  }
  return Effect.void;
}

// ── Program ────────────────────────────────────────────────────────────────────

export function lspToolProgram(
  raw: LspToolParams,
): Effect.Effect<ToolResult, LspExtensionError, ServerManager> {
  return Effect.gen(function* () {
    yield* validate(raw);

    const mgr = yield* ServerManager;
    const operation = raw.operation;
    const filePath = raw.filePath ? cleanPath(raw.filePath) : undefined;
    const rootPath = mgr.getRootPath();

    if (operation === 'diagnostics') {
      return yield* diagnosticsProgram(mgr, filePath!);
    }

    if (operation === 'workspaceSymbol') {
      return yield* workspaceSymbolProgram(mgr, raw.query!, rootPath);
    }

    const capability = CAPABILITY_MAP[operation];
    const client = mgr.clientForFileWithCapability(filePath!, capability);
    if (!client) {
      return yield* new NoCapableServerError({ operation, filePath: filePath! });
    }

    const server = serverName(client);
    const line = raw.line!;
    const character = raw.character!;
    const pos = { line: toZeroIndexed(line), character: toZeroIndexed(character) };

    switch (operation) {
      case 'hover': {
        const result = yield* call(operation, server, () => client.hover(filePath!, pos));
        return ok(formatHover(result, filePath!, pos.line, pos.character));
      }
      case 'goToDefinition': {
        const locs = yield* call(operation, server, () => client.definition(filePath!, pos));
        return ok(
          formatLocations(locs, 'Definition', filePath!, pos.line, pos.character, rootPath),
        );
      }
      case 'findReferences': {
        const locs = yield* call(operation, server, () => client.references(filePath!, pos));
        return ok(
          formatLocations(locs, 'References', filePath!, pos.line, pos.character, rootPath),
        );
      }
      case 'goToImplementation': {
        const locs = yield* call(operation, server, () => client.implementation(filePath!, pos));
        return ok(
          formatLocations(locs, 'Implementation', filePath!, pos.line, pos.character, rootPath),
        );
      }
      case 'documentSymbol': {
        const symbols = yield* call(operation, server, () => client.documentSymbol(filePath!));
        return ok(formatDocumentSymbols(symbols, filePath!, rootPath));
      }
      case 'prepareCallHierarchy': {
        const items = yield* call(operation, server, () =>
          client.prepareCallHierarchy(filePath!, pos),
        );
        return ok(formatCallHierarchy(items, filePath!, pos.line, pos.character, rootPath));
      }
      case 'incomingCalls': {
        const items = yield* call(operation, server, () =>
          client.prepareCallHierarchy(filePath!, pos),
        );
        if (items.length === 0) {
          return ok(`No call hierarchy item at ${filePath!}:${line}:${character}`);
        }
        const calls = yield* call(operation, server, () => client.incomingCalls(items[0]));
        return ok(formatIncomingCalls(calls, items[0], rootPath));
      }
      case 'outgoingCalls': {
        const items = yield* call(operation, server, () =>
          client.prepareCallHierarchy(filePath!, pos),
        );
        if (items.length === 0) {
          return ok(`No call hierarchy item at ${filePath!}:${line}:${character}`);
        }
        const calls = yield* call(operation, server, () => client.outgoingCalls(items[0]));
        return ok(formatOutgoingCalls(calls, items[0], rootPath));
      }
      case 'codeActions': {
        const diagsForFile = yield* call(operation, server, () => client.getDiagnostics(filePath!));
        const zeroLine = toZeroIndexed(line);
        const lineDiags = diagsForFile.filter(
          (d) => d.range.start.line <= zeroLine && d.range.end.line >= zeroLine,
        );
        const range = {
          start: { line: zeroLine, character: 0 },
          end: { line: zeroLine, character: Number.MAX_SAFE_INTEGER },
        };
        const actions = yield* call(operation, server, () =>
          client.codeActions(filePath!, range, { diagnostics: lineDiags }),
        );
        return ok(formatCodeActions(actions, filePath!, zeroLine));
      }
      default:
        return yield* new LspValidationError({ reason: `Unknown operation: ${operation}` });
    }
  });
}

function diagnosticsProgram(
  mgr: ServerManagerService,
  filePath: string,
): Effect.Effect<ToolResult, never> {
  return Effect.gen(function* () {
    const groups: { source: string; diagnostics: Diagnostic[] }[] = [];
    const errors: string[] = [];

    for (const client of mgr.clientsForFile(filePath)) {
      const name = serverName(client);
      const result = yield* call('diagnostics', name, () => client.getDiagnostics(filePath)).pipe(
        Effect.either,
      );

      if (result._tag === 'Right') {
        if (result.right.length > 0) {
          groups.push({ source: name, diagnostics: result.right });
        }
      } else {
        errors.push(`${name}: ${result.left.message}`);
      }
    }

    const text = formatDiagnostics(filePath, groups);
    const errorNote = errors.length > 0 ? `\n\nNote: ${errors.join('; ')}` : '';

    return {
      content: [{ type: 'text' as const, text: text + errorNote }],
      details: {
        groups: groups.map((g) => ({ source: g.source, count: g.diagnostics.length })),
        errors,
      },
    };
  });
}

function workspaceSymbolProgram(
  mgr: ServerManagerService,
  query: string,
  rootPath: string,
): Effect.Effect<ToolResult, LspExtensionError> {
  return Effect.gen(function* () {
    const client = mgr.anyClient();
    if (!client) {
      return yield* new NoServerAvailableError({ operation: 'workspace symbol search' });
    }
    const symbols = yield* call('workspaceSymbol', serverName(client), () =>
      client.workspaceSymbol(query),
    );
    return ok(formatWorkspaceSymbols(symbols, query, rootPath));
  });
}
